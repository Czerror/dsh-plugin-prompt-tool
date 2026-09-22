/**
 * PLAN T3 验收条款 (a) ——「用声明重建现有能力，并与现有模块在同一组输入下输出相同」。
 *
 * 覆盖两个现有能力：
 *   - `tool-filter`（名单判断 + 剔工具动作）→ `createNameListPredicate` + 装配过滤；
 *   - `deliberation-gate`（计数判断 + deny 动作）→ `createCountPredicate({ of: 'assistant-chars',
 *     per: 'turn' })` + 决策形状。
 *
 * **本文件刻意不走 `actions.mjs` 的 `registerAction`**：T3 的对拍对象是「编排层」
 * （声明校验 → 同通道排序 → 判定 → 命中才执行 → 降级），而「动作与既有实现逐条对拍」
 * 已由 T2 的 `actions.test.mjs`（37 例）覆盖。两层各测各的，避免同一条等式被断言两遍
 * 却都不完整。
 *
 * ## 已知边界（与 T3 PLAN 的「实施取舍」一致，不得当成等价）
 *
 * `deliberation-gate` 的「每轮最多 deny `maxGatesPerTurn` 次」是**跨调用的预算状态**，
 * 纯计数谓词表达不了：本文件用「每轮只判定一次」对齐前者，再用最后一条用例**显式钉住**
 * 重复判定时的差异，不假装它不存在。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountTriggers } from '../../engine/trigger.mjs'
import { createNameListPredicate, createCountPredicate } from '../../engine/predicates.mjs'
import { apply as applyToolFilter } from '../../engine/tool-filter.mjs'
import { apply as applyDeliberationGate } from '../../engine/deliberation-gate.mjs'
import { compositionConfig } from '../fixtures/composition-defaults.mjs'

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
 * 收集起来——单发第一个 handler 会漏掉后声明的触发器（本文件最初就踩了这个坑）。
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

// ───────────────────────── 一、重建 tool-filter ─────────────────────────

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

test('重建 tool-filter：名单判断 + 剔工具动作，与现有模块在同输入下逐条同结果', async () => {
  const masks = [
    { allow: ['read', 'bash'] },
    { deny: ['bash'] },
    { allow: ['read', 'bash'], deny: ['bash'] },   // deny 在 allow 内再剔除
    { allow: [] },                                  // 显式空数组 = 已声明：一个都不通过
    { deny: [] },                                   // 显式空数组 = 已声明：一个都不拦
  ]
  const catalogs = [
    ['read', 'bash', 'web_search'],
    ['read'],
    ['bash'],
    [],
    ['READ', 'bash'],
  ]

  for (const mask of masks) {
    const existing = recordingCtx()
    applyToolFilter(existing.ctx, { ...compositionConfig('tool-filter'), enabled: true, ...mask })
    const declared = recordingCtx()
    mountTriggers(declared.ctx, [maskDeclaration(mask)], { plugin: 'rebuild' })

    for (const names of catalogs) {
      const start = assemblyOf(names.map(tool))
      const context = { agent: agent(0, 'm') }
      const fromExisting = await assemble(existing.events, start, context)
      const fromDeclared = await assemble(declared.events, start, context)
      assert.equal(namesOf(fromDeclared.tools), namesOf(fromExisting.tools),
        `名单 ${JSON.stringify(mask)} 下目录 ${JSON.stringify(names)} 应同结果`)
    }
  }
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

// ───────────────────────── 二、重建 deliberation-gate ─────────────────────────

const GATE_TEXT = '先说明你的计划，再调用工具'
const gateConfig = (over = {}) => ({ ...compositionConfig('deliberation-gate'), enabled: true, gateText: GATE_TEXT, ...over })

/** 当前轮 assistant 文本长度（与 deliberation-gate 同算：只读 message.content）。 */
const depthIn = (events, turn) => {
  let chars = 0
  for (const event of events) {
    if (event.type !== 'assistant/message' || event.data?.turn !== turn) continue
    const content = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
    chars += content.map((block) => (typeof block === 'string' ? block : (block?.text ?? ''))).join(' ').trim().length
  }
  return chars
}

const sessionWith = (events, id = 's-1') => ({ id, header: { delegationDepth: 0 }, snapshotEvents: () => events })

/**
 * 把 `tools/pre-execute` 的 payload（`exec`）适配成 `createCountPredicate` 认得的形状。
 *
 * 谓词读 `payload?.session ?? payload`（见 `predicates.mjs:352`），而工具通道传的是
 * `exec`（会话在 `exec.agent.session`）——这是两类通道之间**唯一**需要适配的地方，
 * 属调用方职责，不应为它给谓词加第二个约定。
 */
const countIn = (options) => {
  const predicate = createCountPredicate(options)
  return (exec) => predicate({ session: exec?.agent?.session })
}

