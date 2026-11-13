/**
 * 压缩与重晋升 epoch 的行为回归（Spec 轴 P1-4）。
 *
 * 三条验收（spec.md「Testing Decisions」的「压缩与重晋升」行）：
 *  1. 成功压缩推进新 epoch 后按既有规则重新判定角色、协议和正文，次数与顺序准确；
 *  2. 失败／取消压缩不推进 epoch，投递不被重复消费；
 *  3. 重挂与单次重试不重复投递、不重复消费晋升计数。
 *
 * 证据层级（如实）：压缩由本仓库 engine 的真实压缩实现 contextIdleCompaction.compactIdleRegion
 * 驱动 —— 真实 session.append 事务（compaction/start → summary → 带 surfaceOp.replace 的替身
 * user/message → compaction/end）、真实官方 tokenMeter、真实官方配对判据
 * @deepseek-ai/dsh-compaction、真实 surface.nodes 折叠。缺的一层是宿主
 * @deepseek-ai/dsh-compaction-basic 的摘要策略与自动触发阈值（该包在本仓库未安装，
 * 且本轮不装依赖），因此 summarize 由夹具提供实现、压缩由显式 compactRegion 触发。
 * 断言全部落在 adapter 实收请求的正文与 compaction-epoch 的 boundary/promoted 上，
 * 不做源码字符串匹配。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import { parse as parseYaml } from 'yaml'
import { createAgentAssembly } from '../../src/runtime/agent-assembly.ts'
import {
  mountContextRuntime, contextRuntimeOf, compactableRange,
} from '../../engine/context-provenance.mjs'
import { createEpochPromotion } from '../../engine/compaction-epoch.mjs'

const REPO_MODULE = fileURLToPath(new URL('../../modules/unrestricted/', import.meta.url))
/** 独立字面锚点：正文／Boost／协议来自包内资产的既有首行，epoch 与角色段是本夹具自己的名字。 */
const BODY_START = '<|im_start|>system:<project_instructions>'
const BOOST_START = '<dsh_boost scope="system" priority="override">'
const PROTO_START = '## Capability selection by task (mandatory)'
const BEFORE_ANCHOR = 'EPOCH-BEFORE-ANCHOR'
const AFTER_ANCHOR = 'EPOCH-AFTER-ANCHOR'
const ROLE_BODY_ANCHOR = 'EPOCH-ROLE-BODY'
const ROLE_COMMON_ANCHOR = 'EPOCH-ROLE-COMMON'
const SUMMARY_ANCHOR = 'EPOCH-SUMMARY'
const REFUSAL_TEXT = 'I cannot help with that.'

const require = createRequire(import.meta.url)
const peer = createRequire(require.resolve('@deepseek-ai/dsh-agent-loop'))
const load = name => import(pathToFileURL(peer.resolve(name)).href)
const pairing = await import(pathToFileURL(peer.resolve('@deepseek-ai/dsh-compaction')).href)
const [
  { default: Llm, LlmAdapter, createUserMessage }, { default: Agents }, { default: Sessions },
  { default: Projections }, { default: Prompt }, { default: Tools }, Native, { default: Loop },
  Persistence, TokenMeterModule,
] = await Promise.all([
  load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-agent'), load('@deepseek-ai/dsh-session'),
  load('@deepseek-ai/dsh-session-projection'), load('@deepseek-ai/dsh-system-prompt'),
  load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-tool-executor-native'),
  load('@deepseek-ai/dsh-agent-loop'), load('@deepseek-ai/dsh-session-persistence-jsonl'),
  load('@deepseek-ai/dsh-token-meter'),
])

const textOf = content => (content ?? []).map(block => (typeof block === 'string' ? block : block.text ?? '<' + block.type + '>')).join('')
const occurrences = (text, needle) => text.split(needle).length - 1
const deadline = async (promise, label) => {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 15000) })])
  } finally { clearTimeout(timer) }
}

/** 成功流（块级 + 增量级）；失败流是可识别的拒绝开场。 */
const okStream = function* (text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
const refusalStream = function* () {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: REFUSAL_TEXT }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: REFUSAL_TEXT } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/**
 * 模块定义：真实 modules/unrestricted 的副本 + 四条夹具规则。
 *  - epoch-before / epoch-after：既有 phase.compacted 判据（engine/conditions/phase.mjs），
 *    分别只在「从未成功压缩」与「已成功压缩」时投递，压缩推进 epoch 时二者必须互换；
 *  - role-body / role-common：pre-step 层的角色内容（另一插入点，dedupe: session）——
 *    压缩把旧角色消息移出可见面后必须重新投递一次；
 *  - request-retry 打开：第 3 条用一次真实拒绝驱动单次重放。
 */
