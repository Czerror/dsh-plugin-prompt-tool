/**
 * B7 T1 —— 谓词载荷归一（`subjectOf`）的契约，以及「相位 / 计数不再退化」的行为证据。
 *
 * 这一层为什么必须存在：谓词契约是**单个载荷对象**（`predicates.mjs` 头部），而事件
 * 处理器收到的是**参数表**。归一化之前两条挂载路径都是 `when(...payload)`，于是除
 * `names`（`tools/pre-execute` 的第一个实参恰好是 `exec`）外，各原语在真实通道上都取不到
 * 它们要的域——`phase` 恒为「已晋升」（`compaction-epoch.mjs` 的 `status(undefined)`
 * → `promoted: true`）、`count` 恒 0。
 *
 * 本文件用**真机形状**的载荷把「修好之后真的按会话判定」钉成断言。形状来源：
 *   - `tools/pre-execute`：`(exec, next)`，`exec = { name, agent, … }` —— `actions.mjs:354`
 *     的签名与 `:499` 的 `exec?.agent?.session?.header?.delegationDepth`；
 *   - `system-prompt/assemble`：`(assembly, context, next)`，agent 在**第二个**实参 ——
 *     `actions.mjs:303` 的签名，以及（原 `context-gate` 的等价声明）
 *     `test/engine/declarations/context-gate.yml` 路径 (a) 的 `context.agent` 取值链；
 *   - `agent/inbox/inserted`：`({ agent, message })` —— `actions.mjs:600` 的解构。
 *   - 官方 `Agent` 接口只有 `id`（`deepseek-harness/packages/core/agent/src/types.ts:13-16`，
 *     注释明写运行时面 augment），所以判据**不能靠猜字段**，见下方「标记」一组。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createCountPredicate,
  createNameListPredicate,
  createPhasePredicate,
  createSessionStatePredicate,
  createSourcePredicate,
  createTextPredicate,
  subjectOf,
} from '../../engine/predicates.mjs'

/** 有 durable 事件的会话（`sessionEvents` 读 `snapshotEvents`）。 */
const sessionWith = (...events) => ({
  id: 's-1',
  header: {},
  snapshotEvents: () => events,
})

test('subjectOf：真实通道载荷按共享 helper 提取五类匹配文本', () => {
  const content = [{ type: 'text', text: 'MATCH' }]
  const agent = { session: sessionWith({ type: 'assistant/message', data: { content } }) }
  const cases = [
    ['tools/pre-execute', [{ agent, arguments: { command: 'MATCH' } }], 'toolArgs'],
    ['tools/post-execute', [{ agent, arguments: {} }, { content }], 'toolResult'],
    ['agent/pre-step', [{ agent, messages: [{ role: 'user', content }] }], 'userMessage'],
    ['agent/inbox/inserted', [{ agent, message: { role: 'user', content } }], 'userMessage'],
    ['agent/turn-stopping', [{ agent }], 'assistantText'],
    ['subagent/start', [{ id: 'child', prompt: 'MATCH' }], 'subagentInfo'],
    ['subagent/end', [{ id: 'child', result: 'MATCH' }], 'subagentInfo'],
  ]
  for (const [channel, payload, subject] of cases) {
    assert.equal(createTextPredicate({ subject, keys: ['MATCH'] })(subjectOf(channel, payload)), true, channel)
    assert.equal(createTextPredicate({ subject, keys: ['MISSING'] })(subjectOf(channel, payload)), false, channel)
  }
})

// ───────────────────────── 通道取法表 ─────────────────────────

