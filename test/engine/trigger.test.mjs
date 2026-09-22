/**
 * `engine/trigger.mjs` 调度层断言（B3 T3 的一部分）。
 *
 * 谓词与动作的接入由 T1/T2 的用例覆盖；本文件只钉住 `trigger.mjs` **自己的契约**：
 * 同通道稳定排序、位置映射（不承担排序）、声明校验（未知字段 fail loud）、
 * 判定失败的降级放行、以及 disposer 全注销。这些都是 R13 明确要求分离的两层，
 * 所以必须各有一条断言把边界钉死。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orderTriggers, registrationOptions, validateTrigger, mountTriggers, createDecisionLog } from '../../engine/trigger.mjs'
import { MAX_TRACKED_SESSIONS, isDelegated, sessionEvents, sessionMapGet } from '../../engine/shared.mjs'

const decl = (over = {}) => ({ id: 't', channel: 'agent/pre-step', when: () => true, do: () => {}, ...over })

test('orderTriggers：channelOrder 升序，且同值保持声明序（稳定）', () => {
  const ordered = orderTriggers([
    decl({ id: 'c', channelOrder: 2 }),
    decl({ id: 'a', channelOrder: 1 }),
    decl({ id: 'b', channelOrder: 1 }),
    decl({ id: 'd', channelOrder: 0 }),
  ])
  assert.deepEqual(ordered.map((item) => item.id), ['d', 'a', 'b', 'c'], '同值的 a/b 必须保持声明序')
  assert.deepEqual(orderTriggers([]), [], '空声明返回空')
})

test('内联触发器缺省顺序为零，after-next 谓词读取下游结算后的状态', async () => {
  const registered = []
  let settled = false
  const ctx = { on: (_channel, handler) => { registered.push(handler); return () => {} } }
  mountTriggers(ctx, [5, undefined, 1].map((channelOrder, index) => decl({
    id: String(index), channelOrder, when: () => settled, do: () => index,
  })))
  assert.equal(await registered[0]({}, async () => { settled = true; return 'base' }), 1)
})

test('registrationOptions：只有 outermost 才 prepend —— 位置字段不承担排序', () => {
  assert.deepEqual(registrationOptions({ waterfallPosition: 'outermost' }), { prepend: true })
  assert.deepEqual(registrationOptions({ waterfallPosition: 'default' }), {})
  assert.deepEqual(registrationOptions({}), {}, '缺省按 default 处理')
})

test('validateTrigger：未知字段与非法值一律 fail loud，缺省逐项填充', () => {
  assert.throws(() => validateTrigger({ ...decl(), nope: 1 }, 'demo'), /unknown trigger field\(s\) nope/)
  assert.throws(() => validateTrigger({ ...decl(), id: '' }, 'demo'), /id must be a non-empty string/)
  assert.throws(() => validateTrigger({ ...decl(), channel: '' }, 'demo'), /channel must be a non-empty event name/)
  assert.throws(() => validateTrigger({ ...decl(), when: true }, 'demo'), /when must be a predicate function/)
  assert.throws(() => validateTrigger({ ...decl(), do: null }, 'demo'), /do must be an action function/)
  assert.throws(() => validateTrigger({ ...decl(), channelOrder: -1 }, 'demo'), /channelOrder must be a non-negative safe integer/)
  assert.throws(() => validateTrigger({ ...decl(), channelOrder: 1.5 }, 'demo'), /channelOrder must be a non-negative safe integer/)
  assert.throws(() => validateTrigger({ ...decl(), waterfallPosition: 'top' }, 'demo'), /waterfallPosition must be one of default, outermost/)
  assert.throws(() => validateTrigger({ ...decl(), phase: 'during' }, 'demo'), /phase must be one of before-next, after-next/)
  assert.throws(() => validateTrigger(null, 'demo'), /trigger declaration must be an object/)

  const filled = validateTrigger(decl(), 'demo')
  assert.equal(filled.channelOrder, 0)
  assert.equal(filled.waterfallPosition, 'default')
  assert.equal(filled.phase, 'after-next')
  assert.equal(filled.degrade, 'skip')
})

test('mountTriggers：各触发器只在自己的通道注册，且 disposer 注销全部', () => {
  const registered = []
  const ctx = {
    on: (channel, handler, options) => {
      const record = { channel, handler, options }
      registered.push(record)
      return () => { registered.splice(registered.indexOf(record), 1) }
    },
  }
  const dispose = mountTriggers(ctx, [
    decl({ id: 'first', channel: 'agent/pre-step' }),
    decl({ id: 'second', channel: 'system-prompt/assemble', channelOrder: 1, waterfallPosition: 'outermost' }),
  ], { plugin: 'demo' })
  assert.deepEqual(registered.map((item) => item.channel), ['agent/pre-step', 'system-prompt/assemble'], '各在自己的合法通道')
  assert.deepEqual(registered[1].options, { prepend: true }, 'outermost 才 prepend')
  dispose()
  assert.equal(registered.length, 0, 'disposer 注销全部监听器')
})

test('mountTriggers：判定为假 → 放行下游；判定抛错 → 告警一次并放行（不吞下游异常）', async () => {
  const registered = []
  const ctx = { on: (channel, handler) => { registered.push(handler); return () => {} } }
  const warnings = []
  const actions = []
  mountTriggers(ctx, [
    decl({ id: 'miss', when: () => false, do: () => actions.push('miss') }),
    decl({ id: 'boom', channel: 'system-prompt/assemble', when: () => { throw new Error('predicate blew up') }, do: () => actions.push('boom') }),
  ], { plugin: 'demo', warnOnce: (message) => warnings.push(message) })

  const inner = async () => 'inner-result'
  assert.equal(await registered[0]('payload', inner), 'inner-result', '判定为假时原样放行')
  assert.deepEqual(actions, [], '未命中不执行动作')

  assert.equal(await registered[1]('payload', inner), 'inner-result', '判定抛错时仍放行下游')
  assert.equal(warnings.length, 1, '告警一次')
  assert.match(warnings[0], /trigger boom predicate failed/)
  assert.deepEqual(actions, [], '判定失败不执行动作')
})

test('mountTriggers：phase 决定动作在 next 之前还是之后，且 do 的返回值参与瀑布', async () => {
  const registered = []
  const ctx = { on: (channel, handler) => { registered.push(handler); return () => {} } }
  const order = []
  mountTriggers(ctx, [
    // `agents.push(...)` 返回新长度（非 undefined）——用 return undefined 显式表达「不干预」。
    decl({ id: 'before', phase: 'before-next', when: () => true, do: () => { order.push('before'); return undefined } }),
    decl({ id: 'after', channel: 'agent/request', phase: 'after-next', when: () => true, do: (_payload, result) => { order.push(`after:${result}`); return undefined } }),
  ], { plugin: 'demo' })
  const inner = async () => { order.push('next'); return 'assembled' }
  assert.equal(await registered[0]('payload', inner), 'assembled')
  assert.deepEqual(order, ['before', 'next'], 'before-next 的动作先于 next；返回 undefined = 交给下游')
  order.length = 0
  assert.equal(await registered[1]('payload', inner), 'assembled', 'after-next 返回 undefined 时下游结果原样')
  assert.deepEqual(order, ['next', 'after:assembled'], 'after-next 的动作拿到 next 的返回值')
})

test('mountTriggers：do 返回非 undefined 即成为本次瀑布结果（裁决类动作的出口）', async () => {
  const registered = []
  const ctx = { on: (channel, handler) => { registered.push(handler); return () => {} } }
  const deny = { kind: 'deny', reason: 'not allowed' }
  mountTriggers(ctx, [
    // before-next：拒绝在下游执行之前给出终局。
    decl({ id: 'deny-pre', phase: 'before-next', when: () => true, do: () => deny }),
    // after-next：改写下游结果。
    decl({ id: 'replace-post', channel: 'agent/request', when: () => true, do: (_payload, result) => ({ ...result, replaced: true }) }),
  ], { plugin: 'demo' })

  let downstreamRan = false
  const inner = async () => { downstreamRan = true; return { kind: 'accept' } }
  assert.deepEqual(await registered[0]('payload', inner), deny, 'before-next 的返回值即终局')
  assert.equal(downstreamRan, false, '给出终局后不得再执行下游')
  assert.deepEqual(await registered[1]('payload', inner), { kind: 'accept', replaced: true }, 'after-next 的返回值替换下游结果')

  // 反向：返回 undefined 必须放行（否则「命中即拦」会变成默认行为）。
  const pass = []
  const ctx2 = { on: (channel, handler) => { pass.push(handler); return () => {} } }
  mountTriggers(ctx2, [decl({ id: 'noop', when: () => true, do: () => undefined })], { plugin: 'demo' })
  assert.equal(await pass[0]('payload', async () => 'downstream'), 'downstream', '返回 undefined 时下游结果原样返回')
})

test('决策链（T5）：能区分「没生效」的不同原因，且每会话只输出一次', async () => {
  const logged = []
  const registered = []
  const ctx = { on: (channel, handler) => { registered.push(handler); return () => {} } }
  const diagnose = createDecisionLog({
    enabled: true,
    logger: { info: (message) => logged.push(message) },
    sessionOf: (payload) => payload?.session?.id,
  })
  mountTriggers(ctx, [
    decl({ id: 'miss', channel: 'agent/pre-step', when: () => false, do: () => {} }),
    decl({ id: 'boom', channel: 'agent/request', when: () => { throw new Error('predicate blew up') }, do: () => {} }),
  ], { plugin: 'demo', warnOnce: () => {}, diagnose })

  const inner = async () => 'r'
  const payload = { session: { id: 's-1' } }
  await registered[0](payload, inner)   // 谓词未命中
  await registered[1](payload, inner)   // 谓词抛错（降级）
  diagnose.flush(payload)               // flush 由调用方在「一轮结束」时驱动（引擎不猜）
  assert.equal(logged.length, 1, '每会话只输出一条链')
  assert.match(logged[0], /\[trigger-decision\]/, '带统一前缀')
  assert.match(logged[0], /miss@agent\/pre-step predicate=miss action=skipped/, '未命中可区分')
  assert.match(logged[0], /boom@agent\/request predicate=error action=skipped/, '降级可区分')

  await registered[0](payload, inner)
  diagnose.flush(payload)
  assert.equal(logged.length, 1, '同会话再判定不再输出')
  await registered[0]({ session: { id: 's-2' } }, inner)
  diagnose.flush({ session: { id: 's-2' } })
  assert.equal(logged.length, 2, '不同会话各有自己的链')
})

test('决策链（T5）：默认关闭时零日志，且绝不打印消息正文或返回值', async () => {
  const registered = []
  const ctx = { on: (channel, handler) => { registered.push(handler); return () => {} } }
  // 默认关闭（不传 enabled）
  const quiet = []
  const off = createDecisionLog({ logger: { info: (message) => quiet.push(message) }, sessionOf: () => 's' })
  mountTriggers(ctx, [decl({ id: 'q', channel: 'agent/pre-step', when: () => true, do: () => {} })], { plugin: 'demo', diagnose: off })
  await registered[registered.length - 1]({ session: {} }, async () => 'r')
  assert.deepEqual(quiet, [], '默认关闭时零额外日志')

  // 开启时也不得泄漏正文
  const logged = []
  const on = createDecisionLog({ enabled: true, logger: { info: (message) => logged.push(message) }, sessionOf: () => 's' })
  mountTriggers(ctx, [decl({ id: 't', channel: 'agent/request', when: () => true, do: () => {} })], { plugin: 'demo', diagnose: on })
  await registered[registered.length - 1]({ message: 'SECRET-USER-TEXT', session: {} }, async () => 'SECRET-RESULT')
  on.flush({ session: {} })   // flush 由调用方在「一轮结束」时驱动（引擎不猜何时算一轮）
  assert.equal(logged.length, 1)
  assert.doesNotMatch(logged[0], /SECRET/, '只记 id/通道/判定/动作，不含正文与返回值')
})

test('会话态接线：带 observe 的谓词共用一条 session/event 事件源，观察者抛错只告警', () => {
  const registered = []
  const ctx = { on: (channel, handler) => { registered.push({ channel, handler }); return () => {} } }
  const seen = []
  const warnings = []

  const withObserve = () => true
  withObserve.observe = (session, event) => seen.push(`${session.id}:${event.type}`)
  const boom = () => true
  boom.observe = () => { throw new Error('observer blew up') }

  mountTriggers(ctx, [
    decl({ id: 'obs', when: withObserve, do: () => {} }),
    decl({ id: 'boom', channel: 'agent/request', when: boom, do: () => {} }),
    decl({ id: 'plain', channel: 'agent/pre-step', when: () => true, do: () => {} }),
  ], { plugin: 'demo', warnOnce: (message) => warnings.push(message) })

  const eventChannels = registered.filter((item) => item.channel === 'session/event')
  assert.equal(eventChannels.length, 1, '同组声明共用一条 session/event 监听（不按触发器各接一条）')

  eventChannels[0].handler({ id: 's-1' }, { type: 'tool/call' })
  assert.deepEqual(seen, ['s-1:tool/call'], '带 observe 的谓词收到事件')
  assert.equal(warnings.length, 1, '观察者抛错只告警一次')
  assert.match(warnings[0], /trigger boom observe failed/)
  assert.deepEqual(seen, ['s-1:tool/call'], '一个观察者抛错不影响其它观察者')

  // 没有任何谓词带 observe 时不接这条监听（零开销）。
  const plainChannels = []
  const ctx2 = { on: (channel) => { plainChannels.push(channel); return () => {} } }
  mountTriggers(ctx2, [decl({ id: 'plain', when: () => true, do: () => {} })], { plugin: 'demo' })
  assert.deepEqual(plainChannels, ['agent/pre-step'], '没有 observe 时不额外接 session/event')
})

/**
 * `state` 的会话态契约（B4 迁移的基准）。这些读法**必须在 shared.mjs 里真实存在**：
 * 契约若只在注释里成立，B4 迁移到一半就会发现缺接口，那时只能临时新造——正是本轮要消除的。
 */
