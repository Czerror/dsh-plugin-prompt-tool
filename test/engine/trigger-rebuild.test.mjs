/**
 * PLAN T3 → B7 T3 ——「用声明重建被删能力」的**声明侧**语义与编排层验收。
 *
 * 覆盖两个能力：
 *   - `tool-filter`（名单判断 + 剔工具动作）→ `createNameListPredicate` + 装配过滤；
 *   - `deliberation-gate`（计数判断 + deny 动作）→ `createCountPredicate({ of: 'assistant-chars',
 *     per: 'turn' })` + 决策形状。
 *
 * B7 T3 把原模块 `engine/{tool-filter,deliberation-gate}.mjs` 与同名组合源一并删除（其行为改由
 * 预设顶层 `triggers` 段的声明表达）。T3 之前本文件是「声明 vs 原模块」的编排层对拍；对拍的
 * 那一半已无对象可对，随模块退场，留下的是**声明路径自己**的编排契约：同通道多触发器的串联、
 * 未命中即放行、动作形状，以及两条已知边界的显式记录。
 *
 * **本文件刻意不走 `actions.mjs` 的 `registerAction`**：T3 的对象是「编排层」（声明校验 →
 * 同通道排序 → 判定 → 命中才执行 → 降级），动作与既有实现的逐条对拍由 `actions.test.mjs` 覆盖。
 *
 * ## 已知边界（与 PLAN 的「实施取舍」一致，不得当成等价）
 *
 * 「每轮最多 deny `maxGatesPerTurn` 次」是**跨调用的预算状态**，纯计数谓词表达不了：本文件
 * 用最后一条用例**显式钉住**重复判定时的差异（声明必须自带 `maxPerTurn` 预算才等价），
 * 不假装它不存在。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountTriggers } from '../../engine/trigger.mjs'
import { createNameListPredicate, createCountPredicate } from '../../engine/predicates.mjs'

/** 记录型 ctx：只实现挂载期需要的面。 */
function recordingCtx(services = {}) {
  const events = []
  return {
    ctx: {
      on(event, handler, options) {
        events.push({ event, handler, options })
        return () => events.splice(events.findIndex((entry) => entry.handler === handler), 1)
      },
      get: (name) => services[name],
    },
    events,
  }
}

const handlerOf = (events, event) => {
  const entry = events.find((item) => item.event === event)
  assert.ok(entry, `应注册 ${event} 监听器`)
  return entry.handler
}

/** `system-prompt/assemble`：`(assembly, context, next)`，waterfall 用 await 串联。 */
const assemble = (events, assembly, context) =>
  handlerOf(events, 'system-prompt/assemble')(assembly, context, async () => assembly)

/**
 * `tools/pre-execute`：`(exec, next)`。
 *
 * `mountTriggers` 在同一通道上**为每个触发器各注册一个 handler**，真实宿主把它们当
 * waterfall 串联（前一个的 `next()` 就是后一个）。这里按注册顺序照做，并把最终返回值
 * 收集起来——单发第一个 handler 会漏掉后声明的触发器。
 */
const preExecute = async (events, exec) => {
  const handlers = events.filter((item) => item.event === 'tools/pre-execute').map((item) => item.handler)
  assert.ok(handlers.length > 0, '应注册 tools/pre-execute 监听器')
  const returned = []
  const run = async (index) => {
    if (index >= handlers.length) return undefined
    const value = await handlers[index](exec, () => run(index + 1))
    if (value !== undefined) returned.push(value)
    return value
  }
  const final = await run(0)
  return returned.length > 0 ? returned[returned.length - 1] : final
}

const tool = (name) => ({ name, description: `tool ${name}`, parameters: { type: 'object', properties: {} } })
const assemblyOf = (tools) => ({ sections: [], contexts: [], tools, variables: {} })
const agent = (depth, id) => ({ session: { id, header: { delegationDepth: depth } }, options: { model: 'deepseek-chat' } })
const namesOf = (tools) => tools.map((item) => item.name).join(',')

