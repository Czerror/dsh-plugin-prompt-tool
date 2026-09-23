/**
 * B7 T1 —— `engine/declared-triggers.mjs`（声明链路的运行时终点）的契约。
 *
 * 它是「预设写声明 → 引擎挂触发器」的**唯一载体**，B7 的六个能力重建全靠它，此前
 * 没有任何行为测试（既有匹配只有 provider-boundary 的"提供者不得声明触发器"与
 * preset-engine-managed-paths 的受管字段名单）。三件事必须钉死：
 *
 *   1. 文件缺失 = **没有声明，不是错误**（引擎不带默认，2026-09-22 拍板）；
 *   2. 文件在但内容非法 = **fail loud**（保存期已校验一次，这里是第二道防线）；
 *   3. 正常链路真的把动作注册到了**声明的通道**上，且 `when` 前置生效——不是
 *      "读到了就完事"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply, configContract, inject, name } from '../../engine/declared-triggers.mjs'
import { compileDeclarations, mountDeclarations } from '../../engine/trigger-spec.mjs'

/** 独立临时目录，结束即清理（不依赖共享状态或执行顺序）。 */
const dir = mkdtempSync(join(tmpdir(), 'declared-triggers-'))
test.after(() => rmSync(dir, { recursive: true, force: true }))

let seq = 0
/** 把一段 YAML 写成声明文件，返回其绝对路径（源码 :40 明言绝对路径忽略 base）。 */
function specFile(text) {
  const file = join(dir, `triggers-${(seq += 1)}.yml`)
  writeFileSync(file, text, 'utf8')
  return file
}

/** 最小记录型 ctx：本文件只断言"注册/释放了什么"，不重演完整 cordis。 */
function recordingCtx() {
  const events = []
  const effects = []
  return {
    events,
    effects,
    ctx: {
      on(event, handler, options) {
        const entry = { event, handler, options }
        events.push(entry)
        return () => {
          const index = events.indexOf(entry)
          if (index >= 0) events.splice(index, 1)
        }
      },
      effect(callback, label) {
        effects.push({ callback, label })
        return () => {}
      },
      get: () => undefined,
    },
  }
}

const DECISION_SPEC = `- id: deny-bash
  channel: tools/pre-execute
  when:
    names:
      allow: [bash]
  do:
    kind: decision
    phase: pre
    decision: deny
    reason: blocked
`

test('导出形态：name / inject 为空 / 文件与边界由装配配置提供', () => {
  assert.equal(name, 'declared-triggers')
  assert.deepEqual(inject, [], '只经 ctx.on 与 agent scope 工作，无宿主服务依赖')
  assert.deepEqual(configContract.parse({}, name), { triggersFile: '../triggers.yml', strategyDir: undefined, presetRoot: undefined })
  // passthrough 的既有语义：非法值静默取默认（不是 fail loud）。
  assert.deepEqual(configContract.parse({ triggersFile: '' }, name), { triggersFile: '../triggers.yml', strategyDir: undefined, presetRoot: undefined })
  assert.deepEqual(configContract.parse({ triggersFile: 42 }, name), { triggersFile: '../triggers.yml', strategyDir: undefined, presetRoot: undefined })
  assert.deepEqual(configContract.parse({ triggersFile: 'D:/x/t.yml' }, name), { triggersFile: 'D:/x/t.yml', strategyDir: undefined, presetRoot: undefined })
  // 未知键仍 fail loud（信封校验来自 fields.mjs 的 defineConfig）。
  assert.throws(() => configContract.parse({ nope: 1 }, name), /nope/)
})

test('文件缺失 = 没有声明：静默返回，不注册任何东西', async () => {
  const recorder = recordingCtx()
  await apply(recorder.ctx, { triggersFile: join(dir, 'absent.yml') })
  assert.deepEqual(recorder.events, [], 'ENOENT 不是错误（与 subagent-tool-policy 同一纪律）')
  assert.deepEqual(recorder.effects, [], '没有注册就没有待释放资源')
})

test('独立使用缺少声明配置时保持无行为，不猜测用户预设目录', async () => {
  // 缺省相对值只按包模块 URL 解析；生产装配传绝对 file URL，不从包目录反推用户目录。
  const recorder = recordingCtx()
  await apply(recorder.ctx, {})
  assert.deepEqual(recorder.events, [])
})

test('空声明数组：静默返回（与"没有声明"同义）', async () => {
  const recorder = recordingCtx()
  await apply(recorder.ctx, { triggersFile: specFile('[]\n') })
  assert.deepEqual(recorder.events, [])
})

test('YAML 不是数组：fail loud', async () => {
  await assert.rejects(
    () => apply(recordingCtx().ctx, { triggersFile: specFile('id: nope\n') }),
    /must be a YAML array/,
  )
})

test('文件在但声明非法：fail loud（保存期之外的第二道防线）', async () => {
  await assert.rejects(
    () => apply(recordingCtx().ctx, { triggersFile: specFile('- id: ""\n  channel: tools/pre-execute\n  do: { kind: decision, phase: pre, decision: deny }\n') }),
    /id must be a non-empty string/,
  )
})

