import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filterOfficialInstructionMessages } from '../../src/runtime/official-instruction-filter.ts'

const change = (path, action = 'set') => ({ path, action, scope: `${path}\0AGENTS.md`, digest: 'digest' })
const frame = (text) => `<system-reminder>\n${text}\n</system-reminder>`
const message = (paths, texts, extra = {}) => ({
  id: 'official-1', role: 'user',
  source: { kind: 'agent-instructions', form: 'instructions', baseline: true, baselineIdentity: 'baseline', changes: paths.map(path => typeof path === 'string' ? change(path) : path), ...extra },
  content: texts.map(text => ({ type: 'text', text: frame(text) })),
})
const filter = (messages, paths = ['AGENTS.md']) => filterOfficialInstructionMessages(messages, path => paths.includes(path))

test('基线只过滤关闭文件，保留同批消息、ID、来源与未关闭正文，不修改输入', () => {
  const original = message(['AGENTS.md', 'CLAUDE.md'], ['INTRO\n\nInstructions from: AGENTS.md\n\nSECRET\n\nInstructions from: CLAUDE.md\n\nKEEP'])
  const user = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'TASK' }] }
  const before = structuredClone(original)
  const result = filter([user, original])
  assert.deepEqual(original, before)
  assert.equal(result.messages[0], user)
  assert.equal(result.messages[1].id, original.id)
  assert.equal(result.messages[1].source.baselineIdentity, 'baseline')
  assert.deepEqual(result.messages[1].source.changes, [change('CLAUDE.md')])
  assert.equal(result.messages[1].content[0].text, frame('INTRO\n\nInstructions from: CLAUDE.md\n\nKEEP'))
  assert.deepEqual(result.diagnostics, [])
})

test('没有关闭文件时保留消息与数组身份；非官方来源不参与过滤', () => {
  const original = message(['AGENTS.md'], ['Instructions from: AGENTS.md\n\nBODY'])
  const input = [original]
  assert.equal(filter(input, []).messages, input)
  original.source.kind = 'plugin'
  assert.equal(filter(input).messages, input)
})

test('全部关闭后不留下空官方消息', () => {
  const original = message(['AGENTS.md'], ['Instructions from: AGENTS.md\n\nBODY'])
  assert.deepEqual(filter([original]).messages, [])
})

test('附加、更新、移除与多 content block 使用相同文件开关', () => {
  for (const [action, heading] of [['set', 'Additional instructions from:'], ['replace', 'Updated instructions from:'], ['remove', 'Instructions removed:']]) {
    const original = message([change('AGENTS.md', action), change('pkg/CLAUDE.md', action)], [
      `${heading} AGENTS.md\n\nDROP`, `${heading} pkg/CLAUDE.md\n\nKEEP`,
    ], { baseline: undefined, baselineIdentity: undefined })
    const result = filter([original])
    assert.equal(result.messages.length, 1)
    assert.deepEqual(result.messages[0].content, [original.content[1]])
    assert.deepEqual(result.messages[0].source.changes, [original.source.changes[1]])
  }
})

test('预算提示与截断后的已知段落仍可过滤，保留官方预算说明', () => {
  const original = message(['AGENTS.md', 'pkg/AGENTS.md'], ['Workspace instruction budget 65536 bytes: truncated pkg/AGENTS.md\n\nInstructions from: AGENTS.md\n\nDROP\n\nInstructions from: pkg/AGENTS.md\n\nCUT'])
  const result = filter([original])
  assert.match(result.messages[0].content[0].text, /Workspace instruction budget/)
  assert.match(result.messages[0].content[0].text, /CUT/)
  assert.doesNotMatch(result.messages[0].content[0].text, /DROP/)
})

test('正文含与来源相同的伪段落标题时原样放行，不误裁正文', () => {
  const original = message(['AGENTS.md', 'CLAUDE.md'], ['Instructions from: AGENTS.md\n\nEXAMPLE\n\nInstructions from: CLAUDE.md\n\nFAKE\n\nInstructions from: CLAUDE.md\n\nREAL'])
  const result = filter([original])
  assert.equal(result.messages[0], original)
  assert.equal(result.diagnostics.length, 1)
})

test('无法定位、非 text 块、未知包装均放行官方原消息', () => {
  const cases = [
    message(['AGENTS.md', 'CLAUDE.md'], ['UNKNOWN FORMAT']),
    { ...message(['AGENTS.md'], []), content: [{ type: 'image', url: 'local' }] },
    { ...message(['AGENTS.md'], []), content: [{ type: 'text', text: 'Instructions from: AGENTS.md\n\nBODY' }] },
  ]
  for (const original of cases) {
    const result = filter([original])
    assert.equal(result.messages[0], original)
    assert.equal(result.diagnostics.length, 1)
  }
})

test('开启恢复放行，不依赖进程记账，也不主动产生补发消息', () => {
  const original = message(['AGENTS.md'], ['Instructions from: AGENTS.md\n\nBODY'])
  assert.deepEqual(filter([original]).messages, [])
  assert.equal(filter([original], []).messages[0], original)
  assert.deepEqual(filter([], []).messages, [])
})

test('保留段落的末尾空行按原字节保留，不把分隔符和文件正文混为一谈', () => {
  for (const paths of [['AGENTS.md', 'CLAUDE.md'], ['CLAUDE.md', 'AGENTS.md']]) {
    const original = message(paths, [paths.map(path => `Instructions from: ${path}\n\n${path === 'CLAUDE.md' ? 'KEEP\n\n' : 'DROP'}`).join('\n\n')])
    assert.equal(filter([original]).messages[0].content[0].text, frame('Instructions from: CLAUDE.md\n\nKEEP\n\n'))
  }
})

test('完整替代基线的无正文 remove 不作为分段标记，歧义时整条放行', () => {
  const original = message([change('CLAUDE.md', 'remove'), change('AGENTS.md')], [
    'This complete workspace instruction baseline replaces all earlier workspace instruction baselines.\n\nInstructions from: AGENTS.md\n\nKEEP\n\nInstructions removed: CLAUDE.md\n\nTHIS IS A BODY EXAMPLE',
  ])
  for (const disabled of [['CLAUDE.md'], ['AGENTS.md']]) {
    const result = filter([original], disabled)
    assert.equal(result.messages[0], original, '不能误删正文示例或产出没有正文的移除确认')
    assert.equal(result.diagnostics.length, 1)
  }
})
