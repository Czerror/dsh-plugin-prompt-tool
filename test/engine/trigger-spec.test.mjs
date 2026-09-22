/**
 * B7 T1 —— `engine/trigger-spec.mjs`（声明编译器）的契约。
 *
 * 两件事必须钉死：
 *   1. **透传不改语义**：`{ <类别>: <选项> }` 编译出的谓词，与直接调
 *      `createXxxPredicate(<选项>)` 得到的行为**逐例相同**——声明层不翻译、不改名、不补默认。
 *   2. **写错就红**：未知字段、未知类别、混合声明、空节点、空动作数组一律编译期抛错。
 *      这套引擎的失败模式必须是「挂载期大声报错」，而不是「配了没效果」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  compileDeclaration,
  compileDeclarations,
  compileWhen,
  declarationRegistrationOptions,
  mountDeclarations,
} from '../../engine/trigger-spec.mjs'
import {
  createNameListPredicate,
  createSourcePredicate,
  createTextPredicate,
  createSessionStatePredicate,
  composite,
} from '../../engine/predicates.mjs'

// ───────────────────────── 透传等价 ─────────────────────────

test('compileWhen：单原语与原语直接构造逐例等价', () => {
  const cases = [
    ['names', { deny: ['bash'] }, createNameListPredicate({ deny: ['bash'] }),
      [{ name: 'bash' }, { name: 'read' }, 'bash', '', undefined]],
    ['text', { keys: ['foo'], logic: 'any' }, createTextPredicate({ keys: ['foo'], logic: 'any' }),
      ['foo bar', 'nope', '']],
    ['source', { kind: 'plugin' }, createSourcePredicate({ kind: 'plugin' }),
      [{ source: { kind: 'plugin' } }, { source: { kind: 'user' } }, {}]],
    ['session', { type: 'user/message' }, createSessionStatePredicate({ type: 'user/message' }),
      [{ session: { snapshotEvents: () => [] } }, { session: { snapshotEvents: () => [{ type: 'user/message' }] } }]],
  ]
  for (const [kind, options, direct, payloads] of cases) {
    const compiled = compileWhen({ [kind]: options })
    for (const payload of payloads) {
      assert.equal(compiled(payload), direct(payload), `${kind} @ ${JSON.stringify(payload)} 必须与原语一致`)
    }
  }
})

test('compileWhen：组合运算符与 composite 同源（含嵌套）', () => {
  const denyBash = { names: { deny: ['bash'] } }
  const payloads = [{ name: 'bash' }, { name: 'read' }]

  const anyNode = { any: [denyBash, { names: { deny: ['read'] } }] }
  const directAny = composite({ any: [createNameListPredicate({ deny: ['bash'] }), createNameListPredicate({ deny: ['read'] })] })
  for (const payload of payloads) assert.equal(compileWhen(anyNode)(payload), directAny(payload), 'any')

  const allNode = { all: [denyBash, { names: { deny: ['read'] } }] }
  for (const payload of payloads) {
    assert.equal(compileWhen(allNode)(payload),
      composite({ all: [createNameListPredicate({ deny: ['bash'] }), createNameListPredicate({ deny: ['read'] })] })(payload), 'all')
  }

  const notNode = { not: denyBash }
  for (const payload of payloads) assert.equal(compileWhen(notNode)(payload), !createNameListPredicate({ deny: ['bash'] })(payload), 'not')

  // 嵌套：any 里套 not——树形结构显式，优先级不靠隐式约定。
  const nested = { any: [{ not: denyBash }, { names: { deny: ['read'] } }] }
  for (const payload of payloads) {
    const expected = !createNameListPredicate({ deny: ['bash'] })(payload) || createNameListPredicate({ deny: ['read'] })(payload)
    assert.equal(compileWhen(nested)(payload), expected, '嵌套组合')
  }
})

test('compileWhen：省略 / null = 无条件（返回 undefined，注册侧据此跳过判定）', () => {
  assert.equal(compileWhen(undefined), undefined)
  assert.equal(compileWhen(null), undefined)
  assert.equal(compileWhen(undefined, { ctx: {} }), undefined)
})

// ───────────────────────── 写错就红 ─────────────────────────

test('compileWhen：未知类别 / 混合键 / 空节点 / 空数组一律编译期抛错', () => {
  assert.throws(() => compileWhen({ nope: {} }), /unknown predicate "nope"/)
  assert.throws(() => compileWhen({ any: [], all: [] }), /exactly one key/)
  assert.throws(() => compileWhen({}), /must not be an empty object/)
  assert.throws(() => compileWhen({ any: [] }), /non-empty array/)
  assert.throws(() => compileWhen([{ names: {} }]), /when must be an object/)
  assert.throws(() => compileWhen({ names: 42 }), /when\.names must be an object/)
  // 原语自身的严格性不被编译器放宽：空键集合仍在构造期 fail loud。
  assert.throws(() => compileWhen({ text: { keys: [] } }), /at least one non-empty key/)
})

test('compileDeclaration：未知字段 / 缺必填 / 非法枚举一律抛错', () => {
  const base = { id: 't', channel: 'system-prompt/assemble', do: { kind: 'assembly', target: { tools: { deny: ['bash'] } } } }
  assert.throws(() => compileDeclaration({ ...base, nope: 1 }), /unknown trigger field\(s\) nope/)
  assert.throws(() => compileDeclaration({ ...base, id: '' }), /id must be a non-empty string/)
  assert.throws(() => compileDeclaration({ ...base, channel: '' }), /channel must be a non-empty event name/)
  assert.throws(() => compileDeclaration({ ...base, do: undefined }), /do is required/)
  assert.throws(() => compileDeclaration({ ...base, channelOrder: -1 }), /channelOrder must be a non-negative safe integer/)
  assert.throws(() => compileDeclaration({ ...base, waterfallPosition: 'top' }), /waterfallPosition must be one of/)
  assert.throws(() => compileDeclaration({ ...base, phase: 'during' }), /phase must be one of/)
  assert.throws(() => compileDeclaration(null), /trigger declaration must be an object/)
})

test('compileDeclaration：do 必须是已知动作，可给多个（数组）', () => {
  const base = { id: 't', channel: 'system-prompt/assemble' }
  assert.throws(() => compileDeclaration({ ...base, do: { kind: 'nope' } }), /do\[0\]\.kind must be one of/)
  assert.throws(() => compileDeclaration({ ...base, do: [] }), /non-empty array/)
  assert.throws(() => compileDeclaration({ ...base, do: [42] }), /do\[0\] must be an action declaration object/)

  const one = compileDeclaration({ ...base, do: { kind: 'assembly', target: { tools: { deny: ['bash'] } } } })
  assert.equal(one.actions.length, 1)
  const two = compileDeclaration({
    ...base,
    do: [
      { kind: 'assembly', target: { tools: { deny: ['bash'] } } },
      { kind: 'sdk-strip', mask: { deny: ['bash'] } },
    ],
  })
  assert.deepEqual(two.actions.map((action) => action.kind), ['assembly', 'sdk-strip'], '数组按序保留')
})

for (const [channel, action, error] of [
  ['system-prompt/assemble', { kind: 'assembly', target: null }, /requires a target object/],
  ['system-prompt/assemble', { kind: 'assembly', target: { tools: { deny: 'bash' } } }, /deny must be an array/],
  ['system-prompt/assemble', { kind: 'guard', mask: { allow: [], deny: [] } }, /cannot combine allow with deny/],
  ['system-prompt/assemble', { kind: 'sdk-strip', mask: { deny: ['run_code'] } }, /reserved run_code/],
  ['tools/pre-execute', { kind: 'decision', phase: 'invalid' }, /phase must be one of pre, post/],
  ['tools/pre-execute', { kind: 'decision', decision: 'invalid' }, /decision must be one of/],
  ['tools/post-execute', { kind: 'decision', phase: 'post', action: 'invalid' }, /action must be one of/],
  ['tools/post-execute', { kind: 'append-context', text: 1 }, /text must be a string/],
  ['agent/request', { kind: 'request-params', patch: [] }, /patch must be an object/],
  ['agent/inbox/inserted', { kind: 'inbox-prepend', text: null }, /text must be a string/],
  ['agent/pre-step', { kind: 'pre-step-filter', sources: [], keepKinds: [] }, /cannot combine sources with keepKinds/],
]) {
  test(`compileDeclarations：保存前拒绝非法动作 ${JSON.stringify(action)}`, () => {
    assert.throws(() => compileDeclarations([{ id: 'invalid', channel, do: action }]), error)
  })
}

for (const action of [
  { kind: 'inject-text', config: { layer: 'system-section' } },
  { kind: 'guard', mask: { deny: ['bash'] } },
]) {
  for (const [options, extra, error] of [
    [{ when: { names: { allow: ['bash'] } } }, {}, /does not support a when predicate/],
    [{ waterfallPosition: 'outermost' }, {}, /does not support prepend/],
    [{}, { maxPerTurn: 1 }, /does not support maxPerTurn/],
  ]) {
    test(`compileDeclarations：保存前拒绝 ${action.kind} 不支持的选项 ${JSON.stringify({ ...options, ...extra })}`, () => {
      assert.throws(() => compileDeclarations([{
        id: 'unsupported', channel: 'system-prompt/assemble', ...options, do: { ...action, ...extra },
      }]), error)
    })
  }
}

test('compileDeclarations：保存前拒绝非法 maxPerTurn，包括同条声明的后续动作', () => {
  assert.throws(() => compileDeclarations([{
    id: 'budget', channel: 'agent/request',
    do: [{ kind: 'request-params', patch: {} }, { kind: 'request-params', patch: {}, maxPerTurn: 0 }],
  }]), /maxPerTurn must be a positive integer/)
})

// ───────────────────────── 字段归一与调度 ─────────────────────────

test('compileDeclaration：缺省逐项填充，when 编译为函数', () => {
  const compiled = compileDeclaration({
    id: 't', channel: 'system-prompt/assemble',
    when: { names: { deny: ['bash'] } },
    do: { kind: 'assembly', target: { tools: { deny: ['bash'] } } },
  })
  assert.equal(compiled.channelOrder, 0)
  assert.equal(compiled.waterfallPosition, 'default')
  assert.equal(compiled.phase, 'after-next')
  assert.equal(typeof compiled.when, 'function')
  assert.equal(compiled.when({ name: 'bash' }), false)
})

test('compileDeclarations：按 channelOrder 稳定排序，同值保持声明序', () => {
  const action = { kind: 'assembly', target: { tools: { deny: ['bash'] } } }
  const compiled = compileDeclarations([
    { id: 'c', channel: 'system-prompt/assemble', channelOrder: 2, do: action },
    { id: 'a', channel: 'system-prompt/assemble', channelOrder: 1, do: action },
    { id: 'b', channel: 'system-prompt/assemble', channelOrder: 1, do: action },
  ])
  assert.deepEqual(compiled.map((item) => item.id), ['a', 'b', 'c'], '升序 + 同值保持声明序')
  assert.throws(() => compileDeclarations('nope'), /triggers must be an array/)
})

test('compileDeclarations：缺省 channelOrder 按零参与稳定排序', () => {
  const action = { kind: 'assembly', target: { contexts: { clear: true } } }
  const compiled = compileDeclarations([5, undefined, 1, 0].map((channelOrder, index) => ({
    id: String(index), channel: 'system-prompt/assemble', channelOrder, do: action,
  })))
  assert.deepEqual(compiled.map((trigger) => trigger.id), ['1', '3', '2', '0'])
})

test('声明通道与阶段必须匹配动作真实执行点，错误组合编译期拒绝', () => {
  const base = { id: 'invalid', channel: 'agent/pre-step', do: { kind: 'request-params', patch: { maxTokens: 8 } } }
  assert.throws(() => compileDeclaration(base), /channel.*agent\/request/)
  assert.throws(() => compileDeclaration({ ...base, channel: 'agent/request', phase: 'before-next' }), /phase.*after-next/)
  assert.throws(() => compileDeclaration({ id: 'post', channel: 'tools/pre-execute', do: { kind: 'decision', phase: 'post', action: 'block' } }), /channel.*tools\/post-execute/)
  const decision = compileDeclaration({ id: 'pre', channel: 'tools/pre-execute', do: { kind: 'decision', decision: 'deny' } })
  assert.equal(decision.phase, 'before-next')
  assert.throws(() => compileDeclaration({
    id: 'mixed', channel: 'tools/post-execute',
    do: [{ kind: 'decision', phase: 'post', action: 'block' }, { kind: 'append-context', text: 'NOTICE' }],
  }), /phase.*after-next/)
  assert.throws(() => compileDeclaration({
    id: 'inject', channel: 'agent/pre-step', do: { kind: 'inject-text', config: { layer: 'system-section' } },
  }), /channel.*system-prompt\/assemble/)
  assert.throws(() => compileDeclaration({
    id: 'pipeline', channel: 'tools/pre-execute', do: { kind: 'inject-text', config: { layer: 'tool-pipeline' } },
  }), /no single trigger channel/)
  for (const [channel, phase, action] of [
    ['tools/post-execute', 'before-next', { kind: 'decision', phase: 'post', action: 'block' }],
    ['tools/post-execute', 'after-next', { kind: 'append-context', text: 'NOTICE' }],
    ['agent/turn-stopping', 'before-next', { kind: 'append-context', mode: 'continue', text: 'GO' }],
    ['agent/inbox/inserted', 'before-next', { kind: 'inbox-prepend', text: 'ANCHOR' }],
    ['system-prompt/assemble', 'after-next', { kind: 'guard', mask: { deny: ['bash'] } }],
  ]) {
    const compiled = compileDeclaration({ id: action.kind, channel, do: action })
    assert.equal(compiled.phase, phase)
    const recorder = recordingCtx()
    const dispose = mountDeclarations(recorder.ctx, [compiled])
    assert.deepEqual(recorder.events.map((event) => event.event), [channel])
    dispose()
    assert.equal(recorder.events.length, 0)
  }
})

test('declarationRegistrationOptions：只有 outermost 才 prepend（转发 trigger.mjs 的实现）', () => {
  assert.deepEqual(declarationRegistrationOptions({ waterfallPosition: 'outermost' }), { prepend: true })
  assert.deepEqual(declarationRegistrationOptions({ waterfallPosition: 'default' }), {})
})

// ───────────────────────── 注册（mountDeclarations） ─────────────────────────

/** 最小记录型 ctx：只够本文件的注册断言用（与 actions.test.mjs 的 harness 各自独立）。 */
function recordingCtx() {
  const events = []
  return {
    ctx: {
      on(event, handler, options) {
        events.push({ event, handler, options })
        return () => events.splice(events.findIndex((entry) => entry.handler === handler), 1)
      },
      get: () => undefined,
    },
    events,
  }
}

