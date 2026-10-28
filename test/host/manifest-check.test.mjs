import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { isolatedHome } from '../fixtures/host-harness.mjs'
import { createManifestCheckReader } from '../../src/host/module-manifest-check.ts'
import { runModuleManifest } from '../../src/host/module-manifest.ts'

const { moduleRoot } = isolatedHome('pt-manifest-check-')
const { apply } = await import('../../src/index.ts')
const { setModuleEnabled } = await import('../../src/host/config-store.ts')

function fixture(id) {
  const dir = join(moduleRoot, id)
  mkdirSync(join(dir, 'assets'), { recursive: true })
  mkdirSync(join(dir, 'data'), { recursive: true })
  writeFileSync(join(dir, 'module.yml'), `id: ${id}\nmodules: []\nrules: []\n`)
  writeFileSync(join(dir, 'assets', 'manifest.yml'), 'checks:\n  - path: data/x.jsonl\n    kind: jsonl\n    maxBytes: 1024\n')
  return dir
}

test('清单规则事实缓存 1000ms，命中不续期，显式检查始终实时', (t) => {
  const dir = fixture('facts')
  const file = join(dir, 'data', 'x.jsonl')
  let now = 0
  t.mock.method(performance, 'now', () => now)
  writeFileSync(file, '{"a":1}\n')
  const reader = createManifestCheckReader(moduleRoot)
  assert.equal(reader.read('facts'), true)
  now = 100
  appendFileSync(file, 'not json\n')
  assert.equal(runModuleManifest(dir, 'check').ok, false, '显式检查立即看到坏行')
  assert.equal(reader.read('facts'), true, '账本追加与显式检查均不绕过规则缓存')
  now = 999
  assert.equal(reader.read('facts'), true, '到期前沿用原结论')
  now = 1000
  assert.equal(reader.read('facts'), false, '中途命中不续期，到期首次读取重新检查')
  now = 1100
  writeFileSync(file, '{"a":1}\n')
  assert.equal(runModuleManifest(dir, 'check').ok, true, '显式检查立即看到修复')
  assert.equal(reader.read('facts'), false, '检查失败也缓存，修复不提前更新规则事实')
  now = 1999
  assert.equal(reader.read('facts'), false)
  now = 2000
  assert.equal(reader.read('facts'), true, '下次到期恢复通过')
})

test('坏清单的不可用事实也缓存，到期或配置戳变化后恢复', (t) => {
  const dir = fixture('broken-manifest')
  const manifest = join(dir, 'assets', 'manifest.yml')
  let now = 0
  t.mock.method(performance, 'now', () => now)
  writeFileSync(manifest, 'checks: [ ')
  utimesSync(manifest, 1, 1)
  const stamp = statSync(manifest)
  const reader = createManifestCheckReader(moduleRoot)
  assert.equal(reader.read('broken-manifest'), undefined, '坏 YAML 是不可用，不是检查失败')
  now = 100
  writeFileSync(manifest, 'checks: []')
  utimesSync(manifest, stamp.atime, stamp.mtime)
  assert.equal(statSync(manifest).mtimeMs, stamp.mtimeMs)
  assert.equal(statSync(manifest).size, stamp.size)
  assert.equal(runModuleManifest(dir, 'check').ok, true)
  now = 999
  assert.equal(reader.read('broken-manifest'), undefined, '同戳修复不能绕过不可用结果的期限')
  now = 1000
  assert.equal(reader.read('broken-manifest'), true, '到期重读后恢复')
  now = 1100
  writeFileSync(manifest, 'checks: [')
  assert.equal(reader.read('broken-manifest'), undefined, '配置大小变化立即重检')
  now = 1200
  writeFileSync(manifest, 'checks: []\n')
  assert.equal(reader.read('broken-manifest'), true, '配置戳变化可以提前恢复不可用结果')
})

