import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-module-import-tools-')
const { registerModuleImportTools } = await import('../../src/runtime/module-import-tools.ts')
const { enabledModuleIds } = await import('../../src/host/config-store.ts')
const { createAgentAssembly } = await import('../../src/runtime/agent-assembly.ts')
const rule = { id: 'body', then: [{ id: 'text', kind: 'inject-text', config: { text: 'BODY' } }] }
let calls = 0
async function setup(t, rebuild = async () => {}) {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  const id = `controller-${++calls}`, dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'module.yml'), JSON.stringify({ id, modules: [] }))
  const agent = { id, options: {}, session: { id, header: {}, snapshotEvents: () => [] } }
  agent.ctx = createScope(root, agent).ctx
  root.provide('llm', {})
  root.provide('agents', { list: () => [agent] })
  const enabled = []
  const runtime = createAgentAssembly(root, { moduleRoot, enabledModules: () => enabled })
  const dispose = registerModuleImportTools(agent.ctx, { root: moduleRoot, rebuild: async id => { await rebuild(id); await runtime.refresh(id) } })
  await new Promise(resolve => setImmediate(resolve))
  t.after(async () => { dispose(); await runtime.dispose(); await root.fiber.dispose() })
  const call = (args, signal = new AbortController().signal) => root.tools.execute({ callId: `call-${++calls}`, name: 'module_import', arguments: args, agent, signal })
  const success = async args => { const result = await call(args); assert.equal(result.isError, false, JSON.stringify(result)); return result.value }
  const injected = async () => (await root.waterfall(scopeTarget(agent, agent), 'agent/pre-step', { agent, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'USER' }] }] }))).messages.flatMap(message => message.content.map(block => block.text))
  return { call, success, enabled, runtime, injected }
}

test('模块导入工具预览提交四种来源，保留空变量占位且不自动启用', async t => {
  let publicationFails = false
  const f = await setup(t, async () => { if (publicationFails) throw new Error('publication failed') })
  const cases = [
    ['native', { id: 'native', name: 'Native', modules: [], variables: { empty: '' }, rules: [rule] }],
    ['preset', { prompts: [{ identifier: 'body', role: 'system', content: 'PRESET {{empty}}' }] }],
    ['character', { name: 'Character', description: 'CHARACTER {{empty}}' }],
    ['world', { entries: [{ uid: 1, key: ['{{empty}}'], content: 'LORE', disable: false }] }],
  ]
  for (const [id, body] of cases) {
    const files = [{ path: `${id}.json`, content: JSON.stringify(body) }]
    const preview = await f.success({ files })
    assert.equal(preview.state, 'ready')
    const saved = await f.success({ files, preview: false, expectedSourceDigest: preview.sourceDigest, expectedPreviewRevision: preview.previewRevision })
    assert.equal(saved.id, preview.summary.targetId)
    const module = parse(readFileSync(join(moduleRoot, saved.id, 'module.yml'), 'utf8'))
    assert.equal(module.variables.empty, '')
    assert.ok(module.rules.length > 0)
    assert.ok(!enabledModuleIds(moduleRoot).includes(saved.id))
  }
  f.enabled.push('native')
  await f.runtime.refresh()
  assert.deepEqual(await f.injected(), ['USER', 'BODY'])
  const replace = async text => {
    const files = [{ path: 'module.yml', content: JSON.stringify({ id: 'native', name: 'Native', modules: [], variables: { empty: '' }, rules: [{ ...rule, then: [{ ...rule.then[0], config: { text } }] }] }) }]
    const options = { files, targetId: 'native', overwrite: true }
    const preview = await f.success(options)
    return f.success({ ...options, preview: false, expectedSourceDigest: preview.sourceDigest, expectedPreviewRevision: preview.previewRevision })
  }
  assert.equal((await replace('NEW')).publicationPending, false)
  assert.deepEqual(await f.injected(), ['USER', 'NEW'], '覆盖已启用模块后下一次真实注入使用新正文')
  publicationFails = true
  const pending = await replace('SAVED')
  assert.equal(pending.persisted, true)
  assert.equal(pending.publicationPending, true)
  assert.equal(parse(readFileSync(join(moduleRoot, 'native/module.yml'), 'utf8')).rules[0].then[0].config.text, 'SAVED')
  assert.deepEqual(await f.injected(), ['USER', 'NEW'], '发布失败保留旧贡献，不能假报导入未保存')
})

