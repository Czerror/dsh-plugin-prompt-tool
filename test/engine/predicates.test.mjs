import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'

import { MATCH_LOGIC } from '../../engine/anchor-match.mjs'
import { UNAVAILABLE } from '../../engine/conditions/availability.mjs'
import {
  agentPresetId,
  composite,
  createCountPredicate,
  createNameListPredicate,
  createPhasePredicate,
  createPresetPredicate,
  createSessionStatePredicate,
  createSourcePredicate,
  createTextPredicate,
} from '../../engine/predicates.mjs'

// ── 测试夹具 ─────────────────────────────────────────────────────────────────

let sessionSeq = 0
const makeSession = (events = []) => ({
  id: `s-${(sessionSeq += 1)}`,
  header: { cwd: '/workspace', delegationDepth: 0 },
  snapshotEvents: () => events,
})
const makeAgent = (session) => ({ session })

const toolCall = (seq) => ({ type: 'tool/call', seq })
const assistantText = (text, seq, turn) => ({
  type: 'assistant/message',
  seq,
  data: { turn, message: { content: [{ type: 'text', text }] } },
})
const userMessage = (seq) => ({ type: 'user/message', seq, data: { message: { content: [{ type: 'text', text: 'hi' }] } } })

// ── 组合（and/or/not）────────────────────────────────────────────────────────

test('组合：短路求值与显式树形优先级', () => {
  const calls = []
  const stub = (label, value) => {
    const predicate = () => {
      calls.push(label)
      return value
    }
    predicate.kind = 'stub'
    return predicate
  }

  calls.length = 0
  assert.equal(composite({ any: [stub('a', false), stub('b', true), stub('c', false)] })(null), true)
  assert.deepEqual(calls, ['a', 'b'], 'any：首个命中后短路')

  calls.length = 0
  assert.equal(composite({ all: [stub('a', true), stub('b', false), stub('c', true)] })(null), false)
  assert.deepEqual(calls, ['a', 'b'], 'all：首个未命中后短路')

  calls.length = 0
  assert.equal(composite({ notAny: [stub('a', false), stub('b', true), stub('c', true)] })(null), false)
  assert.deepEqual(calls, ['a', 'b'], 'notAny：首个命中后短路')

  calls.length = 0
  assert.equal(composite({ not: stub('n', false) })(null), true)
  assert.deepEqual(calls, ['n'], 'not：只求值一次')

  calls.length = 0
  const nested = composite({ all: [{ not: stub('a', true) }, stub('b', true)] })
  assert.equal(nested(null), false)
  assert.deepEqual(calls, ['a'], '优先级是显式的树：not 先算且 all 短路，b 不被求值')

  const passthrough = () => true
  assert.equal(composite(passthrough), passthrough, '谓词函数直通')
})

test('组合：非法节点在挂载期 fail loud（不隐式排序、不放宽）', () => {
  assert.throws(() => composite({ all: [() => true], not: () => false }), /exactly one of/, '混合声明不猜优先级')
  assert.throws(() => composite({ any: [] }), /non-empty array/, '空数组不是"恒假"')
  assert.throws(() => composite({ all: [true] }), /a composite must be/)
  assert.throws(() => composite({ xor: [() => true] }), /unknown composite key/)
  assert.throws(() => composite('nope'), /a composite must be/)
  assert.throws(() => composite(null), /a composite must be/)
})

// ── 1. 文本锚定 ──────────────────────────────────────────────────────────────

test('文本类：主键/副键/整词/大小写/正则/前缀/模式的命中边界', () => {
  assert.equal(createTextPredicate({ keys: ['We'] })('we proceed'), true)
  assert.equal(createTextPredicate({ keys: ['We'], caseSensitive: true })('we proceed'), false)
  assert.equal(createTextPredicate({ keys: ['we'], wholeWords: true })('weep'), false)
  assert.equal(createTextPredicate({ keys: ['we'], wholeWords: true })('we go'), true)
  assert.equal(createTextPredicate({ keys: ['/^We\\b/i'] })('we go'), true)
  assert.equal(createTextPredicate({ keys: ['We'], mode: 'prefix' })('go We'), false)
  assert.equal(createTextPredicate({ keys: ['We'], mode: 'prefix' })('We go'), true)

  const secondary = (logic) => createTextPredicate({ keys: ['anchor'], secondaryKeys: ['skip'], logic })
  assert.equal(secondary(MATCH_LOGIC.ALL)('anchor yes'), false, 'all：副键未全命中')
  assert.equal(secondary(MATCH_LOGIC.ALL)('anchor skip'), true)
  assert.equal(secondary(MATCH_LOGIC.NOT)('anchor yes'), true, 'not：副键全未命中')
  assert.equal(secondary(MATCH_LOGIC.NOT)('anchor skip'), false)
  assert.equal(secondary(MATCH_LOGIC.NOT_ANY)('anchor yes'), true, 'notAny：至少一个副键未命中')
  assert.equal(secondary(MATCH_LOGIC.NOT_ANY)('anchor skip'), false)

  // subject 载荷：按 condition.mjs 的 subject 词汇取文本；未声明 subject 不猜字段
  assert.equal(createTextPredicate({ keys: ['hello'], subject: 'userMessage' })({ userText: 'hello there' }), true)
  assert.equal(createTextPredicate({ keys: ['hello'], subject: 'userMessage' })({ userText: 'nope' }), false)
  assert.equal(createTextPredicate({ keys: ['hello'], subject: 'userMessage' })({ userText: '' }), false, '已知空文本仍可判定为不匹配')
  assert.equal(createTextPredicate({ keys: ['hello'] })({ userText: 'hello' }), UNAVAILABLE)
  assert.equal(createTextPredicate({ keys: ['hello'] })(undefined), UNAVAILABLE)
})

