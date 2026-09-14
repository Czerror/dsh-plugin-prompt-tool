import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applySaveFailure,
  applySaveOutcomes,
  applySaveSuccess,
  canSaveDraft,
  instructionSaveRequest,
  isCurrentInstructionSeq,
  markDraftSaving,
  poolFromSnapshot,
  resetDraftFromSnapshot,
  saveableInstructionDrafts,
  setDraftContent,
  switchInstructionContext,
  unsavedInstructionDrafts,
} from '../../src/client/data/instruction-drafts.ts'

const fileSnapshot = (over = {}) => ({
  fileId: 'f1',
  path: 'D:/repo/AGENTS.md',
  displayPath: 'AGENTS.md',
  scope: 'project',
  status: 'ready',
  text: 'V1',
  revision: 'r1',
  ...over,
})

const snapshotOf = (files, over = {}) => ({
  context: { contextId: 'ctx-1', cwd: 'D:/repo', source: 'session', ...over },
  files,
})

const draftOf = (pool, fileId) => {
  const draft = pool.drafts.find((entry) => entry.fileId === fileId)
  assert.ok(draft, `draft ${fileId} 应存在`)
  return draft
}

test('instruction drafts：读取快照建立基线，未编辑不产生保存请求', () => {
  const pool = poolFromSnapshot(snapshotOf([fileSnapshot()]), 1)
  assert.equal(pool.contextId, 'ctx-1')
  assert.equal(draftOf(pool, 'f1').content, 'V1')
  assert.equal(draftOf(pool, 'f1').savedContent, 'V1')
  assert.deepEqual(saveableInstructionDrafts(pool), [])
  assert.equal(instructionSaveRequest(pool, 'f1', 'sess-1'), undefined)
  assert.deepEqual(unsavedInstructionDrafts(pool), [])
})

test('instruction drafts：编辑后请求带 contextId 与 expectedRevision，只提交改动文件', () => {
  const base = poolFromSnapshot(snapshotOf([fileSnapshot(), fileSnapshot({ fileId: 'f2', path: 'D:/repo/CLAUDE.md', displayPath: 'CLAUDE.md', text: 'B', revision: 'r2' })]), 1)
  const pool = setDraftContent(base, 'f1', 'V1 edited')
  assert.equal(saveableInstructionDrafts(pool).length, 1)
  assert.deepEqual(instructionSaveRequest(pool, 'f1', 'sess-1'), {
    sessionId: 'sess-1',
    contextId: 'ctx-1',
    fileId: 'f1',
    expectedRevision: 'r1',
    content: 'V1 edited',
  })
  assert.equal(instructionSaveRequest(pool, 'f2'), undefined)
})

test('instruction drafts：外部改版不静默覆盖脏草稿，重新读取才采纳磁盘版本', () => {
  const base = poolFromSnapshot(snapshotOf([fileSnapshot()]), 1)
  const dirty = setDraftContent(base, 'f1', 'my draft')
  const merged = poolFromSnapshot(snapshotOf([fileSnapshot({ text: 'V2', revision: 'r2' })]), 2, dirty)
  assert.equal(draftOf(merged, 'f1').content, 'my draft')
  assert.equal(draftOf(merged, 'f1').conflict, true)
  assert.equal(draftOf(merged, 'f1').revision, 'r1')
  assert.equal(canSaveDraft(merged, draftOf(merged, 'f1')), false)
  assert.equal(instructionSaveRequest(merged, 'f1'), undefined)

  const reset = resetDraftFromSnapshot(merged, fileSnapshot({ text: 'V2', revision: 'r2' }))
  assert.equal(draftOf(reset, 'f1').content, 'V2')
  assert.equal(draftOf(reset, 'f1').savedContent, 'V2')
  assert.equal(draftOf(reset, 'f1').revision, 'r2')
  assert.equal(draftOf(reset, 'f1').conflict, undefined)
})

test('instruction drafts：未改动文件采纳磁盘新版本', () => {
  const base = poolFromSnapshot(snapshotOf([fileSnapshot()]), 1)
  const merged = poolFromSnapshot(snapshotOf([fileSnapshot({ text: 'V2', revision: 'r2' })]), 2, base)
  assert.equal(draftOf(merged, 'f1').content, 'V2')
  assert.equal(draftOf(merged, 'f1').revision, 'r2')
  assert.equal(merged.seq, 2)
})

test('instruction drafts：保存成功只更新请求快照基线，期间新输入仍 dirty', () => {
  const base = poolFromSnapshot(snapshotOf([fileSnapshot()]), 1)
  const dirty = setDraftContent(base, 'f1', 'V1 first edit')
  const request = instructionSaveRequest(dirty, 'f1')
  const saving = markDraftSaving(dirty, 'f1', true)
  const more = setDraftContent(saving, 'f1', 'V1 second edit')
  const done = applySaveSuccess(more, 'f1', request, 'r9')
  const draft = draftOf(done, 'f1')
  assert.equal(draft.savedContent, 'V1 first edit')
  assert.equal(draft.content, 'V1 second edit')
  assert.equal(draft.revision, 'r9')
  assert.equal(draft.saving, false)
  assert.equal(canSaveDraft(done, draft), true)
})

