import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareAction } from '../../engine/actions/index.mjs'
import { compileRules } from '../../engine/rule-spec.mjs'
import { actionMatches, ruleFrame } from '../../engine/conditions/evaluation.mjs'
import { bindMessageShapeGuardsDependencies, normalizeMessageShapeAssembly, prepareMessageShapeGuards, registerMessageShapeGuards } from '../../engine/message-shape-guards.mjs'
import { associateToolStep } from '../../engine/tool-scope.mjs'

test('retired protocol controls and transient maxTokens reject rather than falling back to ordinary behavior', () => {
  for (const capability of ['current-system-snapshot', 'oauth-identity-prefix', 'provider-system-role', 'messages-current-system']) {
    assert.throws(() => prepareAction({ kind: 'host-control', capability, value: true }), /unsupported|retired/)
  }
  assert.throws(() => prepareAction({ kind: 'request-params', maxTokens: 512 }), /maxTokens was retired/)
  assert.equal(typeof prepareAction({ kind: 'request-params', patch: { maxTokens: 512 } }), 'function')
  const persona = compileRules([{ id: 'mixed', then: [{
    id: 'persona', kind: 'persona', prefix: 'ordinary persona text', instructionsMaxBytes: 512,
  }] }])
  assert.equal(persona[0].actions[0].prefix, 'ordinary persona text')
  assert.deepEqual(persona[0].actions[0].retiredFields, ['instructionsMaxBytes'])
})

test('ordinary message normalization is scoped to its accepted step and leaves dependent branches unavailable', () => {
  const agent = { id: 'main' }, toolSet = {}, step = { status: 'pending' }
  const context = { agent, toolSet, signal: new AbortController().signal }
  associateToolStep(toolSet, toolSet, agent, step)
  const control = { kind: 'host-control', capability: 'message-shape-guards', value: true, id: 'guard', branchPath: [0] }
  const dependent = { id: 'dependent', branchPath: [0, 1] }
  const sibling = { id: 'sibling', branchPath: [1] }
  const rule = { id: 'test', actions: [control, dependent, sibling] }
  const outcomes = []
  bindMessageShapeGuardsDependencies(rule, 'module', outcome => outcomes.push(outcome))
  const frame = ruleFrame('system-prompt/assemble', [{}, context])
  const owner = registerMessageShapeGuards(agent)
  prepareMessageShapeGuards([{ rule, action: control, id: control.id }], frame, false, owner, context)
  assert.equal(actionMatches({ rule, action: dependent, id: dependent.id }, frame), false)
  assert.equal(actionMatches({ rule, action: sibling, id: sibling.id }, frame), true)
  assert.ok(outcomes.some(outcome => outcome.actionId === 'guard' && outcome.identityOutcome === 'condition-unavailable'))

  const complete = { name: 'complete', complete: true, text: 1 }
  const literal = { name: 'valid', text: ' \r\n ' }
  const assembly = { sections: [{ name: 'missing' }, complete, literal], contexts: [{ name: 'invalid', text: 12 }] }
  assert.deepEqual(normalizeMessageShapeAssembly(assembly, context), {
    sections: [{ name: 'missing', text: '' }, complete, literal], contexts: [{ name: 'invalid', text: '' }],
  })
  step.status = 'sealed'
  assert.equal(normalizeMessageShapeAssembly(assembly, context).contexts[0].text, '')
  assert.strictEqual(normalizeMessageShapeAssembly(assembly, { ...context, agent: { id: 'main' } }), assembly)
  owner.dispose()
  const replacement = registerMessageShapeGuards(agent)
  assert.strictEqual(normalizeMessageShapeAssembly(assembly, context), assembly)
  replacement.dispose()
})
