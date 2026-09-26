/**
 * 官方注入消息 → 按文件切分正文段落的回归测试。
 * 这一层是接管官方注入的前置：切错或切漏会让用户磁盘上的指令静默消失，
 * 所以「不确定就返回 undefined」的每条分支都要有用例兜住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractInstructionSegments } from '../../src/runtime/instruction-hijack.ts'

const messageOf = (changes, text) => ({
  source: { kind: 'agent-instructions', form: 'instructions', changes },
  content: [{ type: 'text', text }],
})

test('按 changes 切出各文件正文，剥离包裹与 intro', () => {
  const text = [
    '<system-reminder>',
    'The following workspace instructions may be relevant to your work.',
    'Instructions from: AGENTS.md',
    '',
    'ROOT RULES',
    '',
    'Instructions from: packages/foo/AGENTS.md',
    '',
    'FOO RULES',
    '</system-reminder>',
  ].join('\n')
  assert.deepEqual(
    extractInstructionSegments(messageOf([
      { action: 'set', path: 'AGENTS.md' },
      { action: 'set', path: 'packages/foo/AGENTS.md' },
    ], text)),
    [
      { path: 'AGENTS.md', text: 'ROOT RULES' },
      { path: 'packages/foo/AGENTS.md', text: 'FOO RULES' },
    ],
  )
})

test('段落顺序以正文出现顺序为准，不信任 changes 顺序', () => {
  const text = [
    'Instructions from: a/AGENTS.md',
    '',
    'A BODY',
    '',
    'Instructions from: b/AGENTS.md',
    '',
    'B BODY',
  ].join('\n')
  const segments = extractInstructionSegments(messageOf([
    { action: 'set', path: 'b/AGENTS.md' },
    { action: 'set', path: 'a/AGENTS.md' },
  ], text))
  assert.deepEqual(segments?.map((segment) => segment.path), ['a/AGENTS.md', 'b/AGENTS.md'])
})

test('只有行首的段落头才算边界，正文里内联的同名字样不干扰', () => {
  const text = [
    'Instructions from: AGENTS.md',
    '',
    'ROOT RULES',
    'See Instructions from: AGENTS.md for the same file again',
  ].join('\n')
  assert.deepEqual(extractInstructionSegments(messageOf([{ action: 'set', path: 'AGENTS.md' }], text)), [
    { path: 'AGENTS.md', text: 'ROOT RULES\nSee Instructions from: AGENTS.md for the same file again' },
  ])
})

test('单文件且正文为空时不吞掉该文件（空正文也是内容）', () => {
  const text = 'Instructions from: AGENTS.md\n\n'
  assert.deepEqual(extractInstructionSegments(messageOf([{ action: 'set', path: 'AGENTS.md' }], text)), [
    { path: 'AGENTS.md', text: '' },
  ])
})

test('含预算裁剪告知时放弃切分：保留官方原消息，不吞掉「有内容被省略」', () => {
  const text = [
    'Workspace instructions were omitted or truncated to fit the configured byte budget.',
    'Instructions from: AGENTS.md',
    '',
    'ROOT RULES',
  ].join('\n')
  assert.equal(extractInstructionSegments(messageOf([{ action: 'set', path: 'AGENTS.md' }], text)), undefined)
})

test('形状不符、路径缺失或重复一律放弃切分', () => {
  const body = 'Instructions from: AGENTS.md\n\nROOT RULES'
  const cases = [
    ['不是对象', 42],
    ['source 形状不符', { source: { kind: 'instruction-file', changes: [] }, content: [{ type: 'text', text: body }] }],
    ['changes 缺失', { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: body }] }],
    ['条目不是对象', messageOf([null], body)],
    ['path 缺失', messageOf([{ action: 'set' }], body)],
    ['path 为空串', messageOf([{ action: 'set', path: '' }], body)],
    ['path 重复', messageOf([{ action: 'set', path: 'AGENTS.md' }, { action: 'replace', path: 'AGENTS.md' }], body)],
    ['正文定位不到', messageOf([{ action: 'set', path: 'missing/AGENTS.md' }], body)],
    ['只有 remove 条目', messageOf([{ action: 'remove', path: 'AGENTS.md' }], body)],
    ['正文不是单个 text 块', { source: { kind: 'agent-instructions', changes: [{ action: 'set', path: 'AGENTS.md' }] }, content: [{ type: 'text', text: body }, { type: 'text', text: body }] }],
    ['正文块不是 text 类型', { source: { kind: 'agent-instructions', changes: [{ action: 'set', path: 'AGENTS.md' }] }, content: [{ type: 'image' }] }],
    ['content 缺失', { source: { kind: 'agent-instructions', changes: [{ action: 'set', path: 'AGENTS.md' }] } }],
  ]
  for (const [name, input] of cases) {
    assert.equal(extractInstructionSegments(input), undefined, `应放弃切分：${name}`)
  }
})

test('remove 条目跳过，其余条目照常切分', () => {
  const text = [
    'Instructions from: AGENTS.md',
    '',
    'ROOT RULES',
  ].join('\n')
  assert.deepEqual(
    extractInstructionSegments(messageOf([
      { action: 'remove', path: 'gone/AGENTS.md' },
      { action: 'set', path: 'AGENTS.md' },
    ], text)),
    [{ path: 'AGENTS.md', text: 'ROOT RULES' }],
  )
})