/**
 * 注意 `names` 谓词的语义是「**保留**」（`true` = 这个工具应当留下），所以「工具是 bash 时
 * 执行 deny 动作」要写成 `allow: ['bash']`（bash 通过 → 命中），**不是** `deny: ['bash']`
 * （那表示"bash 不留下" → 对 bash 返回 false → 动作反而不执行）。这一层语义差是声明写法
 * 最容易踩的坑，T4 的文档必须写明。
 */
const denyBashDeclaration = (over = {}) => ({
  id: 'deny-bash',
  channel: 'tools/pre-execute',
  when: { names: { allow: ['bash'] } },
  do: { kind: 'decision', phase: 'pre', decision: 'deny', reason: 'blocked' },
  ...over,
})

test('mountDeclarations：逐条注册、when 前置生效、prepend 传递、disposer 全撤', async () => {
  const recorder = recordingCtx()
  const dispose = mountDeclarations(recorder.ctx, compileDeclarations([denyBashDeclaration({ waterfallPosition: 'outermost' })]), { plugin: 'demo' })
  const entry = recorder.events.find((item) => item.event === 'tools/pre-execute')
  assert.ok(entry, '应注册到声明的通道')
  assert.deepEqual(entry.options, { prepend: true }, 'outermost → prepend')

  assert.deepEqual(await entry.handler({ name: 'bash' }, () => undefined), { kind: 'deny', reason: 'blocked' }, 'when 命中即裁决')
  assert.deepEqual(await entry.handler({ name: 'read' }, () => ({ kind: 'allow' })), { kind: 'allow' }, 'when 不命中即放行下游')

  dispose()
  assert.equal(recorder.events.length, 0, 'disposer 撤销全部注册')
})