// ── 2. 相位（epoch）─────────────────────────────────────────────────────────

test('相位类：订阅 / 不订阅两种复位语义分别可表达', () => {
  const events = [toolCall(1)]
  const session = makeSession(events)
  const agent = makeAgent(session)
  const subscribed = createPhasePredicate({ subscribe: true })
  const cold = createPhasePredicate({ subscribe: false })
  assert.equal(subscribed(agent), true)
  assert.equal(cold(agent), true)
  assert.equal(cold.observe, undefined, '不订阅模式没有增量入口')

  // durable 日志里出现压缩边界，但没有任何 observe 通知
  events.push({ type: 'compaction/end', seq: 2 })
  assert.equal(cold(agent), false, '不订阅：下次判定冷扫日志，复位无需通知')
  assert.equal(subscribed(agent), true, '订阅：未通知就不复位，复位由 observe 驱动')

  subscribed.observe(session, { type: 'compaction/end', seq: 2 })
  assert.equal(subscribed(agent), false, '收到边界事件后复位')
  subscribed.observe(session, toolCall(3))
  assert.equal(subscribed(agent), true, '边界之后的新晋升信号再次晋升')
})

// ── 3. 来源 ──────────────────────────────────────────────────────────────────

test('来源类：精确/前缀、大小写与多通道合取', () => {
  const kindExact = createSourcePredicate({ kind: 'plugin' })
  assert.equal(kindExact({ source: { kind: 'plugin' } }), true)
  assert.equal(kindExact({ source: { kind: 'Plugin' } }), false, '缺省大小写敏感（与现有四处比较一致）')
  assert.equal(kindExact({ source: { kind: 'pluginx' } }), false, '缺省精确相等，不是前缀')

  const insensitive = createSourcePredicate({ kind: 'plugin', caseSensitive: false })
  assert.equal(insensitive({ source: { kind: 'PLUGIN' } }), true)

  const prefix = createSourcePredicate({ plugin: 'pt-', match: 'prefix' })
  assert.equal(prefix({ source: { plugin: 'pt-cordis' } }), true)
  assert.equal(prefix({ source: { plugin: 'x-pt-cordis' } }), false)
  const exactPlugin = createSourcePredicate({ plugin: 'pt-' })
  assert.equal(exactPlugin({ source: { plugin: 'pt-cordis' } }), false, 'exact 不前缀匹配')

  // 多通道是合取；析取用 composite({ any }) —— 不隐式二选一
  const both = createSourcePredicate({ kind: 'plugin', plugin: 'pt-cordis' })
  assert.equal(both({ source: { kind: 'plugin', plugin: 'pt-cordis' } }), true)
  assert.equal(both({ source: { kind: 'plugin', plugin: 'other' } }), false)
  const either = composite({
    any: [createSourcePredicate({ kind: 'instruction-hint' }), createSourcePredicate({ plugin: 'pt-cordis' })],
  })
  assert.equal(either({ source: { kind: 'user', plugin: 'pt-cordis' } }), true)
  assert.equal(either({ source: { kind: 'user', plugin: 'other' } }), false)

  // 数组形态与边界输入
  assert.equal(createSourcePredicate({ kind: ['user', 'goal'] })({ source: { kind: 'goal' } }), true)
  assert.equal(createSourcePredicate({ kind: ['user', 'goal'] })({ source: { kind: 'skill' } }), false)
  assert.equal(kindExact({}), UNAVAILABLE, '无 source 是缺事实，不能被not翻成命中')
  assert.equal(kindExact({ source: {} }), false)
  assert.equal(kindExact({ source: { kind: '' } }), false)
  assert.equal(kindExact(undefined), UNAVAILABLE)
})

// ── 4. 计数 ──────────────────────────────────────────────────────────────────

