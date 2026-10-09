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
  const base = { id: 't', channel: 'system-prompt/assemble', then: { kind: 'assembly', target: { tools: { deny: ['bash'] } } } }
  assert.throws(() => compileDeclaration({ ...base, nope: 1 }), /unknown trigger field\(s\) nope/)
  assert.throws(() => compileDeclaration({ ...base, id: '' }), /id must be a non-empty string/)
  assert.throws(() => compileDeclaration({ ...base, channel: '' }), /channel must be a non-empty event name/)
  assert.throws(() => compileDeclaration({ ...base, then: undefined }), /then is required/)
  assert.throws(() => compileDeclaration({ ...base, channelOrder: -1 }), /channelOrder must be a non-negative safe integer/)
  assert.throws(() => compileDeclaration({ ...base, waterfallPosition: 'top' }), /waterfallPosition must be one of/)
  assert.throws(() => compileDeclaration({ ...base, phase: 'during' }), /phase must be one of/)
  assert.throws(() => compileDeclaration(null), /trigger declaration must be an object/)
})

test('compileDeclaration：do 必须是已知动作，可给多个（数组）', () => {
  const base = { id: 't', channel: 'system-prompt/assemble' }
  assert.throws(() => compileDeclaration({ ...base, then: { kind: 'nope' } }), /action\[0\]\.kind must be one of/)
  assert.throws(() => compileDeclaration({ ...base, then: [] }), /non-empty array/)
  assert.throws(() => compileDeclaration({ ...base, then: [42] }), /action\[0\] must be an action declaration object/)

  const one = compileDeclaration({ ...base, then: { kind: 'assembly', target: { tools: { deny: ['bash'] } } } })
  assert.equal(one.actions.length, 1)
  const two = compileDeclaration({
    ...base,
    then: [
      { kind: 'assembly', target: { tools: { deny: ['bash'] } } },
      { kind: 'sdk-strip', mask: { deny: ['bash'] } },
    ],
  })
  assert.deepEqual(two.actions.map((action) => action.kind), ['assembly', 'sdk-strip'], '数组按序保留')
})

test('compileDeclaration：声明级 else 缺 if（含 if: null）编译期拒绝，与 rule-spec 侧同义', () => {
  const thenAction = { kind: 'assembly', target: { tools: { deny: ['bash'] } } }
  const elseAction = { kind: 'sdk-strip', mask: { deny: ['bash'] } }
  const base = { id: 't', channel: 'system-prompt/assemble', then: thenAction }
  // `if` 是 else 的互斥依据；缺它时 then 与 else 都退化成无条件动作（旧行为是静默双注册）。
  assert.throws(() => compileDeclaration({ ...base, else: elseAction }), /trigger-spec: trigger t: else requires an if/)
  assert.throws(() => compileDeclaration({ ...base, if: null, else: elseAction }), /else requires an if/)
  // 有 if 时 else 仍可编译：条件自带 not(if) 并标记跳过声明级判定。
  const compiled = compileDeclaration({ ...base, if: { names: { allow: ['bash'] } }, else: elseAction })
  assert.deepEqual(compiled.actions.map((action) => action.kind), ['assembly', 'sdk-strip'])
  assert.equal(compiled.actions[1].bypassRuleWhen, true)
  // 互斥是 else 存在的全部意义：`not(if)` 必须真的编译进该动作，否则 else 与 then 会在同一次调用里同时生效。
  // （这条此前零判别力：删掉 trigger-spec.mjs 的 `outer: [{ not: triggerIf }]` 后全部既有用例仍绿。）
  assert.equal(compiled.when({ name: 'bash' }), true)
  assert.equal(compiled.actions[1].actionWhen({ name: 'bash' }), false, 'if 命中时 else 不动')
  assert.equal(compiled.when({ name: 'ls' }), false)
  assert.equal(compiled.actions[1].actionWhen({ name: 'ls' }), true, 'if 不命中时 else 生效')
})

// ───────────────────────── 字段归一与调度 ─────────────────────────

test('compileDeclaration：缺省逐项填充，when 编译为函数', () => {
  const compiled = compileDeclaration({
    id: 't', channel: 'system-prompt/assemble',
    if: { names: { deny: ['bash'] } },
    then: { kind: 'assembly', target: { tools: { deny: ['bash'] } } },
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
    { id: 'c', channel: 'system-prompt/assemble', channelOrder: 2, then: action },
    { id: 'a', channel: 'system-prompt/assemble', channelOrder: 1, then: action },
    { id: 'b', channel: 'system-prompt/assemble', channelOrder: 1, then: action },
  ])
  assert.deepEqual(compiled.map((item) => item.id), ['a', 'b', 'c'], '升序 + 同值保持声明序')
  assert.throws(() => compileDeclarations('nope'), /triggers must be an array/)
})

test('声明通道与阶段必须匹配动作真实执行点，错误组合编译期拒绝', () => {
  const base = { id: 'invalid', channel: 'agent/pre-step', then: { kind: 'request-params', patch: { maxTokens: 8 } } }
  assert.throws(() => compileDeclaration(base), /channel.*agent\/request/)
  assert.throws(() => compileDeclaration({ ...base, channel: 'agent/request', phase: 'before-next' }), /phase.*after-next/)
  assert.throws(() => compileDeclaration({ id: 'post', channel: 'tools/pre-execute', then: { kind: 'decision', phase: 'post', action: 'block' } }), /channel.*tools\/post-execute/)
  const decision = compileDeclaration({ id: 'pre', channel: 'tools/pre-execute', then: { kind: 'decision', decision: 'deny' } })
  assert.equal(decision.phase, 'before-next')
  assert.throws(() => compileDeclaration({
    id: 'mixed', channel: 'tools/post-execute',
    then: [{ kind: 'decision', phase: 'post', action: 'block' }, { kind: 'append-context', text: 'NOTICE' }],
  }), /phase.*after-next/)
  assert.throws(() => compileDeclaration({
    id: 'inject', channel: 'agent/pre-step', then: { kind: 'inject-text', config: { id: 'inject', layer: 'system-section' } },
  }), /channel.*system-prompt\/assemble/)
  assert.throws(() => compileDeclaration({
    id: 'pipeline', channel: 'tools/pre-execute', then: { kind: 'inject-text', config: { id: 'pipeline', layer: 'tool-pipeline' } },
  }), /no single trigger channel/)
  for (const [channel, phase, action] of [
    ['tools/post-execute', 'before-next', { kind: 'decision', phase: 'post', action: 'block' }],
    ['tools/post-execute', 'after-next', { kind: 'append-context', text: 'NOTICE' }],
    ['agent/turn-stopping', 'before-next', { kind: 'append-context', mode: 'continue', text: 'GO' }],
    ['agent/inbox/inserted', 'before-next', { kind: 'inbox-prepend', text: 'ANCHOR' }],
    ['system-prompt/assemble', 'after-next', { kind: 'guard', mask: { deny: ['bash'] } }],
  ]) {
    const compiled = compileDeclaration({ id: action.kind, channel, then: action })
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
  if: { names: { allow: ['bash'] } },
  then: { kind: 'decision', phase: 'pre', decision: 'deny', reason: 'blocked' },
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
