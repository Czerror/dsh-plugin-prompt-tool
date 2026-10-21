import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPromptConfigs } from '../../engine/schema.mjs'
import { compileRules } from '../../engine/rule-spec.mjs'
import { runPreStepBatch } from '../../engine/executor.mjs'
import { createPreStepSource } from '../../engine/pre-step-source.mjs'
import { PROMOTION, presetSourceId } from '../fixtures/pre-step.mjs'
import { selectContextActivation, lastContextActivationDiagnostics } from '../../engine/context-activation.mjs'

const say = (id, text, source = { kind: 'user' }) => ({ id, role: 'user', content: [{ type: 'text', text }], source })
const session = text => ({ id: 'native-activation', snapshotEvents: () => [{ type: 'user/message', data: { message: say('history', text) } }] })
const config = (id, activation, params = {}) => ({ id, strategy: 'context-activation', text: id, params: { keys: ['DRAGON'], activation, ...params } })

test('上下文激活：显式扫描面、模块快照与四种副键逻辑使用同一候选池', async () => {
  const entries = createPromptConfigs([
    config('history', { scan: 'history' }), config('batch', { scan: 'batch' }),
    config('variables', { scan: 'history', scanVariables: ['description'] }, { keys: ['{{module.get::key}}'] }),
    config('depth-zero', { scan: 'history', scanDepth: 0, scanVariables: ['description'] }),
    config('constant', { scan: 'batch', scanDepth: 0 }, { keys: [], constant: true }),
    config('empty', { scan: 'history' }, { keys: [] }),
    ...['AND_ANY', 'NOT_ALL', 'NOT_ANY', 'AND_ALL'].map(logic => config(logic, { scan: 'history', selective: true }, { selectiveLogic: logic, secondaryKeys: ['RED', '{{missing}}'] })),
  ])
  const readVariables = () => ({ module: { key: 'SECRET', description: 'SECRET' }, global: { key: 'GLOBAL' } })
  const selected = selectContextActivation(entries, session('DRAGON RED'), [say('plugin', 'DRAGON', { kind: 'plugin:injected' }), say('batch', 'OTHER')], undefined, readVariables)
  assert.deepEqual([...selected].map(item => item.id), ['history', 'variables', 'constant', 'AND_ANY', 'NOT_ALL'])
  assert.deepEqual(entries.find(item => item.id === 'history').resolve({ contextActivationSelected: true }), { text: 'history' })
  assert.equal(entries.find(item => item.id === 'history').resolve({ contextActivationSelected: false }), null)
  const logicEntries = createPromptConfigs(['AND_ANY', 'NOT_ALL', 'NOT_ANY', 'AND_ALL'].map(logic => config(logic, { scan: 'history', selective: true }, { selectiveLogic: logic, secondaryKeys: ['RED', 'BLUE'] })))
  for (const [text, expected] of [['DRAGON', ['NOT_ALL', 'NOT_ANY']], ['DRAGON RED', ['AND_ANY', 'NOT_ALL']], ['DRAGON RED BLUE', ['AND_ANY', 'AND_ALL']], ['RED BLUE', []]]) {
    assert.deepEqual([...selectContextActivation(logicEntries, session(text), [])].map(item => item.id), expected)
  }
  const boundaries = createPromptConfigs(['ascii-token', 'unicode'].map(wordBoundary => config(wordBoundary, { scan: 'history' }, { keys: ['龙'], wholeWords: true, wordBoundary })))
  assert.deepEqual([...selectContextActivation(boundaries, session('龙城'), [])].map(item => item.id), ['ascii-token'])
  const { convertStToModuleWithReport } = await import('../../src/host/sillytavern.ts')
  const { spec } = convertStToModuleWithReport({ entries: [
    { uid: 7, key: ['{{getvar::key}}'], content: 'LORE {{getvar::name}}' },
    { uid: 8, constant: true, content: 'OUTLET', outletName: 'private' },
  ] }, 'activation-import')
  assert.equal(spec.rules[1].enabled, false)
  const compiled = compileRules(spec.rules, { moduleId: 'activation-import' }).filter(rule => rule.enabled).flatMap(rule => rule.actions.map(action => action.compiledConfig))
  for (const item of compiled) item.variableStore = { read: () => ({ module: { key: 'DRAGON', name: 'Mia' }, global: {} }) }
  const source = createPreStepSource({ sourceId: presetSourceId('activation'), ctx: {}, configs: compiled, promotion: PROMOTION })
  const output = await runPreStepBatch({ ctx: {}, agent: { session: session('DRAGON'), options: { model: 'deepseek-chat' } },
    decision: { kind: 'enter', messages: [say('pending', 'DRAGON')] }, sources: [source], memo: new Map(),
    warnOnce: message => assert.fail(message),
  })
  assert.deepEqual(output.messages.filter(message => message.source?.plugin).map(message => message.content.map(block => block.text).join('')), ['LORE Mia'])
})