test('同戳等长清单到期重读，清单缺失立即不可用并清掉缓存', (t) => {
  const dir = fixture('manifest-change')
  const manifest = join(dir, 'assets', 'manifest.yml')
  const file = join(dir, 'data', 'x.jsonl')
  let now = 0
  t.mock.method(performance, 'now', () => now)
  writeFileSync(file, 'not json\n')
  utimesSync(manifest, 1, 1)
  const stamp = statSync(manifest)
  const reader = createManifestCheckReader(moduleRoot)
  assert.equal(reader.read('manifest-change'), false)
  now = 100
  writeFileSync(manifest, 'checks:\n  - path: data/x.jsonl\n    kind: text \n    maxBytes: 1024\n')
  utimesSync(manifest, stamp.atime, stamp.mtime)
  assert.equal(statSync(manifest).mtimeMs, stamp.mtimeMs)
  assert.equal(statSync(manifest).size, stamp.size)
  now = 999
  assert.equal(reader.read('manifest-change'), false, '同戳等长配置在到期前保持旧结论')
  now = 1000
  assert.equal(reader.read('manifest-change'), true, '到期必须重读清单，不能复用旧解析结果')
  now = 1001
  rmSync(manifest)
  assert.equal(reader.read('manifest-change'), undefined, '清单缺失立即不可用')
  rmSync(file)
  writeFileSync(manifest, 'checks:\n  - path: data/x.jsonl\n    kind: jsonl\n    maxBytes: 1024\n')
  utimesSync(manifest, stamp.atime, stamp.mtime)
  assert.equal(reader.read('manifest-change'), false, '缺失已清缓存，同戳重建也须立即发现检查文件缺失')
  assert.equal(reader.read('missing'), undefined, '模块目录不存在也是不可用')
})

