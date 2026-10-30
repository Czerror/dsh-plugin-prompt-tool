/**
 * 指令文件卡的视图投影：卡壳 + 草稿池 + 策略 → 卡片。纯函数，无 React、无网络。
 * 真值源是视图契约（unreadable/dirty/conflict/saving 的语义），不是实现细节。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { instructionShellsFrom, projectInstructionCards } from '../../src/client/data/instruction-cards.ts'

const shell = (fileId) => ({ id: 'agents-file-' + fileId, origin: { kind: 'instruction-file', fileId } })
const draft = (fileId, content, savedContent, extra = {}) => ({
  fileId,
  contextId: 'ctx',
  path: '/repo/' + fileId,
  displayPath: fileId,
  scope: 'project',
  status: 'ready',
  revision: 'rev-1',
  content,
  savedContent,
  ...extra,
})
const pool = (drafts) => ({ contextId: 'ctx', cwd: '/repo', source: 'session', latest: 1, drafts, owner: {} })
const policy = (files = {}) => ({ policy: { files }, revision: null, exists: true })

test('壳来源：会话段是唯一输入，空数组或缺段都清空旧壳', () => {
  assert.deepEqual(instructionShellsFrom([]), [])
  assert.deepEqual(instructionShellsFrom(undefined), [])
})

test('壳来源：只认文件身份，非文件卡与非法元素被丢弃', () => {
  const fileCard = { id: 'agents-file-a', origin: { kind: 'instruction-file', fileId: 'a' } }
  const engineCard = { id: 'param-model-params' }
  const plain = { id: 'plain' }
  assert.deepEqual(
    instructionShellsFrom([fileCard, engineCard, plain, null, 'nope']).map((card) => card.id),
    ['agents-file-a'],
  )
})

test('投影：没有草稿的卡不把未知正文当空文件，禁用保存', () => {
  const stale = { ...shell('a'), contentDirty: true, contentConflict: true, contentSaving: true }
  const cards = projectInstructionCards([stale], pool([]), policy())
  assert.equal(cards[0].text, '')
  assert.equal(cards[0].contentStatus, 'unreadable')
  assert.ok(typeof cards[0].contentMessage === 'string' && cards[0].contentMessage.length > 0, '给出可读的禁用原因')
  assert.equal(cards[0].contentDirty, undefined, '无草稿：不保留上一帧的脏标记')
  assert.equal(cards[0].contentConflict, undefined, '无草稿：不保留上一帧的冲突标记')
  assert.equal(cards[0].contentSaving, undefined, '无草稿：不保留上一帧的保存中标记')
})

test('投影：正文取草稿池，脏标记由 content 与 savedContent 比较', () => {
  const clean = projectInstructionCards([shell('a')], pool([draft('a', 'same', 'same')]), policy())
  assert.equal(clean[0].text, 'same')
  assert.equal(clean[0].contentDirty, false)
  const dirty = projectInstructionCards([shell('a')], pool([draft('a', 'edited', 'same')]), policy())
  assert.equal(dirty[0].text, 'edited')
  assert.equal(dirty[0].contentDirty, true)
})

test('投影：保存中与冲突映射到卡片字段，错误信息随池', () => {
  const cards = projectInstructionCards(
    [shell('a')],
    pool([draft('a', 'edited', 'same', { saving: true, conflict: true, error: '写入冲突' })]),
    policy(),
  )
  assert.equal(cards[0].contentSaving, true)
  assert.equal(cards[0].contentConflict, true)
  assert.equal(cards[0].contentMessage, '写入冲突')
})

test('投影：剥离卡壳里过期的正文、版本与读取状态，只留卡身份', () => {
  const stale = {
    id: 'agents-file-a',
    origin: { kind: 'instruction-file', fileId: 'a' },
    params: { fileId: 'a', scope: 'project', text: 'stale', revision: 'old', readStatus: 'missing', readMessage: 'gone' },
  }
  const cards = projectInstructionCards([stale], pool([draft('a', 'fresh', 'fresh')]), policy())
  assert.equal(cards[0].text, 'fresh', '正文只来自草稿池')
  assert.equal(cards[0].params.text, undefined)
  assert.equal(cards[0].params.revision, undefined)
  assert.equal(cards[0].params.readStatus, undefined, '读盘结论同样过期')
  assert.equal(cards[0].params.readMessage, undefined, '读盘消息同样过期')
  assert.equal(cards[0].params.fileId, 'a', '卡身份保留')
})

test('投影：策略覆盖 enabled 与 name；非文件卡原样返回', () => {
  const cards = projectInstructionCards(
    [shell('a')],
    pool([draft('a', 'x', 'x')]),
    policy({ a: { enabled: false, name: '自定义名' } }),
  )
  assert.equal(cards[0].enabled, false)
  assert.equal(cards[0].name, '自定义名')
  const other = { id: 'plain', text: 'keep' }
  assert.equal(projectInstructionCards([other], pool([]), policy())[0], other, '非文件卡不参与投影')
})