test('模块导入工具拒绝陈旧预览、越界资源和取消，既有模块字节不变', async t => {
  const f = await setup(t)
  const files = [{ path: 'reject.json', content: JSON.stringify({ id: 'reject', name: 'Reject', modules: [], rules: [rule] }) }]
  const unknown = await f.call({ files, extra: true })
  assert.equal(unknown.isError, true, '工具拒绝未知字段')
  const sourceId = await f.call({ sourceId: '00000000-0000-0000-0000-000000000000', preview: true })
  assert.equal(sourceId.isError, true, '工具没有上传来源存储，不接受 sourceId')
  const preview = await f.success({ files })
  const before = readdirSync(moduleRoot).sort()
  assert.equal((await f.call({ files, preview: false, expectedSourceDigest: preview.sourceDigest, expectedPreviewRevision: '0'.repeat(64) })).isError, true)
  assert.equal((await f.call({ files: [{ path: '../outside.yml', content: files[0].content }] })).isError, true)
  const controller = new AbortController(); controller.abort()
  assert.equal((await f.call({ files, preview: false, expectedSourceDigest: preview.sourceDigest, expectedPreviewRevision: preview.previewRevision }, controller.signal)).isError, true)
  assert.deepEqual(readdirSync(moduleRoot).sort(), before)
})

test('模块导入工具把顺序歧义返回为候选，选择后重新预览并安装指定正文', async t => {
  const f = await setup(t)
  const files = [{ path: 'orders.json', content: JSON.stringify({ prompts: [
    { identifier: 'a', content: 'A', role: 'system' }, { identifier: 'b', content: 'B', role: 'system' },
  ], prompt_order: [
    { character_id: 10, order: [{ identifier: 'a', enabled: true }] },
    { character_id: 20, order: [{ identifier: 'b', enabled: true }] },
  ] }) }]
  const choices = await f.success({ files })
  assert.equal(choices.state, 'needs-order-selection')
  assert.deepEqual(choices.candidates.map(item => item.characterId), ['10', '20'])
  const preview = await f.success({ files, promptOrderCharacterId: '20' })
  const saved = await f.success({ files, promptOrderCharacterId: '20', preview: false, expectedSourceDigest: preview.sourceDigest, expectedPreviewRevision: preview.previewRevision })
  const module = parse(readFileSync(join(moduleRoot, saved.id, 'module.yml'), 'utf8'))
  assert.deepEqual(module.rules.filter(item => item.enabled !== false).map(item => item.then[0].config.text), ['B'])
})

test('导入工具与装配记录解耦：没有启用模块时显式目标的导入照常落盘', async t => {
  const f = await setup(t)
  assert.deepEqual(f.enabled, [], '这个 Agent 没有任何装配记录（导入不借既有模块当主语）')
  const files = [{ path: 'plain.json', content: JSON.stringify({ id: 'plain', name: 'Plain', modules: [], rules: [rule] }) }]
  const preview = await f.success({ files })
  assert.equal(preview.state, 'ready')
  const saved = await f.success({ files, preview: false, expectedSourceDigest: preview.sourceDigest, expectedPreviewRevision: preview.previewRevision })
  assert.equal(saved.persisted, true)
  assert.equal(parse(readFileSync(join(moduleRoot, saved.id, 'module.yml'), 'utf8')).rules.length, 1, '正文真的落盘')
})