test('subjectOf：已知通道按通道取 agent，且保留第一个实参的顶层字段', () => {
  const agent = { id: 'a-1' }
  // tools/pre-execute：agent 在第一个实参（exec）里，name 也来自它。
  const exec = subjectOf('tools/pre-execute', [{ name: 'bash', agent, signal: 'sig' }])
  assert.equal(exec.agent, agent)
  assert.equal(exec.name, 'bash')
  assert.equal(exec.signal, 'sig', '第一个实参的字段原样保留（旧形态继续可见）')
  assert.equal(exec.channel, 'tools/pre-execute')

  // system-prompt/assemble：agent 在**第二个**实参（context）里——这是此前的失效点。
  const assembled = subjectOf('system-prompt/assemble', [{ sections: [], tools: [] }, { agent }])
  assert.equal(assembled.agent, agent)
  assert.deepEqual(assembled.tools, [], 'assembly 的字段同样保留')

  // agent/inbox/inserted：agent 在第一个实参，source 来自 message。
  const inserted = subjectOf('agent/inbox/inserted', [{ agent, message: { source: { kind: 'user' } } }])
  assert.equal(inserted.agent, agent)
  assert.deepEqual(inserted.source, { kind: 'user' })
})

test('subjectOf：未知通道退回旧语义并告警一次（不静默、不抛）', () => {
  const warnings = []
  const first = subjectOf('some/new-channel', [{ agent: { id: 'a' } }], (text) => warnings.push(text))
  assert.equal(first.agent?.id, 'a', '第一个实参的字段仍在载荷顶层')
  assert.equal(warnings.length, 1, '未知通道告警一次')
  subjectOf('some/new-channel', [{}], (text) => warnings.push(text))
  assert.equal(warnings.length, 1, '同一通道不重复告警（判定期不刷屏）')
  assert.doesNotThrow(() => subjectOf('another/new-channel', []), '无 warn 回调时不抛')
})

// ───────────────────────── 修复的行为证据 ─────────────────────────

test('phase：真实 exec 形状下按会话判定（修复前恒为「已晋升」）', () => {
  const predicate = createPhasePredicate({ promoteOn: 'either', subscribe: false })
  const fresh = subjectOf('tools/pre-execute', [{ name: 'bash', agent: { session: sessionWith() } }])
  assert.equal(predicate(fresh), false, '无 durable 晋升事件 = 未晋升')

  const promoted = subjectOf('tools/pre-execute', [{
    name: 'bash',
    agent: { session: sessionWith({ type: 'tool/call', seq: 1 }) },
  }])
  assert.equal(predicate(promoted), true, '有 tool/call = 已晋升')

  // 同一判定在 assembly 通道（agent 在第二个实参）上同样成立。
  const onAssemble = subjectOf('system-prompt/assemble', [{}, { agent: { session: sessionWith() } }])
  assert.equal(predicate(onAssemble), false, 'assembly 通道不得再恒为「已晋升」')
})

test('count / session：真实 exec 形状下真的读到会话事件（修复前恒 0 / 恒真）', () => {
  const calls = [
    { type: 'tool/call', seq: 1 },
    { type: 'tool/call', seq: 2 },
    { type: 'tool/call', seq: 3 },
  ]
  const exec = subjectOf('tools/pre-execute', [{ name: 'bash', agent: { session: sessionWith(...calls) } }])
  assert.equal(createCountPredicate({ of: 'tool-call', per: 'session', min: 3 })(exec), true, '计数应为 3')
  assert.equal(createCountPredicate({ of: 'tool-call', per: 'session', min: 4 })(exec), false, '计数不该恒真')

  const fresh = subjectOf('tools/pre-execute', [{ agent: { session: sessionWith() } }])
  assert.equal(createCountPredicate({ of: 'tool-call', per: 'session', min: 1 })(fresh), false, '无事件 = 0')

  const session = sessionWith({ type: 'user/message', seq: 1 })
  const inbox = subjectOf('agent/inbox/inserted', [{ agent: { session }, message: {} }])
  assert.equal(createSessionStatePredicate({ type: 'user/message', present: true })(inbox), true)
  assert.equal(createSessionStatePredicate({ type: 'user/message' })(inbox), false, 'present 缺省为「尚无」')
})

