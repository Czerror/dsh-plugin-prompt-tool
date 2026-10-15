/**
 * 指令文件草稿协议的行为回归（`src/client/data/instruction-drafts.ts`，294 行，此前零用例）。
 *
 * 真值源是协议语义本身：请求形状、冲突后「必须先重读」、上下文切换与迟到序号、多文件结果各归各。
 * 断言全部落在导出的公共函数上，不 mock 内部模块；真机交互（按钮、焦点、脏提示）不在这里。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_INSTRUCTION_POOL,
  applySaveFailure,
  applySaveOutcomes,
  applySaveSuccess,
  canSaveDraft,
  instructionSaveRequest,
  isCurrentInstructionSeq,
  poolFromSnapshot,
  saveableInstructionDrafts,
  setDraftContent,
  switchInstructionContext,
  unsavedInstructionDrafts,
} from '../../src/client/data/instruction-drafts.ts'

const file = (fileId, text, revision = `rev-${fileId}`) => ({
  fileId,
  path: `/workspace/${fileId}.md`,
  displayPath: fileId === 'global' ? '~/.dsh/AGENTS.md' : './AGENTS.md',
  scope: fileId === 'global' ? 'global' : 'project',
  status: 'ready',
  text,
  revision,
})

const snapshot = (files, contextId = 'ctx-1') => ({
  context: { contextId, cwd: '/workspace', source: 'session' },
  files,
  owner: { officialInstructions: null },
})

test('主路径：请求形状固定，保存成功只确认请求时的快照', () => {
  const pool = poolFromSnapshot(snapshot([file('global', 'BASE\n')]), 1)
  const draft = pool.drafts[0]
  assert.equal(canSaveDraft(pool, draft), false, '没改动不发请求')
  assert.equal(instructionSaveRequest(pool, 'global'), undefined)

  const edited = setDraftContent(pool, 'global', 'EDITED\n')
  assert.deepEqual(instructionSaveRequest(edited, 'global', 'session-a'), {
    sessionId: 'session-a',
    contextId: 'ctx-1',
    fileId: 'global',
    expectedRevision: 'rev-global',
    content: 'EDITED\n',
  })
  assert.equal(instructionSaveRequest(edited, 'global', '').sessionId, undefined, '空 sessionId 不进载荷')

  const request = instructionSaveRequest(edited, 'global')
  // 在途期间用户继续输入：基线只认请求快照，后输入仍算未保存。
  const typed = setDraftContent(edited, 'global', 'TYPING MORE\n')
  const saved = applySaveSuccess(typed, 'global', request, 'rev-next')
  assert.equal(saved.drafts[0].savedContent, 'EDITED\n')
  assert.equal(saved.drafts[0].content, 'TYPING MORE\n')
  assert.equal(saved.drafts[0].revision, 'rev-next')
  assert.deepEqual(unsavedInstructionDrafts(saved).map((draft) => draft.fileId), ['global'])
})

test('关键拒绝：冲突保留草稿与旧基线，此后不再发注定失败的请求', () => {
  const pool = setDraftContent(poolFromSnapshot(snapshot([file('global', 'BASE\n')]), 1), 'global', 'MINE\n')
  const failed = applySaveFailure(pool, 'global', '文件已被外部修改', { conflict: true })
  const draft = failed.drafts[0]
  assert.equal(draft.content, 'MINE\n', '用户输入不丢')
  assert.equal(draft.savedContent, 'BASE\n', '旧基线不动')
  assert.equal(draft.revision, 'rev-global')
  assert.equal(draft.conflict, true)
  assert.equal(draft.error, '文件已被外部修改')
  assert.equal(canSaveDraft(failed, draft), false)
  assert.deepEqual(saveableInstructionDrafts(failed), [], '冲突未解决前不可提交')
  assert.equal(instructionSaveRequest(failed, 'global'), undefined)
})

test('边界·上下文：切上下文保住草稿但不可写，迟到序号不写回', () => {
  const pool = setDraftContent(poolFromSnapshot(snapshot([file('global', 'BASE\n')]), 4), 'global', 'MINE\n')
  const switched = switchInstructionContext(pool, 5)
  assert.equal(switched.drafts[0].content, 'MINE\n', '切上下文不丢草稿')
  assert.equal(switched.contextId, null)
  assert.equal(switched.source, 'global-only')
  assert.equal(canSaveDraft(switched, switched.drafts[0]), false)
  assert.deepEqual(saveableInstructionDrafts(switched), [])
  assert.equal(isCurrentInstructionSeq(switched, 4), false, '旧序号的迟到响应不得写回')
  assert.equal(isCurrentInstructionSeq(switched, 5), true)
  // 迟到快照按新序号重建时，旧序号仍然过期。
  const rebuilt = poolFromSnapshot(snapshot([file('global', 'DISK\n')], 'ctx-2'), 6, pool)
  assert.equal(isCurrentInstructionSeq(rebuilt, 4), false)
  assert.equal(rebuilt.contextId, 'ctx-2')
})

test('边界·部分成功：逐文件结果各归各，不宣称跨文件原子', () => {
  const pool = setDraftContent(
    setDraftContent(poolFromSnapshot(snapshot([file('global', 'G-BASE\n'), file('project', 'P-BASE\n')]), 2), 'global', 'G-NEW\n'),
    'project', 'P-NEW\n',
  )
  const requests = new Map([
    ['global', instructionSaveRequest(pool, 'global')],
    ['project', instructionSaveRequest(pool, 'project')],
  ])
  const next = applySaveOutcomes(pool, [
    { fileId: 'global', ok: true, revision: 'g-2' },
    { fileId: 'project', ok: false, message: '项目文件被外部修改', conflict: true },
  ], requests)
  const [global, project] = next.drafts
  assert.equal(global.savedContent, 'G-NEW\n', '成功项采纳请求快照为新基线')
  assert.equal(global.revision, 'g-2')
  assert.equal(global.conflict, undefined)
  assert.equal(project.savedContent, 'P-BASE\n', '失败项保留旧基线')
  assert.equal(project.content, 'P-NEW\n')
  assert.equal(project.conflict, true, '失败项标冲突，等待重新读取')
  assert.deepEqual(unsavedInstructionDrafts(next).map((draft) => draft.fileId), ['project'])
  assert.equal(EMPTY_INSTRUCTION_POOL.contextId, null, '空池是「尚无服务端解析结果」的明确状态')
})