test('计数类：冷启动冷扫重建与上下限边界', () => {
  const session = makeSession([toolCall(1), toolCall(2), userMessage(3), toolCall(4)])
  const agent = makeAgent(session)
  assert.equal(createCountPredicate({ of: 'tool-call', min: 3 })(agent), true, '冷扫 3 次工具调用')
  assert.equal(createCountPredicate({ of: 'tool-call', min: 4 })(agent), false)
  assert.equal(createCountPredicate({ of: 'tool-call', max: 3 })(agent), true, '上限含等号')
  assert.equal(createCountPredicate({ of: 'tool-call', max: 2 })(agent), false)
  assert.equal(createCountPredicate({ of: 'tool-call', min: 2, max: 4 })(agent), true)
  assert.equal(createCountPredicate({ of: 'user-message', min: 1 })(agent), true)
  assert.equal(createCountPredicate({ of: 'turn', min: 1 })(agent), false, '无 turn/start')

  assert.equal(createCountPredicate({ of: 'assistant-chars', min: 5 })(makeSession([assistantText('12345', 1)])), true)
  assert.equal(createCountPredicate({ of: 'assistant-chars', min: 6 })(makeSession([assistantText('12345', 1)])), false)
  assert.equal(createCountPredicate({ of: 'assistant-chars', max: 0 })(makeSession([assistantText('', 1)])), true)

  assert.equal(createCountPredicate({ of: 'tool-call', max: 0 })(makeAgent(makeSession([]))), true, '空会话 = 计数 0')
  assert.equal(createCountPredicate({ of: 'tool-call', min: 1 })(undefined), false, '取不到会话 = 计数 0')

  assert.throws(() => createCountPredicate({ of: 'nope', min: 1 }), /count of must be one of/)
  assert.throws(() => createCountPredicate({ of: 'tool-call' }), /needs min, max or every/)
  assert.throws(() => createCountPredicate({ of: 'tool-call', per: 'step', min: 1 }), /per must be "session" or "turn"/)
  assert.throws(() => createCountPredicate({ of: 'tool-call', min: -1 }), /min must be an integer >= 0/)
})

// ── 5. 名单 ──────────────────────────────────────────────────────────────────

test('名单类：大小写、空名与未声明的边界', () => {
  assert.equal(createNameListPredicate({})({ name: 'anything' }), true, '两侧未声明 = 不过滤')
  assert.equal(createNameListPredicate({ allow: [] })('read'), false, '显式空白名单 = 一个都不通过')
  assert.equal(createNameListPredicate({ deny: [] })('read'), true, '显式空黑名单 = 一个都不拦')
  assert.equal(createNameListPredicate({ allow: ['Read'] })('read'), false, '缺省大小写敏感')
  assert.equal(createNameListPredicate({ allow: ['Read'], caseSensitive: false })('read'), true)
  assert.equal(createNameListPredicate({ allow: ['read'] })(''), UNAVAILABLE, '无工具名不能判定名单命中')
  assert.equal(createNameListPredicate({ allow: ['read'] })({ name: undefined }), UNAVAILABLE)
  assert.equal(createNameListPredicate({ deny: ['read'] })('read'), false)
  assert.throws(() => createNameListPredicate({ allow: [''] }), /non-empty strings/)
  assert.throws(() => createNameListPredicate({ deny: [1] }), /non-empty strings/)
  assert.throws(() => createNameListPredicate({ allow: 'read' }), /non-empty strings/)
})

// ── 6. 会话状态 ──────────────────────────────────────────────────────────────

test('会话状态类：present 镜像语义与只读 durable 快照', () => {
  const seen = createSessionStatePredicate({ type: 'user/message', present: true })
  assert.equal(seen(makeSession([userMessage(1)])), true)
  assert.equal(seen(makeSession([])), false)
  assert.equal(createSessionStatePredicate({ type: 'user/message' })(makeSession([userMessage(1)])), false)
  assert.equal(createSessionStatePredicate({ type: 'user/message' })(makeAgent(makeSession([]))), true, 'agent 载荷取 session')

  const events = []
  const session = makeSession(events)
  const fresh = createSessionStatePredicate({ type: 'user/message' })
  assert.equal(fresh(session), true)
  events.push(userMessage(1))
  assert.equal(fresh(session), false, '每次判定都读 durable 快照，不缓存过期答案')

  assert.throws(() => createSessionStatePredicate({}), /needs an event type/)
  assert.throws(() => createSessionStatePredicate({ type: 'x', present: 'yes' }), /present must be a boolean/)
})

// ── 7. 当前预设 ──────────────────────────────────────────────────────────────