test('instruction drafts：保存失败与冲突都保留草稿', () => {
  const base = poolFromSnapshot(snapshotOf([fileSnapshot()]), 1)
  const dirty = setDraftContent(base, 'f1', 'my draft')
  const failed = applySaveFailure(dirty, 'f1', '写盘失败')
  assert.equal(draftOf(failed, 'f1').content, 'my draft')
  assert.equal(draftOf(failed, 'f1').error, '写盘失败')
  assert.equal(canSaveDraft(failed, draftOf(failed, 'f1')), true)

  const conflicted = applySaveFailure(dirty, 'f1', '文件已在磁盘上被修改', { conflict: true })
  assert.equal(draftOf(conflicted, 'f1').content, 'my draft')
  assert.equal(canSaveDraft(conflicted, draftOf(conflicted, 'f1')), false)
})

test('instruction drafts：保存全部按文件报告结果', () => {
  const base = poolFromSnapshot(snapshotOf([
    fileSnapshot(),
    fileSnapshot({ fileId: 'f2', path: 'D:/repo/CLAUDE.md', displayPath: 'CLAUDE.md', text: 'B', revision: 'r2' }),
  ]), 1)
  const dirty = setDraftContent(setDraftContent(base, 'f1', 'A2'), 'f2', 'B2')
  const requests = new Map([
    ['f1', instructionSaveRequest(dirty, 'f1')],
    ['f2', instructionSaveRequest(dirty, 'f2')],
  ])
  const next = applySaveOutcomes(dirty, [
    { fileId: 'f1', ok: true, revision: 'r1b' },
    { fileId: 'f2', ok: false, message: '版本冲突', conflict: true },
  ], requests)
  const first = draftOf(next, 'f1')
  const second = draftOf(next, 'f2')
  assert.equal(first.content, 'A2')
  assert.equal(first.revision, 'r1b')
  assert.equal(canSaveDraft(next, first), false)
  assert.equal(second.content, 'B2')
  assert.equal(second.revision, 'r2')
  assert.equal(second.conflict, true)
  assert.equal(canSaveDraft(next, second), false)
})

test('instruction drafts：读取失败不是空正文，空文件仍可编辑保存', () => {
  const broken = poolFromSnapshot(snapshotOf([
    fileSnapshot({ status: 'unreadable', text: '', revision: null, message: 'EACCES' }),
  ]), 1)
  const brokenDraft = draftOf(broken, 'f1')
  assert.equal(brokenDraft.status, 'unreadable')
  assert.equal(brokenDraft.revision, null)
  assert.equal(canSaveDraft(broken, brokenDraft), false)
  assert.equal(instructionSaveRequest(broken, 'f1'), undefined)

  const empty = poolFromSnapshot(snapshotOf([fileSnapshot({ text: '', revision: 'r-empty' })]), 1)
  const edited = setDraftContent(empty, 'f1', 'first line')
  assert.equal(canSaveDraft(edited, draftOf(edited, 'f1')), true)
  assert.equal(instructionSaveRequest(edited, 'f1').expectedRevision, 'r-empty')
})

test('instruction drafts：上下文切换不可写，迟到响应按序号丢弃，回到原上下文保留草稿', () => {
  const base = poolFromSnapshot(snapshotOf([fileSnapshot()]), 1)
  const dirty = setDraftContent(base, 'f1', 'my draft')
  const switched = switchInstructionContext(dirty, 2)
  assert.equal(canSaveDraft(switched, draftOf(switched, 'f1')), false)
  assert.equal(instructionSaveRequest(switched, 'f1'), undefined)
  assert.equal(isCurrentInstructionSeq(switched, 1), false)
  assert.equal(isCurrentInstructionSeq(switched, 2), true)

  const back = poolFromSnapshot(snapshotOf([fileSnapshot()]), 3, switched)
  assert.equal(draftOf(back, 'f1').content, 'my draft')
  assert.equal(canSaveDraft(back, draftOf(back, 'f1')), true)
})

test('instruction drafts：文件离开范围时保留草稿并禁止写盘', () => {
  const base = poolFromSnapshot(snapshotOf([fileSnapshot()]), 1)
  const dirty = setDraftContent(base, 'f1', 'my draft')
  const gone = poolFromSnapshot(snapshotOf([]), 2, dirty)
  const draft = draftOf(gone, 'f1')
  assert.equal(draft.status, 'missing')
  assert.equal(draft.content, 'my draft')
  assert.equal(draft.revision, 'r1')
  assert.equal(draft.contextId, null)
  assert.equal(canSaveDraft(gone, draft), false)
})
