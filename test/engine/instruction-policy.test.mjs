import { test } from 'node:test'
import assert from 'node:assert/strict'

const { compileRules } = await import('../../engine/rule-spec.mjs')
const { adaptOfficialInstructionIntros } = await import('../../src/runtime/official-instruction-filter.ts')

test('instruction-policy 动作接受当前 Agent 的 fileId 关闭列表', () => {
  const [rule] = compileRules([{
    id: 'close-instruction',
    then: [{ id: 'close', kind: 'instruction-policy', fileIds: ['file-a'] }],
  }])
  assert.equal(rule.actions[0].kind, 'instruction-policy')
  assert.deepEqual(rule.actions[0].fileIds, ['file-a'])
})

test('instruction-policy 动作拒绝空列表和非字符串 fileId', () => {
  assert.throws(() => compileRules([{ id: 'empty', then: [{ id: 'close', kind: 'instruction-policy', fileIds: [] }] }]), /fileIds/)
  assert.throws(() => compileRules([{ id: 'bad', then: [{ id: 'close', kind: 'instruction-policy', fileIds: [''] }] }]), /fileIds/)
})

test('P1 导语只替换官方包装首段，未知包装与正文元数据保持', () => {
  const input = { id: 'intro', role: 'user', source: { kind: 'agent-instructions', marker: 'keep', changes: [{ path: 'AGENTS.md', action: 'set' }] }, content: [{ type: 'text', text: '<system-reminder>\n官方导语\n\nInstructions from: AGENTS.md\n\nBODY\n</system-reminder>' }] }
  const result = adaptOfficialInstructionIntros([input], () => '准确来源导语')
  assert.equal(result[0].role, 'user')
  assert.deepEqual(result[0].source, input.source)
  assert.equal(result[0].content[0].text, '<system-reminder>\n准确来源导语\n\nInstructions from: AGENTS.md\n\nBODY\n</system-reminder>')
  const unknown = { ...input, content: [{ type: 'text', text: 'UNRECOGNIZED' }] }
  assert.deepEqual(adaptOfficialInstructionIntros([unknown], () => 'NEW'), [unknown])
})

test('P1 导语适配保留首个标题前元数据，并对重复包装原样放行', () => {
  const input = {
    id: 'metadata', role: 'user',
    source: { kind: 'agent-instructions', changes: [{ path: 'AGENTS.md', action: 'set' }] },
    content: [{ type: 'text', text: '<system-reminder>\nOLD\n\nMetadata\n\nInstructions from: AGENTS.md\n\nBODY\n</system-reminder>' }],
  }
  const diagnostics = []
  const adapted = adaptOfficialInstructionIntros([input], () => 'NEW', diagnostics)
  assert.equal(adapted[0].content[0].text, '<system-reminder>\nNEW\n\nMetadata\n\nInstructions from: AGENTS.md\n\nBODY\n</system-reminder>')
  const duplicate = { ...input, content: [{ type: 'text', text: input.content[0].text + '\n</system-reminder>' }] }
  const duplicateDiagnostics = []
  assert.deepEqual(adaptOfficialInstructionIntros([duplicate], () => 'NEW', duplicateDiagnostics), [duplicate])
  assert.ok(duplicateDiagnostics.length > 0)

  const multi = {
    id: 'multi', role: 'user',
    source: { kind: 'agent-instructions', changes: [
      { path: 'AGENTS.md', action: 'set' }, { path: 'CLAUDE.md', action: 'set' },
    ] },
    content: [
      { type: 'text', text: '<system-reminder>\nOLD\n\nInstructions from: AGENTS.md\n\nA\n</system-reminder>' },
      { type: 'text', text: '<system-reminder>\nOLD\n\nInstructions from: CLAUDE.md\n\nB\n</system-reminder>' },
    ],
  }
  const multiResult = adaptOfficialInstructionIntros([multi], () => 'NEW')
  assert.match(multiResult[0].content[0].text, /NEW[\s\S]*Instructions from: AGENTS\.md/)
  assert.match(multiResult[0].content[1].text, /NEW[\s\S]*Instructions from: CLAUDE\.md/)
})
