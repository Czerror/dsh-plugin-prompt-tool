import test from 'node:test'
import assert from 'node:assert/strict'
import { rewindConversation, RewindRecoveryOwner } from '../../src/client/data/rewind.ts'

test('回退入口沿预览边界提交，草稿冲突不覆盖、不重发，提交错误保留原错误', async () => {
  const calls = [], restored = []
  const input = { captureInsertion: () => ({ revision: 5 }), insertText: text => { restored.push(text); return false }, persistDraft: () => assert.fail('冲突不能写草稿') }
  const invoke = async request => {
    calls.push(request)
    return { ok: true, value: { sessionId: 's', boundary: 'fixed', targets: request.phase === 'preview' ? [] : [{ sessionId: 's', status: 'committed', text: '原输入' }] } }
  }
  const result = await rewindConversation({ sessionId: 's', mode: 'once', credential: 'page', input, canRestore: () => true }, invoke)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].requestId, calls[1].requestId)
  assert.equal(calls[1].boundary, 'fixed')
  assert.deepEqual(restored, ['原输入'])
  assert.equal(result.restored, false)
  assert.equal(result.text, '原输入')
  await assert.rejects(rewindConversation({ sessionId: 's', mode: 'once', credential: 'page', input, canRestore: () => true }, async () => ({ ok: false, message: '已进入新轮' })), /已进入新轮/)
  assert.deepEqual(restored, ['原输入'])
})

test('槽位结果owner按会话保存迟到结果并通知重挂视图，不触碰输入', async () => {
  const owner = new RewindRecoveryOwner(), input = { captureInsertion: () => ({}), insertText: () => assert.fail('离开会话不能回填'), persistDraft: () => assert.fail('不能改新会话草稿') }
  const committed = Promise.withResolvers()
  const pending = rewindConversation({ sessionId: 'a', mode: 'once', credential: 'page', input, canRestore: () => false }, async request => request.phase === 'preview' ? { ok: true, value: { boundary: 'fixed', targets: [] } } : committed.promise)
  const originalView = owner.subscribe(() => assert.fail('已卸载视图不接收结果'))
  originalView()
  let notifications = 0
  const stop = owner.subscribe(() => { notifications++ })
  owner.set('b', { notice: '新会话提示', text: '新会话文本' })
  committed.resolve({ ok: true, value: { sessionId: 'a', boundary: 'fixed', targets: [{ sessionId: 'a', status: 'committed', text: '原会话文本' }, { sessionId: 'child', status: 'failed' }] } })
  const outcome = await pending
  owner.set('a', { notice: '部分成功', text: outcome.text, retry: outcome.retry })
  assert.deepEqual(owner.get('b'), { notice: '新会话提示', text: '新会话文本' })
  assert.equal(owner.get('a').text, '原会话文本')
  assert.equal(owner.get('a').retry.sessionId, 'a')
  assert.equal(notifications, 2, '已重挂视图会收到迟到结果通知')
  stop(); owner.clear(); assert.equal(owner.get('a'), undefined)
})

test('未知提交重试与失败目标首次成功均保留文本，同一标记只回填一次', async () => {
  const inserted = [], input = { captureInsertion: () => ({}), insertText: text => { inserted.push(text); return true }, persistDraft() {} }
  const options = { sessionId: 's', mode: 'round', credential: 'page', input, canRestore: () => true }
  let submission
  await assert.rejects(rewindConversation(options, async request => {
    if (request.phase === 'preview') return { ok: true, value: { boundary: 'fixed', targets: [] } }
    submission = request; throw new Error('response lost')
  }), /response lost/)
  const invoke = async () => ({ ok: true, value: { sessionId: 's', boundary: 'fixed', targets: [{ sessionId: 's', status: 'committed', markerId: 'marker-1', text: '原输入' }] } })
  const recovered = await rewindConversation({ ...options, retry: submission }, invoke)
  assert.equal(recovered.text, '原输入'); assert.equal(recovered.restored, true)
  await rewindConversation({ ...options, retry: submission }, invoke)
  assert.deepEqual(inserted, ['原输入'])
  const partial = await rewindConversation(options, async request => ({ ok: true, value: { sessionId: 's', boundary: 'partial', targets: request.phase === 'preview' ? [] : [{ sessionId: 's', status: 'failed' }] } }))
  const succeeded = await rewindConversation({ ...options, retry: partial.retry }, async () => ({ ok: true, value: { sessionId: 's', boundary: 'partial', targets: [{ sessionId: 's', status: 'committed', markerId: 'marker-2', text: '后来成功' }] } }))
  assert.equal(succeeded.text, '后来成功'); assert.deepEqual(inserted, ['原输入', '后来成功'])
})