test('mountDeclarations：一个声明的多个动作各注册一次，且**共用同一个 when**', async () => {
  const recorder = recordingCtx()
  mountDeclarations(recorder.ctx, compileDeclarations([{
    id: 'two',
    channel: 'tools/pre-execute',
    when: { names: { allow: ['bash'] } },
    do: [
      { kind: 'decision', phase: 'pre', decision: 'deny', reason: 'first' },
      { kind: 'decision', phase: 'pre', decision: 'deny', reason: 'second' },
    ],
  }]), { plugin: 'demo' })
  const handlers = recorder.events.filter((item) => item.event === 'tools/pre-execute').map((item) => item.handler)
  assert.equal(handlers.length, 2, '两个动作各注册一次（同一通道）')
  // 真正验证「共用同一个 when」：同载荷下两个动作必须同进同出。
  assert.deepEqual(await handlers[0]({ name: 'bash' }, () => undefined), { kind: 'deny', reason: 'first' })
  assert.deepEqual(await handlers[1]({ name: 'bash' }, () => undefined), { kind: 'deny', reason: 'second' })
  assert.equal(await handlers[0]({ name: 'read' }, () => 'next-value'), 'next-value', '不命中时第一个放行')
  assert.equal(await handlers[1]({ name: 'read' }, () => 'next-value'), 'next-value', '不命中时第二个也放行')
})