test('上下文激活：退役和非法声明拒绝，只读扫描不执行变量赋值', () => {
  for (const spec of [
    { id: 'legacy', strategy: 'world-book', text: 'OLD' },
    config('legacy-params', { scan: 'history' }, { stWorldBook: {} }),
    config('missing-scan', {}), config('bad-scan', { scan: 'all' }),
    config('bad-logic', { scan: 'history' }, { selectiveLogic: 1 }),
    config('bad-depth', { scan: 'history', scanDepth: -1 }),
    config('unknown', { scan: 'history', arbitrary: true }),
  ]) assert.throws(() => createPromptConfigs([spec]))
  const values = { module: { key: 'KEEP' }, global: {} }
  const entries = createPromptConfigs([config('setter-key', { scan: 'history' }, { keys: ['{{module.set::key::LOST}}'] })])
  const selected = selectContextActivation(entries, session('DRAGON'), [], undefined, () => values)
  assert.equal(selected.size, 0)
  assert.deepEqual(values, { module: { key: 'KEEP' }, global: {} })
  assert.ok(selected.diagnostics.records.some(record => record.id === 'setter-key' && record.reason === 'match-error'))
})

test('上下文激活：候选概率与评分同源，实际投递才提交且 sticky 重发不延期', () => {
  const entries = createPromptConfigs([
    config('zero', { scan: 'history', probability: 0 }),
    config('low', { scan: 'history', selectionGroup: 'choice', useGroupScoring: true }),
    config('high', { scan: 'history', selectionGroup: 'choice', useGroupScoring: true, sticky: 2, cooldown: 2 }, { keys: ['DRAGON', 'RED'] }),
  ])
  const events = []
  const state = { id: 'activation-windows', snapshotEvents: () => events }
  const push = text => events.push({ type: 'user/message', data: { message: say(String(events.length), text) } })
  push('DRAGON RED')
  const first = selectContextActivation(entries, state, [])
  assert.deepEqual([...first].map(item => item.id), ['high'])
  assert.ok(first.diagnostics.records.some(record => record.id === 'low' && record.reason === 'group-score-lost'))
  assert.ok(first.diagnostics.records.some(record => record.id === 'zero' && record.reason === 'probability'))
  assert.equal(first.diagnostics.records.some(record => record.stage === 'committed'), false)
  first.commit(entries.find(item => item.id === 'high'))
  assert.ok(lastContextActivationDiagnostics(state).records.some(record => record.stage === 'committed'))
  push('EMPTY')
  const repeated = selectContextActivation(entries, state, [])
  assert.deepEqual([...repeated].map(item => item.id), ['high'])
  repeated.commit(entries.find(item => item.id === 'high'))
  push('EMPTY')
  assert.deepEqual([...selectContextActivation(entries, state, [])], [], '未到期的冷却不会被其它入选状态延长或跳过')
  push('DRAGON RED'); push('DRAGON RED')
  assert.deepEqual([...selectContextActivation(entries, state, [])].map(item => item.id), ['high'])
  assert.deepEqual(lastContextActivationDiagnostics(state).records.filter(record => record.stage === 'selected').map(record => record.id), ['high'])
})