// ───────────────────────── 一、tool-filter 的声明重建 ─────────────────────────

/** 一条声明即整套过滤：谓词决定「谁留下」，动作按同一名单改写装配。 */
const maskDeclaration = (mask) => ({
  id: 'tool-mask',
  channel: 'system-prompt/assemble',
  when: createNameListPredicate(mask),
  do: (assembled) => ({
    ...assembled,
    tools: (Array.isArray(assembled.tools) ? assembled.tools : []).filter((item) => createNameListPredicate(mask)(item)),
  }),
})

test('重建 tool-filter：只剔名单内工具，装配的其它字段原样保留', async () => {
  const c = recordingCtx()
  mountTriggers(c.ctx, [maskDeclaration({ deny: ['web_search'] })], { plugin: 'rebuild' })

  const start = {
    ...assemblyOf([tool('read'), tool('web_search')]),
    sections: [{ name: 'keep-me', text: 'X' }],
    variables: { a: 1 },
  }
  const result = await assemble(c.events, start, { agent: agent(0, 'm') })
  assert.deepEqual(result.tools.map((item) => item.name), ['read'], '只剔名单内的工具')
  assert.deepEqual(result.sections, start.sections, '装配的其它字段原样保留')
  assert.deepEqual(result.variables, start.variables)
})

/** 未命中时声明路径必须原样放行——过滤逻辑不该在「名单外」的分支上改变装配。 */
test('重建 tool-filter：谓词未命中的目录原样返回', async () => {
  const c = recordingCtx()
  mountTriggers(c.ctx, [maskDeclaration({ allow: ['read'] })], { plugin: 'rebuild' })
  const start = assemblyOf([tool('read')])
  const result = await assemble(c.events, start, { agent: agent(0, 'm') })
  assert.equal(namesOf(result.tools), 'read')
})

// ───────────────────────── 二、deliberation-gate 的声明重建 ─────────────────────────

const GATE_TEXT = '先说明你的计划，再调用工具'

/**
 * 把 `tools/pre-execute` 的 payload（`exec`）适配成 `createCountPredicate` 认得的形状。
 *
 * 谓词读 `payload?.session ?? payload`（见 `predicates.mjs` 的取值表），而工具通道传的是
 * `exec`（会话在 `exec.agent.session`）——这是两类通道之间**唯一**需要适配的地方，
 * 属调用方职责，不应为它给谓词加第二个约定。
 */
const countIn = (options) => {
  const predicate = createCountPredicate(options)
  return (exec) => predicate({ session: exec?.agent?.session })
}

const sessionWith = (events, id = 's-1') => ({ id, header: { delegationDepth: 0 }, snapshotEvents: () => events })

/**
 * 声明路径重建深思门：两条互斥触发器。
 *
 * 现实路径把「子代理不门控」写成提前返回；这里改成**主会话并集**——两条都要求深度为 0，
 * 于是主会话恰好命中一条、子代理一条都不命中（放行），且不必引入第二套「跳过」语义。
 */
const gateDeclarations = (options, onDeny) => [
  {
    id: 'deep-enough',
    channel: 'tools/pre-execute',
    channelOrder: 0,
    when: (exec) => exec?.agent?.session?.header?.delegationDepth === 0
      && countIn({ of: 'assistant-chars', per: 'turn', min: options.minChars })(exec),
    do: () => {},                 // 达标 = 不干预
  },
  {
    id: 'not-deep-enough',
    channel: 'tools/pre-execute',
    channelOrder: 1,
    when: (exec) => exec?.agent?.session?.header?.delegationDepth === 0
      && !countIn({ of: 'assistant-chars', per: 'turn', min: options.minChars })(exec),
    do: () => onDeny(),
  },
]

/** 深度判定的期望值：本轮（`turn`）assistant 文本长度 ≥ minChars 即放行。 */
const MIN_CHARS = 50
const TURN = 1
const message = (chars, at = TURN) => ({
  type: 'assistant/message',
  data: { turn: at, message: { content: [{ type: 'text', text: 'x'.repeat(chars) }] } },
})