/**
 * 官方 standingMountFor 的**契约替身**：读真实 live scope chain
 * （`scopeParentOf(scopeOf(agentCtx))`，与 `mount.ts:243-248` 逐行同构），
 * 按 standing key 找挂载。本仓库不依赖 `@deepseek-ai/dsh-agent-presets`
 * （它由宿主 profile 提供），所以挂载记录用 Map 替身，scope 链是真实的。
 */
function standingMountForOf(mounted) {
  return (agentCtx) => {
    const agentKey = scopeOf(agentCtx)
    const standingKey = agentKey === undefined ? undefined : scopeParentOf(agentKey)
    if (standingKey === undefined) return undefined
    const presetId = mounted.get(standingKey)
    return presetId === undefined ? undefined : { presetId }
  }
}

/** 官方服务方法：`composedPreset(agentCtx) { return standingMountFor(agentCtx)?.presetId }`。 */
const serviceOf = (standingMountFor) => ({
  composedPreset: (agentCtx) => standingMountFor(agentCtx)?.presetId,
})

/** 真实 agent.ctx：真实 cordis 作用域 + 真实 dsh-scope 的 standing → agent 父子链。 */
function liveScopeFixture(presetId) {
  const root = new Context()
  const standingKey = {}
  createScope(root, standingKey)
  const agentScope = createScope(root, {}, { parent: standingKey })
  const mounted = new Map()
  if (presetId !== undefined) mounted.set(standingKey, presetId)
  const standingMountFor = standingMountForOf(mounted)
  return {
    root,
    standingKey,
    agent: { id: 'live-agent', ctx: agentScope.ctx },
    standingMountFor,
    serviceCtx: { get: (name) => (name === 'agentPresets' ? serviceOf(standingMountFor) : undefined) },
    absentCtx: { get: () => undefined },
  }
}

test('预设类：真实 agent.ctx 的 live 挂载——服务路径与模块导出兜底同一结果', () => {
  const fixture = liveScopeFixture('dsh-studio-lab')
  // 证明判据是真实的 live scope 链，不是夹具字段
  assert.equal(scopeParentOf(scopeOf(fixture.agent.ctx)), fixture.standingKey, 'agent scope 的父就是 standing scope')

  const fromService = agentPresetId(fixture.serviceCtx, fixture.agent)
  const fromFallback = agentPresetId(fixture.absentCtx, fixture.agent, fixture.standingMountFor)
  assert.equal(fromService, 'dsh-studio-lab', '服务方法（首选）')
  assert.equal(fromFallback, fromService, '服务缺席时走模块导出兜底得到同一结果')

  assert.equal(createPresetPredicate({ ctx: fixture.serviceCtx, presetId: 'dsh-studio-lab' })(fixture.agent), true)
  assert.equal(createPresetPredicate({
    ctx: fixture.absentCtx,
    presetId: 'dsh-studio-lab',
    standingMountFor: fixture.standingMountFor,
  })(fixture.agent), true, '兜底路径同样命中')
  assert.equal(createPresetPredicate({ ctx: fixture.serviceCtx, presetId: 'pt-cordis' })(fixture.agent), false)
})

test('预设类：无 standing scope / 无挂载＝undefined，调用方不命中且不回落默认值', () => {
  // (a) standing scope 上没有挂载记录
  const empty = liveScopeFixture(undefined)
  assert.equal(agentPresetId(empty.serviceCtx, empty.agent), undefined)
  assert.equal(agentPresetId(empty.absentCtx, empty.agent, empty.standingMountFor), undefined)

  // (b) 裸 agent：自己的 scope 没有父（没 join 任何预设）
  const root = new Context()
  const bare = { id: 'bare-agent', ctx: createScope(root, {}).ctx }
  assert.equal(scopeParentOf(scopeOf(bare.ctx)), undefined)
  assert.equal(agentPresetId(empty.absentCtx, bare, empty.standingMountFor), undefined)

  // 硬约束 ②：宿主 settings 的 agent-presets.default 是新会话默认值，不得当当前预设
  const decoyCtx = {
    get: (name) => (name === 'settings' ? { get: () => ({ default: 'custom-standard' }) } : undefined),
  }
  // 硬约束 ①：session.header.agentPreset 是出生预设，不得被读
  const decoyAgent = { ...empty.agent, session: { header: { agentPreset: 'custom-standard' } } }
  assert.equal(agentPresetId(decoyCtx, decoyAgent, empty.standingMountFor), undefined)
  // 硬约束 ③：undefined = 该 agent 没有预设 → 调用方按"不干预/不命中"处理
  for (const presetId of ['custom-standard', 'dsh-studio-lab', 'agent-presets.default']) {
    assert.equal(
      createPresetPredicate({ ctx: decoyCtx, presetId, standingMountFor: empty.standingMountFor })(decoyAgent),
      UNAVAILABLE,
      `不得命中 ${presetId}`,
    )
  }

  assert.throws(() => createPresetPredicate({}), /needs a presetId/)
})
