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
  mountDeclarations,
} from '../../engine/trigger-spec.mjs'
import {
  createNameListPredicate,
  createSourcePredicate,
  createTextPredicate,
  createSessionStatePredicate,
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
  assert.throws(() => compileDeclaration({ ...base, do: undefined, then: undefined }), /then is required/)
  assert.throws(() => compileDeclaration({ ...base, channelOrder: -1 }), /channelOrder must be a non-negative safe integer/)
  assert.throws(() => compileDeclaration({ ...base, waterfallPosition: 'top' }), /waterfallPosition must be one of/)
  assert.throws(() => compileDeclaration({ ...base, phase: 'during' }), /phase must be one of/)
  assert.throws(() => compileDeclaration(null), /trigger declaration must be an object/)
})

test('compileDeclaration：do 必须是已知动作，可给多个（数组）', () => {
  const base = { id: 't', channel: 'system-prompt/assemble' }
  assert.throws(() => compileDeclaration({ ...base, do: { kind: 'nope' } }), /action\[0\]\.kind must be one of/)
  assert.throws(() => compileDeclaration({ ...base, do: [] }), /non-empty array/)
  assert.throws(() => compileDeclaration({ ...base, do: [42] }), /action\[0\] must be an action declaration object/)

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
    id: 'inject', channel: 'agent/pre-step', do: { kind: 'inject-text', config: { id: 'inject', layer: 'system-section' } },
  }), /channel.*system-prompt\/assemble/)
  assert.throws(() => compileDeclaration({
    id: 'pipeline', channel: 'tools/pre-execute', do: { kind: 'inject-text', config: { id: 'pipeline', layer: 'tool-pipeline' } },
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