test('重建 deliberation-gate：计数判断 + deny 动作（含轮边界与闭区间）', async () => {
  // gated = 「深度不足 → 不达标那条声明命中并 deny」。
  const cases = [
    [[], true],                                   // 无文本 = 深度 0 → 不足
    [[message(10)], true],                        // 低于下限
    [[message(49)], true],                        // 差一个字符
    [[message(50)], false],                       // 恰好达标（min 是闭区间）→ 不干预
    [[message(200)], false],                      // 远超 → 不干预
    [[message(10), message(60)], false],           // 同一轮累计达标
    [[message(200, 0), { type: 'turn/start', data: { turn: TURN } }], true],  // 跨轮：上一轮不计入本轮
  ]

  for (const [events, gated] of cases) {
    const declared = recordingCtx()
    let decided
    mountTriggers(declared.ctx, gateDeclarations({ minChars: MIN_CHARS }, () => { decided = { kind: 'deny', reason: GATE_TEXT } }), { plugin: 'rebuild' })
    await preExecute(declared.events, { agent: { session: sessionWith(events) } })

    assert.equal(decided !== undefined, gated, `事件 ${JSON.stringify(events)} 下是否 deny`)
    if (gated) assert.equal(decided.reason, GATE_TEXT, '拒绝文案逐字来自声明（规划提示而非工具失败）')
  }
})

test('重建 deliberation-gate：子代理不门控——深度条件不命中即放行（无需第二套跳过语义）', async () => {
  // 子代理会话：深度 1 且无任何 assistant 文本（判定若不看深度就会 deny）。
  const child = { id: 'child', header: { delegationDepth: 1 }, snapshotEvents: () => [] }

  const declared = recordingCtx()
  let decided
  mountTriggers(declared.ctx, gateDeclarations({ minChars: MIN_CHARS }, () => { decided = { kind: 'deny' } }), { plugin: 'rebuild' })
  await preExecute(declared.events, { agent: { session: child } })
  assert.equal(decided, undefined, '声明路径：深度谓词不命中 → 不干预')
})

test('重建 deliberation-gate：去掉深度条件即对所有 agent 生效（显式开启子代理门控的写法）', async () => {
  const child = { id: 'child', header: { delegationDepth: 1 }, snapshotEvents: () => [] }

  const declared = recordingCtx()
  let decided
  mountTriggers(declared.ctx, [{
    id: 'gate-any-depth',
    channel: 'tools/pre-execute',
    when: (exec) => !countIn({ of: 'assistant-chars', per: 'turn', min: MIN_CHARS })(exec),
    do: () => { decided = { kind: 'deny', reason: GATE_TEXT } },
  }], { plugin: 'rebuild' })
  await preExecute(declared.events, { agent: { session: child } })
  assert.equal(decided?.kind, 'deny', '不带深度条件即对所有 agent 生效')
  assert.equal(decided.reason, GATE_TEXT)
})

test('已知边界：每轮重复判定时纯计数谓词给不出 maxGatesPerTurn 预算（显式记录差异）', async () => {
  const session = sessionWith([message(1)])   // 短文本 = 未达标

  const declared = recordingCtx()
  let hits = 0
  mountTriggers(declared.ctx, [{
    id: 'gate',
    channel: 'tools/pre-execute',
    // 与门同向：**不达标**时才动作（`chars < minChars` ↔ `!countIn({ min })`）。
    when: (exec) => !countIn({ of: 'assistant-chars', per: 'turn', min: MIN_CHARS })(exec),
    do: () => { hits += 1 },
  }], { plugin: 'rebuild' })
  await preExecute(declared.events, { agent: { session } })
  await preExecute(declared.events, { agent: { session } })
  assert.equal(hits, 2, '声明路径命中两次 —— 每轮一次的预算必须由声明的动作侧 `maxPerTurn` 携带')
})