test('会话态最小接口：表里的既有读法真实存在，且语义就是声明的那个', async () => {
  // 1) durable 事件快照：正式 API 是 snapshotEvents()；缺失 = 空日志（**不得**回退读旧 events 数组）。
  assert.deepEqual(sessionEvents(undefined), [], '无会话 = 空日志')
  assert.deepEqual(sessionEvents({}), [], '缺 snapshotEvents 接口 = 空日志')
  assert.deepEqual(sessionEvents({ events: [{ type: 'user/message' }] }), [],
    '只有旧 events 数组时也不读它（回退读法已废弃）')
  assert.deepEqual(sessionEvents({ snapshotEvents: () => 'not-an-array' }), [], '非数组快照 = 空日志')
  const events = [{ type: 'user/message' }]
  assert.equal(sessionEvents({ snapshotEvents: () => events }), events, '返回值即快照本身（只读，不复制）')

  // 2) 子代理判定：唯一判据是 header.delegationDepth > 0。
  assert.equal(isDelegated({ header: { delegationDepth: 1 } }), true)
  assert.equal(isDelegated({ header: { delegationDepth: 0 } }), false)
  assert.equal(isDelegated({ header: {} }), false, '未声明深度 = 主会话')
  assert.equal(isDelegated({}), false)
  assert.equal(isDelegated(undefined), false, '无会话不抛错')

  // 3) 「不写字面量比较」这条纪律要真的等价：deliberation-gate / progress-reminder 的
  //    `(session.header?.delegationDepth ?? 0) === 0` 与 `!isDelegated(session)` 逐例同结果。
  const literalGate = (session) => (session?.header?.delegationDepth ?? 0) === 0
  const cases = [undefined, {}, { header: {} }, { header: { delegationDepth: 0 } },
    { header: { delegationDepth: 1 } }, { header: { delegationDepth: 2 } }]
  const observed = cases.map((session) => [literalGate(session), !isDelegated(session)])
  assert.deepEqual(observed, [
    [true, true], [true, true], [true, true], [true, true], [false, false], [false, false],
  ], '既有字面量比较与 isDelegated 逐例一致（迁移到后者不改变行为）')

  // 4) 会话态 Map 上限：超出即整体清空（触发一次冷扫重建，不是丢弃最旧条目）。
  assert.equal(MAX_TRACKED_SESSIONS, 4096)
  assert.equal(typeof sessionMapGet, 'function', 'B4 迁移的会话态记账入口就是这个')
  const map = new Map([['s-1', { n: 1 }]])
  assert.equal(sessionMapGet(map, 's-1', () => ({ n: 0 })).n, 1, '已有条目原样返回')
  assert.deepEqual(sessionMapGet(map, 's-2', () => ({ n: 0 })), { n: 0 }, '缺失时按工厂创建')
  assert.equal(map.has('s-2'), true, '创建后写入 map')

  // 5) 轮号没有共享读法（各模块内联 event.data.turn）——只钉住「有限 number 才算有轮号」这条共同语义。
  const turnOf = (event) => {
    const turn = event?.data?.turn
    return typeof turn === 'number' && Number.isFinite(turn) ? turn : undefined
  }
  assert.equal(turnOf({ data: { turn: 3 } }), 3)
  assert.equal(turnOf({ data: { turn: NaN } }), undefined, 'NaN 不算轮号')
  assert.equal(turnOf({ data: { turn: Infinity } }), undefined, 'Infinity 不算轮号')
  assert.equal(turnOf({ data: { turn: '3' } }), undefined, '字符串不算轮号')
  assert.equal(turnOf({}), undefined, '无 data 不抛错')
  const shared = await import('../../engine/shared.mjs')
  assert.equal(shared.turnOf, undefined, 'shared 尚未提供 turnOf：契约表如此声明，B4 不得假定它存在')
})