test('实际插件接线：主子 Agent 自检注入遵守 TTL，压缩与重挂无重复，释放保留官方服务', async (t) => {
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const id = 'live-manifest', unknownId = 'live-manifest-unknown'
  const dir = fixture(id), unknownDir = fixture(unknownId)
  const file = join(dir, 'data', 'x.jsonl')
  writeFileSync(file, 'not json\n')
  writeFileSync(join(unknownDir, 'assets', 'manifest.yml'), 'checks: [')
  const rule = (audience, condition, text) => ({
    id: audience, layer: 'system-section',
    if: { all: [{ scope: { audience } }, condition] },
    then: [{ id: 'warning', kind: 'inject-text', config: {
      id: audience, layer: 'system-section', order: 177, text,
    } }],
  })
  writeFileSync(join(dir, 'module.yml'), JSON.stringify({ id, modules: ['rule-engine', 'module-manifest-tools'], rules: [
    rule('main', { manifest: { ok: false } }, 'FAILED MAIN'),
    rule('subagent', { manifest: { ok: false } }, 'FAILED CHILD'),
  ] }))
  writeFileSync(join(unknownDir, 'module.yml'), JSON.stringify({ id: unknownId, modules: ['rule-engine'], rules: [
    rule('main', { not: { manifest: { ok: true } } }, 'UNKNOWN MAIN'),
    rule('subagent', { not: { manifest: { ok: true } } }, 'UNKNOWN CHILD'),
  ] }))
  setModuleEnabled(moduleRoot, id, true)
  setModuleEnabled(moduleRoot, unknownId, true)

  const root = new Context()
  t.after(() => root.fiber.dispose())
  const warnings = []
  root.logger.exporter({ export(message) {
    if (message.type === 'warn' || message.type === 'error') warnings.push(message.args.map(String).join(' '))
  } })
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  root.provide('llm', {})
  root.provide('subagents', {})
  root.provide('commands', { register: () => () => {} })
  root.provide('skills', { registerProvider: factory => {
    factory({ invalidate() {}, signal: new AbortController().signal })
    return () => {}
  } })
  root.provide('webServer', { register: () => () => {} })
  const agents = []
  root.provide('agents', { list: () => agents })
  root.systemPrompt.section({ name: 'test:official', order: 0, text: 'OFFICIAL' })
  const mount = () => root.plugin({
    name: 'test:prompt-tool', inject: ['skills', 'commands', 'llm', 'subagents'],
    apply: ctx => apply(ctx, { modulesEnabled: { get: () => true } }),
  })
  let plugin = mount()
  await plugin
  const readers = new Map()
  for (const [agentId, depth] of [['manifest-main', 0], ['manifest-child', 1]]) {
    const events = []
    const agent = { id: agentId, options: {}, session: {
      id: agentId, header: { delegationDepth: depth }, snapshotEvents: () => events,
    } }
    agent.ctx = createScope(root, agent).ctx
    agents.push(agent)
    await root.serial(scopeTarget(agent, agent), 'agent/created', { agent, source: 'startup' })
    await agent.ctx.plugin({ inject: ['systemPrompt'], apply(ctx) {
      readers.set(agent, () => ctx.systemPrompt.assemble({ agent, scope: agent }))
    } })
  }
  const expectFailed = async expected => {
    for (const [index, agent] of agents.entries()) {
      const assembly = await readers.get(agent)()
      const texts = assembly.sections.map(section => section.text)
      assert.deepEqual(texts.filter(text => /^(FAILED|UNKNOWN) /.test(text)), expected ? [index === 0 ? 'FAILED MAIN' : 'FAILED CHILD'] : [])
      assert.ok(texts.includes('OFFICIAL'), '官方 section 在插件生命周期之外存活')
      assert.ok(!assembly.contexts.some(context => /^(FAILED|UNKNOWN) /.test(context.text)), '自检只进入 system-section')
      if (expected) {
        const warning = assembly.sections.find(section => section.text.startsWith('FAILED '))
        assert.ok(warning.name.includes(':live-manifest:'), '贡献保留真实来源 moduleId')
        assert.ok(texts.indexOf('OFFICIAL') < texts.indexOf(warning.text), '遵守声明的 system-section 顺序')
      }
    }
  }
  let calls = 0
  const check = async expected => {
    const result = await root.tools.execute({ callId: 'manifest-' + ++calls, name: 'module_manifest',
      arguments: { moduleId: id, action: 'check' }, agent: agents[0], signal: new AbortController().signal })
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal(result.value.ok, expected)
  }

  await expectFailed(true)
  await expectFailed(true)
  now = 100
  writeFileSync(file, '{"a":1}\n')
  await check(true)
  await expectFailed(true)
  now = 999
  await expectFailed(true)
  now = 1000
  await expectFailed(false)
  now = 1100
  appendFileSync(file, 'not json\n')
  await check(false)
  await expectFailed(false)
  now = 1999
  await expectFailed(false)
  now = 2000
  await expectFailed(true)
  now = 2100
  writeFileSync(file, '{"a":1}\n')
  for (const agent of agents) {
    const events = agent.session.snapshotEvents()
    const event = { seq: events.length + 1, type: 'compaction/end', data: {} }
    events.push(event)
    root.emit(scopeTarget(agent.session, agent), 'session/event', agent.session, event)
  }
  await expectFailed(true)
  now = 3000
  await expectFailed(false)
  now = 3100
  appendFileSync(file, 'not json\n')
  await expectFailed(false)
  await plugin.dispose()
  await expectFailed(false)
  assert.ok(root.get('systemPrompt') && root.get('tools'), '释放插件不释放官方服务')
  assert.equal(root.tools.get('module_manifest', agents[0]), undefined, '释放插件撤回其工具')
  plugin = mount()
  await plugin
  for (const agent of agents) await root.serial(scopeTarget(agent, agent), 'agent/created', { agent, source: 'startup' })
  await expectFailed(true)
  await expectFailed(true)
  await plugin.dispose()
  await expectFailed(false)
  assert.deepEqual(warnings, [], '真实插件生命周期没有隐藏的装配错误')
})