/**
 * 声明路径重建深思门：两条互斥触发器。
 *
 * 现实路径把「子代理不门控」写成提前返回；这里改成**主会话并集**——两条都要求深度为 0，
 * 于是主会话恰好命中一条、子代理一条都不命中，与现有模块的 `next()` 放行同结果，
 * 且不必引入第二套「跳过」语义。
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

test('重建 deliberation-gate：计数判断 + deny 动作，与现有模块在同输入下逐条同裁决', async () => {
  const options = { minChars: 50, maxGatesPerTurn: 1 }
  const turn = 1
  const message = (chars, at = turn) => ({
    type: 'assistant/message',
    data: { turn: at, message: { content: [{ type: 'text', text: 'x'.repeat(chars) }] } },
  })
  const cases = [
    [],                                   // 无文本 = 深度 0
    [message(10)],                        // 低于下限
    [message(49)],                        // 差一个字符
    [message(50)],                        // 恰好达标（min 是闭区间）
    [message(200)],                       // 远超
    [message(10), message(60)],           // 同一轮累计达标
    [message(200, 0), { type: 'turn/start', data: { turn } }],   // 跨轮：上一轮不计入本轮
  ]

  for (const events of cases) {
    const session = sessionWith(events)
    const existing = recordingCtx()
    applyDeliberationGate(existing.ctx, gateConfig(options))
    const expected = await preExecute(existing.events, { agent: { session } })

    const declared = recordingCtx()
    let decided
    mountTriggers(declared.ctx, gateDeclarations(options, () => { decided = { kind: 'deny', reason: GATE_TEXT } }), { plugin: 'rebuild' })
    await preExecute(declared.events, { agent: { session } })

    const depth = depthIn(events, turn)
    assert.equal(decided?.kind ?? 'pass', expected?.kind ?? 'pass',
      `深度 ${depth}（阈值 ${options.minChars}）下裁决应相同`)
    if (expected?.kind === 'deny') {
      assert.equal(decided.reason, expected.reason, '拒绝文案逐字相同（规划提示而非工具失败）')
    }
  }
})

test('重建 deliberation-gate：子代理不门控——两条路径都放行（声明用「主会话并集」而非第二套跳过语义）', async () => {
  const options = { minChars: 50, maxGatesPerTurn: 1 }
  // 子代理会话：深度 1 且无任何 assistant 文本（判定若不看深度就会 deny）。
  const child = { id: 'child', header: { delegationDepth: 1 }, snapshotEvents: () => [] }

  const existing = recordingCtx()
  applyDeliberationGate(existing.ctx, gateConfig(options))
  assert.equal(await preExecute(existing.events, { agent: { session: child } }), undefined, '现有模块：子代理直接放行')

  const declared = recordingCtx()
  let decided
  mountTriggers(declared.ctx, gateDeclarations(options, () => { decided = { kind: 'deny' } }), { plugin: 'rebuild' })
  await preExecute(declared.events, { agent: { session: child } })
  assert.equal(decided, undefined, '声明路径：深度谓词不命中 → 不干预')
})

test('重建 deliberation-gate：includeSubagents=true 时两路都门控子代理', async () => {
  const options = { minChars: 50, maxGatesPerTurn: 1, includeSubagents: true }
  const child = { id: 'child', header: { delegationDepth: 1 }, snapshotEvents: () => [] }

  const existing = recordingCtx()
  applyDeliberationGate(existing.ctx, gateConfig(options))
  const expected = await preExecute(existing.events, { agent: { session: child } })
  assert.equal(expected?.kind, 'deny', '现有模块：显式开启后子代理同样受门')

  const declared = recordingCtx()
  let decided
  mountTriggers(declared.ctx, [{
    id: 'gate-any-depth',
    channel: 'tools/pre-execute',
    when: (exec) => exec?.agent?.session?.header?.delegationDepth === 1
      && !countIn({ of: 'assistant-chars', per: 'turn', min: options.minChars })(exec),
    do: () => { decided = { kind: 'deny', reason: GATE_TEXT } },
  }], { plugin: 'rebuild' })
  await preExecute(declared.events, { agent: { session: child } })
  assert.equal(decided?.kind, 'deny', '声明路径：不带深度条件即对所有 agent 生效（与显式开启同结果）')
  assert.equal(decided.reason, expected.reason)
})

test('已知边界：每轮重复判定时纯计数谓词给不出 maxGatesPerTurn 预算（显式记录差异）', async () => {
  const options = { minChars: 50, maxGatesPerTurn: 1 }
  const events = [{
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'text', text: '短' }] } },
  }]
  const session = sessionWith(events)

  const existing = recordingCtx()
  applyDeliberationGate(existing.ctx, gateConfig(options))
  const first = await preExecute(existing.events, { agent: { session } })
  const second = await preExecute(existing.events, { agent: { session } })
  assert.equal(first?.kind, 'deny', '现有模块：首次判定 deny')
  assert.equal(second, undefined, '现有模块：本轮预算用完 → 第二次放行')

  const declared = recordingCtx()
  let hits = 0
  mountTriggers(declared.ctx, [{
    id: 'gate',
    channel: 'tools/pre-execute',
    // 与现有模块同向：**不达标**时才动作（`chars < minChars` ↔ `!countIn({ min })`）。
    when: (exec) => !countIn({ of: 'assistant-chars', per: 'turn', min: options.minChars })(exec),
    do: () => { hits += 1 },
  }], { plugin: 'rebuild' })
  await preExecute(declared.events, { agent: { session } })
  await preExecute(declared.events, { agent: { session } })
  assert.equal(hits, 2, '声明路径命中两次 —— 与现有模块的「每轮一次」不等价，B7 的声明必须携带预算状态')
})