test('mountDeclarations：带 observe 的谓词共用一条 session/event；没有时不接（零开销）', () => {
  const withObserver = recordingCtx()
  mountDeclarations(withObserver.ctx, compileDeclarations([{
    id: 'gate',
    channel: 'tools/pre-execute',
    when: { count: { of: 'tool-call', per: 'session', min: 2 } },
    do: { kind: 'decision', phase: 'pre', decision: 'deny' },
  }]), { plugin: 'demo' })
  assert.equal(withObserver.events.filter((item) => item.event === 'session/event').length, 1,
    '相位 / 计数谓词需要一个事件源，且同组共用一条')

  const withoutObserver = recordingCtx()
  mountDeclarations(withoutObserver.ctx, compileDeclarations([denyBashDeclaration()]), { plugin: 'demo' })
  assert.equal(withoutObserver.events.filter((item) => item.event === 'session/event').length, 0,
    '没有带 observe 的谓词时不接监听')
})

test('mountDeclarations：把 manifest 的键/事件原样交给 session/event 观察者', () => {
  const recorder = recordingCtx()
  mountDeclarations(recorder.ctx, compileDeclarations([{
    id: 'gate',
    channel: 'tools/pre-execute',
    when: { count: { of: 'tool-call', per: 'session', min: 1 } },
    do: { kind: 'decision', phase: 'pre', decision: 'deny' },
  }]), { plugin: 'demo' })
  const listener = recorder.events.find((item) => item.event === 'session/event').handler
  const session = { id: 's-1', snapshotEvents: () => [] }
  // 不抛即说明观察者签名（session, event）与接线一致；计数谓词会据此累计。
  assert.doesNotThrow(() => listener(session, { type: 'tool/call' }))
})
