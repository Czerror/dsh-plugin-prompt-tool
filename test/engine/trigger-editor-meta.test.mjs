import test from 'node:test'
import assert from 'node:assert/strict'
import { ACTION_KINDS, actionExecutionPoint } from '../../engine/actions.mjs'
import { COMPOSITE_OPERATORS, PREDICATE_FACTORIES, compileDeclaration, compileWhen } from '../../engine/trigger-spec.mjs'
import { getTriggerEditorMeta } from '../../engine/trigger-editor-meta.mjs'
import { WATERFALL_POSITIONS } from '../../engine/trigger.mjs'

test('编辑目录覆盖真实原语、组合与动作，纯数据示例可被同一编译器接受', () => {
  const meta = getTriggerEditorMeta()
  assert.deepEqual(JSON.parse(JSON.stringify(meta)), meta)
  assert.deepEqual(meta.predicates.map(item => item.kind), [...Object.keys(PREDICATE_FACTORIES), ...COMPOSITE_OPERATORS])
  assert.deepEqual(meta.actions.map(item => item.kind), Object.keys(ACTION_KINDS))
  assert.deepEqual(meta.composites, COMPOSITE_OPERATORS)
  assert.deepEqual(meta.waterfallPositions, [...WATERFALL_POSITIONS])
  for (const { kind, example } of meta.predicates) {
    assert.deepEqual(Object.keys(example), [kind])
    assert.equal(typeof compileWhen(example), 'function')
  }
  for (const { kind, example, channel, phase, supportsWhen } of meta.actions) {
    assert.equal(example.kind, kind)
    assert.deepEqual({ channel, phase }, actionExecutionPoint(example))
    const declaration = { id: kind, channel, phase, do: example }
    assert.doesNotThrow(() => compileDeclaration(declaration))
    const conditional = { ...declaration, when: { phase: { promoted: false } } }
    if (supportsWhen) assert.doesNotThrow(() => compileDeclaration(conditional))
    else assert.throws(() => compileDeclaration(conditional), /does not support a when predicate/)
  }
})

test('编辑目录每次返回独立草稿，动作变体和高级字段仍由编译器原样保留', () => {
  const meta = getTriggerEditorMeta()
  meta.predicates[0].example.text.keys.push('changed')
  meta.actions[0].example.config.text = 'changed'
  assert.deepEqual(getTriggerEditorMeta().predicates[0].example.text.keys, ['keyword'])
  assert.equal(getTriggerEditorMeta().actions[0].example.config.text, 'Context')
  const action = { kind: 'decision', phase: 'post', action: 'replace', text: 'REPLACEMENT', toolNames: ['bash'], maxPerTurn: 2 }
  const compiled = compileDeclaration({ id: 'variant', ...actionExecutionPoint(action), do: action })
  assert.deepEqual(compiled.actions, [action])
})
