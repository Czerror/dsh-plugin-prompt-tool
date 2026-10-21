/**
 * 指令文件卡的视图投影：卡壳 + 草稿池 + 策略 → 卡片。纯函数，无 React、无网络。
 * 真值源是视图契约（unreadable/dirty/conflict/saving 的语义），不是实现细节。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectInstructionCards } from '../../src/client/data/instruction-cards.ts'

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

test('投影：没有草稿的卡不把未知正文当空文件，禁用保存', () => {
  const cards = projectInstructionCards([shell('a')], pool([]), policy())
  assert.equal(cards[0].text, '')
  assert.equal(cards[0].contentStatus, 'unreadable')
  assert.equal(cards[0].contentMessage, '未读取到该文件正文，已禁用保存')
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