function patchModule(moduleDir) {
  const file = join(moduleDir, 'module.yml')
  const source = parseYaml(readFileSync(file, 'utf8'))
  writeFileSync(join(moduleDir, 'assets', 'epoch-before.md'), BEFORE_ANCHOR)
  writeFileSync(join(moduleDir, 'assets', 'epoch-after.md'), AFTER_ANCHOR)
  writeFileSync(join(moduleDir, 'assets', 'role-body.md'), ROLE_BODY_ANCHOR)
  writeFileSync(join(moduleDir, 'assets', 'role-common.md'), ROLE_COMMON_ANCHOR)
  source.configOrder['epoch-before'] = 60
  source.configOrder['epoch-after'] = 110
  source.configOrder['role-body'] = 80
  source.configOrder['role-common'] = 90
  source.rules.push(
    { id: 'epoch-before', name: '压缩前', enabled: true, if: { phase: { promoted: 'ignore', compacted: false } },
      then: [{ id: 'before', kind: 'inject-text', config: { layer: 'system-section', order: 60, templateFile: './assets/epoch-before.md' } }] },
    { id: 'epoch-after', name: '压缩后', enabled: true, if: { phase: { promoted: 'ignore', compacted: true } },
      then: [{ id: 'after', kind: 'inject-text', config: { layer: 'system-section', order: 110, templateFile: './assets/epoch-after.md' } }] },
    { id: 'role-body', name: '角色正文', enabled: true, layer: 'pre-step',
      then: [{ id: 'body', kind: 'inject-text', config: { layer: 'pre-step', position: 'before-all', dedupe: 'session', templateFile: './assets/role-body.md' } }] },
    { id: 'role-common', name: '角色公共段', enabled: true, layer: 'pre-step',
      then: [{ id: 'common', kind: 'inject-text', config: { layer: 'pre-step', position: 'before-all', dedupe: 'session', templateFile: './assets/role-common.md' } }] },
  )
  source.rules.find(rule => rule.id === 'request-retry').enabled = true
  writeFileSync(file, JSON.stringify(source))
}

async function world(t) {
  const home = mkdtempSync(join(tmpdir(), 'pt-epoch-'))
  const moduleRoot = join(home, 'modules'), moduleDir = join(moduleRoot, 'unrestricted')
  mkdirSync(moduleRoot, { recursive: true })
  // 派生切片不进夹具：包内目录可能带着上一次保存留下的 rules/，复制进去只会制造失配噪声。
  cpSync(REPO_MODULE, moduleDir, { recursive: true, filter: source => !/[\\/]rules([\\/]|$)/.test(source) })
  patchModule(moduleDir)

  const calls = []
  let refusals = 0
  class Scripted extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id } }
    async *stream(options) {
      calls.push({ purpose: options.purpose, messages: options.messages.map(message => ({ role: message.role, text: textOf(message.content) })) })
      if (refusals > 0) { refusals -= 1; yield* refusalStream() } else { yield* okStream('OK') }
    }
  }
  const root = new Context()
  for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Native, Agents]) await root.plugin(plugin)
  await root.plugin(TokenMeterModule.default)
  await root.plugin(Persistence, { root: join(home, 'sessions'), compression: 'none' })
  await root.plugin(Loop, { agents: [] })
  root.provide('workingDirectory', { get: () => home, ensure: async () => home, set: async () => home })
  root.llm.registerAdapter(['local'], new Scripted())
  const runtime = createAgentAssembly(root, { moduleRoot, enabledModules: () => ['unrestricted'] })
  await runtime.settled()
  const handle = await root.agents.create({
    sessionId: 'epoch-' + Math.random().toString(36).slice(2),
    agentOptions: { provider: 'local', model: 'probe' },
    meta: { cwd: home },
  })
  const agent = handle.agent

  // 摘要由夹具提供（宿主 compaction-basic 未安装）；压缩事务本身仍是 engine 的真实实现。
  let summaryMode = 'ok'
  // 每次压缩一个新 controller：取消只会结束那一次事务，不污染后续压缩。
  let controller = new AbortController()
  class FixtureSummary extends Service {
    constructor(ctx) { super(ctx, 'compaction') }
    async summarize(_input, _owner, signal) {
      if (summaryMode === 'fail') throw new Error('epoch-fixture: summary failed')
      if (summaryMode === 'cancel') { controller.abort(); signal.throwIfAborted() }
      return { summary: [{ type: 'text', text: SUMMARY_ANCHOR }] }
    }
    async compactNow() { return null }
    async compactIfNeeded() { return null }
    async compactRegion() { throw new Error('epoch-fixture: host region compaction is not used here') }
  }
  const off = await mountContextRuntime(root, { enabled: true, prune: false, auto: false, modelSwitch: false },
    { agent, sourceModuleId: 'unrestricted' }, { Basic: FixtureSummary, pairing })
  const owner = contextRuntimeOf(agent)

  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    await off()
    await runtime.dispose()
    await handle.dispose()
    await root.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  }
  t.after(dispose)

  /** 发一轮并返回本轮 adapter 实收的请求（重试会多于一条）。 */
  const send = async text => {
    const before = calls.length
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await deadline(agent.whenIdle(), 'agent idle timed out')
    return calls.slice(before)
  }
  /** 该请求的完整可见正文：system 段 + pre-step 角色消息按投递顺序拼接。 */
  const joined = call => call.messages.map(message => message.text).join('\n')
  /** 每次冷扫 durable 事件流：真相在事件流，缓存层不参与判定。 */
  const epoch = () => createEpochPromotion(['tool/call', 'assistant/message'], {}).status(agent)
  const compact = async () => {
    controller = new AbortController()
    const meter = root.get('tokenMeter')
    const range = compactableRange(agent.session, meter.measure(agent.session), 0, pairing)
    assert.ok(range, '存在可压缩的平衡区间')
    return owner.compactRegion(range.start, range.end, controller.signal)
  }
  return {
    root, runtime, agent, calls, send, joined, epoch, compact, owner,
    refuse: () => { refusals += 1 },
    setSummaryMode: mode => { summaryMode = mode },
  }
}

