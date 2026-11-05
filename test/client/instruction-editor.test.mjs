/**
 * 指令文件编辑 owner 的 seam 回归（`src/client/data/instruction-editor.ts`）。
 *
 * 这三条只在组合层成立：纯函数测试看不出「会话变了还在写」「冲突后没保留草稿」
 * 「策略 409 后仍用旧 revision」。断言落在注入的 request 载荷与 owner 的公共读数上。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createInstructionEditor } from '../../src/client/data/instruction-editor.ts'

const context = (contextId) => ({ contextId, cwd: '/work', source: 'session' })

const file = (fileId, text, revision = `rev-${fileId}`) => ({
  fileId,
  path: `/work/${fileId}`,
  displayPath: fileId,
  scope: 'project',
  status: 'ready',
  text,
  revision,
})

const instructionsSnapshot = (contextId, files) => ({ context: context(contextId), files, owner: { officialInstructions: null } })

const policyOk = (revision) => ({ ok: true, value: { policy: { files: {} }, revision, exists: true } })

function makeEditor(responses = {}) {
  const calls = []
  const notices = []
  let session = 'session-a'
  const editor = createInstructionEditor({
    request: async (endpoint, body) => {
      calls.push({ endpoint, body })
      const handler = responses[endpoint]
      if (handler === undefined) return { ok: false, message: `unexpected ${endpoint}` }
      return typeof handler === 'function' ? handler(body) : handler
    },
    sessionId: () => session,
    notify: (kind, message) => { notices.push({ kind, message }) },
    onChange: () => {},
  })
  return { editor, calls, notices, setSession: (next) => { session = next } }
}

/** 一个已读入两个文件的 owner：两条都在同一上下文里，可写。 */
function ready() {
  const harness = makeEditor()
  harness.editor.switchSession('session-a')
  harness.editor.ingestSnapshot({
    instructions: instructionsSnapshot('ctx-a', [file('a', 'A'), file('b', 'B')]),
    promptConfigs: { promptConfigs: [] },
    policyResult: policyOk('policy-1'),
    expectPolicy: harness.editor.getPolicy(),
  })
  harness.editor.patchText('a', 'A1')
  harness.editor.patchText('b', 'B1')
  return harness
}

test('逐文件结果：一个成功一个冲突，成功文件立即确认基线，失败草稿保留并报出原因', async () => {
  const harness = makeEditor({
    agentsFile: (body) => body.fileId === 'a'
      ? { ok: true, value: { fileId: 'a', revision: 'rev-a2' } }
      : { ok: false, code: 'agents-file-conflict', message: '文件已在磁盘上变化' },
  })
  harness.editor.switchSession('session-a')
  harness.editor.ingestSnapshot({
    instructions: instructionsSnapshot('ctx-a', [file('a', 'A'), file('b', 'B')]),
    promptConfigs: { promptConfigs: [] },
    policyResult: policyOk('policy-1'),
    expectPolicy: harness.editor.getPolicy(),
  })
  harness.editor.patchText('a', 'A1')
  harness.editor.patchText('b', 'B1')

  assert.equal(await harness.editor.saveFiles(), false)

  const drafts = harness.editor.getPool().drafts
  assert.equal(drafts.find((draft) => draft.fileId === 'a').revision, 'rev-a2', '成功文件立即确认新版本')
  assert.equal(drafts.find((draft) => draft.fileId === 'a').savedContent, 'A1')
  assert.equal(drafts.find((draft) => draft.fileId === 'b').content, 'B1', '失败草稿保留用户正文')
  assert.equal(drafts.find((draft) => draft.fileId === 'b').conflict, true, '冲突标记可供卡片提示')
  assert.equal(harness.notices.length, 1, '整批只报一次')
  assert.equal(harness.notices[0].kind, 'error')
  assert.match(harness.notices[0].message, /1\/2/, '报出失败数与总数')
  assert.match(harness.notices[0].message, /文件已在磁盘上变化/, '逐文件原因不被吞掉')
})

test('在途会话变化：不再发第二个请求，迟到响应不写回草稿', async () => {
  const harness = makeEditor({
    agentsFile: () => {
      harness.setSession('session-b')
      return { ok: true, value: { fileId: 'a', revision: 'rev-a2' } }
    },
  })
  harness.editor.switchSession('session-a')
  harness.editor.ingestSnapshot({
    instructions: instructionsSnapshot('ctx-a', [file('a', 'A'), file('b', 'B')]),
    promptConfigs: { promptConfigs: [] },
    policyResult: policyOk('policy-1'),
    expectPolicy: harness.editor.getPolicy(),
  })
  harness.editor.patchText('a', 'A1')
  harness.editor.patchText('b', 'B1')

  assert.equal(await harness.editor.saveFiles(), false)

  assert.equal(harness.calls.filter((call) => call.endpoint === 'agentsFile').length, 1, '切换后不继续提交批次')
  assert.equal(harness.editor.getPool().drafts.find((draft) => draft.fileId === 'a').revision, 'rev-a', '迟到成功不写入')
  assert.equal(harness.editor.getPool().drafts.find((draft) => draft.fileId === 'b').saving, true, '未发出的请求不会被误清忙碌态')
})

test('策略乐观并发：409 不更新快照，下一次请求仍带读取时的 revision', async () => {
  let attempt = 0
  const harness = makeEditor({
    // 第一次 409，第二次成功：版本冲突不因重试而自愈，但用户再点一次应当带同一基线发出去。
    instructionsPolicy: () => {
      attempt += 1
      return attempt === 1
        ? { ok: false, code: 'instructions-policy-conflict', message: '策略已变化' }
        : { ok: true, value: { policy: { files: { a: { enabled: false } } }, revision: 'policy-2', exists: true } }
    },
  })
  harness.editor.switchSession('session-a')
  harness.editor.ingestSnapshot({
    instructions: instructionsSnapshot('ctx-a', [file('a', 'A')]),
    promptConfigs: { promptConfigs: [] },
    policyResult: policyOk('policy-1'),
    expectPolicy: harness.editor.getPolicy(),
  })

  assert.equal(await harness.editor.updatePolicy('a', { enabled: false }), false)
  assert.equal(harness.editor.getPolicy().revision, 'policy-1', '失败不改本地版本')

  const requests = () => harness.calls.filter((call) => call.endpoint === 'instructionsPolicy')
  assert.equal(requests().at(-1).body.expectedRevision, 'policy-1', '重试仍用读取时版本')

  harness.calls.length = 0
  assert.equal(await harness.editor.updatePolicy('a', { enabled: false }), true)
  assert.equal(requests()[0].body.expectedRevision, 'policy-1')
  assert.equal(harness.editor.getPolicy().revision, 'policy-2', '成功后才更新版本')
})
