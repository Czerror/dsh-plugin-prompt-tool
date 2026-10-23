/**
 * 官方指令消息过滤：只删被禁用的文件段，包装/计数不符时原样放行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { filterOfficialInstructionMessages } from '../../src/runtime/official-instruction-filter.ts'

const reminder = (body) => `<system-reminder>\n${body}\n</system-reminder>`
const message = (changes, body, id = 'm1') => ({
  id,
  source: { kind: 'agent-instructions', changes },
  content: [{ type: 'text', text: reminder(body) }],
})
const changes = [
  { path: 'AGENTS.md', action: 'set' },
  { path: 'CLAUDE.md', action: 'set' },
]

test('过滤：禁用文件整段删除，其余段与 changes 保留', () => {
  const input = message(
    [...changes, { path: 'NOTES.md', action: 'replace' }],
    'Instructions from: AGENTS.md\n\nA\n\nInstructions from: CLAUDE.md\n\nB\n\nUpdated instructions from: NOTES.md\n\nC',
  )
  const result = filterOfficialInstructionMessages([input], (path) => path === 'AGENTS.md')
  assert.equal(result.messages.length, 1)
  const output = result.messages[0]
  assert.equal(output.content[0].text, reminder('Instructions from: CLAUDE.md\n\nB\n\nUpdated instructions from: NOTES.md\n\nC'))
  assert.deepEqual(output.source.changes, [
    { path: 'CLAUDE.md', action: 'set' },
    { path: 'NOTES.md', action: 'replace' },
  ])
  assert.deepEqual(result.diagnostics, [])
})

test('过滤：全放行时原数组返回', () => {
  const input = [message(changes, 'Instructions from: AGENTS.md\n\nA')]
  const result = filterOfficialInstructionMessages(input, () => false)
  assert.equal(result.messages, input)
  assert.deepEqual(result.diagnostics, [])
})

test('拒绝：包装不合法时原样放行并诊断', () => {
  const input = [{
    id: 'bad',
    source: { kind: 'agent-instructions', changes },
    content: [{ type: 'text', text: 'Instructions from: AGENTS.md\n\nA' }],
  }]
  const result = filterOfficialInstructionMessages(input, () => true)
  assert.equal(result.messages, input)
  assert.equal(result.diagnostics.length, 1)
  assert.match(result.diagnostics[0], /无法可靠分段/u)
})