const counts = text => ({
  body: occurrences(text, BODY_START),
  boost: occurrences(text, BOOST_START),
  protocol: occurrences(text, PROTO_START),
  before: occurrences(text, BEFORE_ANCHOR),
  after: occurrences(text, AFTER_ANCHOR),
  roleBody: occurrences(text, ROLE_BODY_ANCHOR),
  roleCommon: occurrences(text, ROLE_COMMON_ANCHOR),
})
const withFiller = label => label + ' ' + 'FILLER-BLOCK '.repeat(1200)

test('成功压缩推进新 epoch：正文、协议、Boost 与角色段按既有规则重判，次数与顺序准确', async t => {
  const w = await world(t)
  const first = (await w.send(withFiller('epoch-first')))[0]
  const before = w.epoch()
  assert.equal(before.boundary, -1, '压缩前没有成功边界')
  assert.deepEqual(counts(w.joined(first)), {
    body: 1, boost: 1, protocol: 1, before: 1, after: 0, roleBody: 1, roleCommon: 1,
  }, '首请求：正文/协议/Boost/角色各一次，压缩后段不投递')

  const result = await w.compact()
  assert.ok(result.endSeq > result.startSeq, '真实压缩事务写出了起止事件')
  assert.ok(result.shadowedSeqs.length > 0, '压缩真实遮蔽了可见节点')
  const after = w.epoch()
  assert.equal(after.boundary, result.endSeq, '成功压缩推进到新的 epoch 边界')
  assert.equal(after.promoted, false, '新 epoch 里不再继承压缩前的晋升相位')

  const second = (await w.send('epoch-second'))[0]
  const text = w.joined(second)
  assert.deepEqual(counts(text), {
    body: 1, boost: 1, protocol: 1, before: 0, after: 1, roleBody: 1, roleCommon: 1,
  }, '新 epoch：压缩前段撤下、压缩后段投递，正文/协议/Boost/角色仍各一次')
  const order = [BODY_START, AFTER_ANCHOR, PROTO_START, BOOST_START].map(anchor => text.indexOf(anchor))
  assert.ok(order.every(index => index >= 0), '四段都在同一请求里')
  assert.deepEqual([...order].sort((left, right) => left - right), order, '顺序：正文 → 压缩后段 → 协议 → Boost')
  const roleOrder = [ROLE_BODY_ANCHOR, ROLE_COMMON_ANCHOR].map(anchor => text.indexOf(anchor))
  assert.deepEqual([...roleOrder].sort((left, right) => left - right), roleOrder, '角色正文先于它的公共段')

  const third = (await w.send('epoch-third'))[0]
  assert.deepEqual(counts(w.joined(third)), counts(text), '再请求一次不累积、不重复投递')
  assert.equal(w.epoch().boundary, result.endSeq, '没有新压缩时不推进 epoch')
})