test('旧形态仍然成立：直接传 payload / agent 的手写调用方不受归一化影响', () => {
  // 归一化之前就存在的两种调用形态：谓词收到的是**单个对象**而不是参数表。
  const session = sessionWith({ type: 'user/message', seq: 1 })
  assert.equal(createSessionStatePredicate({ type: 'user/message', present: true })({ session }), true,
    '旧形态：payload.session')
  assert.equal(createCountPredicate({ of: 'user-message', per: 'session', min: 1 })({ session }), true)

  // 旧形态的 agent：官方 `Agent` 接口只保证 `id`，所以这里刻意用**没有 session 的对象**，
  // 钉住「判据靠显式标记而不是猜字段」——曾经按 `.session` 判断，把这种形状误判成归一化载荷。
  const bare = { id: 'a-1', ctx: {} }
  assert.doesNotThrow(() => createPhasePredicate({ subscribe: false })(bare))
  assert.equal(createNameListPredicate({ deny: ['bash'] })('bash'), false, '字符串载荷仍是名单判定的合法形态')
  assert.equal(createSourcePredicate({ kind: 'user' })({ source: { kind: 'user' } }), true, '旧形态：payload.source')
})

test('count：every 是节奏判据（每 N 次命中一次），且第 0 次不命中', () => {
  // 依据「每 N 次命中一次」的节奏语义（原 `progress-reminder` 的 `results % every === 0`，
  // 声明侧见 `test/engine/declarations/progress-reminder.yml` 的 `count.every` + `includeCurrent`）：
  // 那里的计数是**自增后**的，所以第 0 次不能算命中（否则 `0 % N === 0` 会在会话开头就滴一条）。
  const session = sessionWith(
    { type: 'tool/result', seq: 1 },
    { type: 'tool/result', seq: 2 },
    { type: 'tool/result', seq: 3 },
  )
  const exec = subjectOf('tools/post-execute', [{ name: 'bash', agent: { session } }])
  assert.equal(createCountPredicate({ of: 'tool-result', per: 'session', every: 4 })(exec), false, '3 次不是 4 的倍数')

  // `includeCurrent` 让「本次」计入：3 条已落盘 + 本次 = 4 → 命中（这正是计数时点对齐的用途）。
  assert.equal(createCountPredicate({ of: 'tool-result', per: 'session', every: 4, includeCurrent: true })(exec), true)

  // 空会话：count = 0，every 必须不命中（第 0 次不是节奏点）。
  const empty = subjectOf('tools/post-execute', [{ agent: { session: sessionWith() } }])
  assert.equal(createCountPredicate({ of: 'tool-result', per: 'session', every: 1 })(empty), false, '0 次不命中')

  // 校验：every 必须是正整数；三者至少要有一个，否则是「恒真」的配置错误。
  assert.throws(() => createCountPredicate({ of: 'tool-call', every: 0 }), /every must be a positive integer/)
  assert.throws(() => createCountPredicate({ of: 'tool-call' }), /needs min, max or every/)
})

test('phase：promoted 三态让 C ∧ ¬P 可表达（tool-bootstrap 压缩回退的判据）', () => {
  // 合取时代可表达的原子只有 P、C∧P、¬C∧P，三者在 ¬P 的会话上全为 false，于是
  // any/all/not/notAny 的任何组合都写不出「压缩过且未晋升」——原 tool-bootstrap 的
  // compaction 回退声明（`test/engine/declarations/tool-bootstrap.yml` 声明 2）要的正是它。
  const session = sessionWith({ type: 'compaction/end', data: {}, seq: 1 })
  const payload = subjectOf('system-prompt/assemble', [{}, { agent: { session } }])
  const base = { promoteEvents: ['tool/call'], subscribe: false }

  assert.equal(createPhasePredicate({ ...base, compacted: true, promoted: false })(payload), true, 'C ∧ ¬P 成立')
  assert.equal(createPhasePredicate({ ...base, compacted: true })(payload), false, '缺省 promoted: true → C∧P 不成立')
  assert.equal(createPhasePredicate({ ...base, compacted: true, promoted: 'ignore' })(payload), true, "promoted: 'ignore' 只看 compacted")
  assert.equal(createPhasePredicate({ ...base, compacted: false })(payload), false, '未压缩过时 compacted: false 才成立')

  // 恒真配置与非法值都在挂载期 fail loud。
  assert.throws(() => createPhasePredicate({ ...base, promoted: 'yes' }), /promoted must be true, false or 'ignore'/)
  assert.throws(() => createPhasePredicate({ ...base, promoted: 'ignore' }), /needs compacted/)
})