test('正常链路：声明被编译并注册到声明的通道，when 前置生效', async () => {
  const recorder = recordingCtx()
  await apply(recorder.ctx, { triggersFile: specFile(DECISION_SPEC) })
  const entry = recorder.events.find((item) => item.event === 'tools/pre-execute')
  assert.ok(entry, '动作必须注册到声明的通道上')
  assert.deepEqual(await entry.handler({ name: 'bash' }, () => undefined), { kind: 'deny', reason: 'blocked' },
    'when 命中 → 动作体执行')
  assert.equal(await entry.handler({ name: 'read' }, () => 'downstream'), 'downstream',
    'when 不命中 → 放行下游')
})

test('声明模板：保存校验与运行时都从当前预设资产解析，并拒绝越界', async () => {
  const presetRoot = join(dir, 'presets')
  const presetDir = join(presetRoot, 'templated')
  mkdirSync(join(presetDir, 'assets'), { recursive: true })
  writeFileSync(join(presetDir, 'assets', 'notice.txt'), 'PRESET TEMPLATE')
  writeFileSync(join(dir, 'outside.txt'), 'OUTSIDE')
  const declarations = [{ id: 'template', channel: 'agent/pre-step', do: {
    kind: 'inject-text', config: { id: 'template', layer: 'pre-step', templateFile: './assets/notice.txt' },
  } }]
  const rootUrl = new URL(`${pathToFileURL(presetRoot).href}/`)
  const promptConfigOptions = {
    templateBaseUrl: pathToFileURL(join(presetDir, 'triggers.yml')), templatePresetRoot: rootUrl,
  }
  const compiled = compileDeclarations(declarations, { promptConfigOptions })
  const triggersFile = join(presetDir, 'triggers.yml')
  writeFileSync(triggersFile, JSON.stringify(declarations))
  for (const source of ['compiled', 'runtime']) {
    const recorder = recordingCtx()
    if (source === 'compiled') mountDeclarations(recorder.ctx, compiled)
    else await apply(recorder.ctx, { triggersFile, presetRoot: rootUrl.href })
    const user = { id: 'u', role: 'user', content: [{ type: 'text', text: 'USER' }], source: { kind: 'user' } }
    const result = await recorder.events.find(item => item.event === 'agent/pre-step').handler({
      agent: { session: { id: source, header: {}, snapshotEvents: () => [] }, options: { model: 'deepseek-chat' } }, messages: [user],
    }, () => ({ kind: 'enter', messages: [user] }))
    assert.equal(result.messages[1].content[0].text, 'PRESET TEMPLATE', source)
  }
  const escaped = structuredClone(declarations)
  escaped[0].do.config.templateFile = '../../outside.txt'
  assert.throws(() => compileDeclarations(escaped, { promptConfigOptions }), /escapes preset root/)
  writeFileSync(triggersFile, JSON.stringify(escaped))
  await assert.rejects(() => apply(recordingCtx().ctx, { triggersFile }), /escapes preset root/)
})

test('声明策略：显式 strategyDir 在编译与运行时保持同一解析基准', async () => {
  const presetRoot = join(dir, 'strategy-presets')
  const presetDir = join(presetRoot, 'custom')
  const strategyDir = join(presetDir, 'strategies')
  mkdirSync(strategyDir, { recursive: true })
  writeFileSync(join(strategyDir, 'custom.mjs'), 'export const createResolver = () => () => ({ text: "CUSTOM STRATEGY" })')
  const declarations = [{ id: 'strategy', channel: 'agent/pre-step', do: {
    kind: 'inject-text', config: { id: 'strategy', layer: 'pre-step', strategy: 'custom' },
  } }]
  const compiled = compileDeclarations(declarations, { promptConfigOptions: { strategyDir: pathToFileURL(strategyDir).href } })
  const triggersFile = join(presetDir, 'triggers.yml')
  writeFileSync(triggersFile, JSON.stringify(declarations))
  for (const source of ['compiled', 'runtime']) {
    const recorder = recordingCtx()
    if (source === 'compiled') mountDeclarations(recorder.ctx, compiled)
    else await apply(recorder.ctx, { triggersFile: pathToFileURL(triggersFile).href, strategyDir: '../custom/strategies' })
    const user = { id: 'u', role: 'user', content: [{ type: 'text', text: 'USER' }], source: { kind: 'user' } }
    const result = await recorder.events.find(item => item.event === 'agent/pre-step').handler({
      agent: { session: { id: source, header: {}, snapshotEvents: () => [] }, options: { model: 'deepseek-chat' } }, messages: [user],
    }, () => ({ kind: 'enter', messages: [user] }))
    assert.equal(result.messages[1].content[0].text, 'CUSTOM STRATEGY', source)
  }
})

test('disposer 交给 ctx.effect，且释放真的撤销注册', async () => {
  const recorder = recordingCtx()
  await apply(recorder.ctx, { triggersFile: specFile(DECISION_SPEC) })
  // 动作注册本身也会挂 effect（mountDeclarations 那一层），所以按 label 精确定位本模块这一层。
  const entry = recorder.effects.find((item) => item.label === 'declared-triggers: declarations')
  assert.ok(entry, 'keepDisposer 应把撤销函数挂到 effect 上（label 为 `${name}: declarations`）')
  const dispose = entry.callback()
  assert.equal(typeof dispose, 'function', 'effect 回调返回 disposer')
  assert.equal(recorder.events.filter((item) => item.event === 'tools/pre-execute').length, 1)
  dispose()
  assert.equal(recorder.events.filter((item) => item.event === 'tools/pre-execute').length, 0, '释放后不留监听')
})