test('失败与取消压缩都不推进 epoch，投递不被重复消费', async t => {
  const w = await world(t)
  await w.send(withFiller('epoch-fail-first'))
  const baseline = w.epoch()
  assert.equal(baseline.boundary, -1)

  w.setSummaryMode('fail')
  await assert.rejects(w.compact(), /epoch-fixture: summary failed/)
  const failed = w.epoch()
  assert.equal(failed.boundary, baseline.boundary, '失败压缩不推进 epoch')
  assert.equal(failed.promoted, baseline.promoted, '失败压缩不改写晋升相位')
  const afterFailure = w.joined((await w.send('epoch-after-failure'))[0])
  assert.deepEqual(counts(afterFailure), {
    body: 1, boost: 1, protocol: 1, before: 1, after: 0, roleBody: 1, roleCommon: 1,
  }, '失败压缩后仍按旧 epoch 投递，各段一次且不重复消费')

  w.setSummaryMode('cancel')
  const cancelError = await w.compact().then(() => undefined, error => error)
  assert.equal(cancelError?.name, 'AbortError', '取消压缩以 AbortError 结束')
  const cancelled = w.epoch()
  assert.equal(cancelled.boundary, baseline.boundary, '取消压缩不推进 epoch')
  const afterCancel = w.joined((await w.send('epoch-after-cancel'))[0])
  assert.deepEqual(counts(afterCancel), counts(afterFailure), '取消压缩后投递次数与前一致，没有重复消费')

  // 反证：同一会话随后一次成功压缩确实推进，说明上面不是「压缩从不生效」。
  w.setSummaryMode('ok')
  const result = await w.compact()
  assert.equal(w.epoch().boundary, result.endSeq, '成功压缩才推进 epoch')
  const afterSuccess = w.joined((await w.send('epoch-after-success'))[0])
  assert.deepEqual(counts(afterSuccess), {
    body: 1, boost: 1, protocol: 1, before: 0, after: 1, roleBody: 1, roleCommon: 1,
  }, '成功压缩后重新判定一次，没有重复')
})

test('重挂与单次重试都不重复投递、不重复消费晋升计数', async t => {
  const w = await world(t)
  await w.send(withFiller('epoch-reattach-first'))
  const result = await w.compact()
  const settled = w.joined((await w.send('epoch-reattach-second'))[0])
  assert.deepEqual(counts(settled), {
    body: 1, boost: 1, protocol: 1, before: 0, after: 1, roleBody: 1, roleCommon: 1,
  })
  const epochBeforeReattach = w.epoch()

  // 重挂：既有热更重挂入口把同一模块重新装配，已接受的相位与投递不重来。
  await w.runtime.refresh()
  const reattached = w.joined((await w.send('epoch-reattached'))[0])
  assert.deepEqual(counts(reattached), counts(settled), '重挂后重新装配，各段仍是一次')
  const epochAfterReattach = w.epoch()
  assert.equal(epochAfterReattach.boundary, epochBeforeReattach.boundary, '重挂不推进 epoch')
  assert.equal(epochAfterReattach.promoted, epochBeforeReattach.promoted, '重挂不重复消费晋升计数')

  // 单次重试：一次真实拒绝触发的重放只多一条请求，正文与角色段仍各一次、epoch 不变。
  const priorCalls = w.calls.length
  w.refuse()
  const retried = await w.send('epoch-retry')
  assert.equal(retried.length, 2, '拒绝触发一次重放：两次真实请求')
  assert.equal(w.calls.length - priorCalls, 2)
  for (const [index, call] of retried.entries()) {
    const text = w.joined(call)
    assert.deepEqual(counts(text), {
      body: 1, boost: 1, protocol: 1, before: 0, after: 1, roleBody: 1, roleCommon: 1,
    }, '重放的两次请求各自只投递一份（第 ' + (index + 1) + ' 次）')
    assert.equal(occurrences(text, REFUSAL_TEXT), 0, '拒绝正文不会进入投递面')
  }
  const epochAfterRetry = w.epoch()
  assert.equal(epochAfterRetry.boundary, epochBeforeReattach.boundary, '重试不新建 epoch')
  assert.equal(epochAfterRetry.promoted, epochBeforeReattach.promoted, '重试不重复消费晋升计数')
  assert.equal(result.endSeq, epochAfterRetry.boundary, '期间只有那一次成功压缩推进了 epoch')
})