/**
 * 预设保存后的默认模型同步提示（M-03/M-04 客户端侧）。
 *
 * 关键点：预设已保存与宿主默认同步是两件事，未同步时必须同时表达
 * 「已保存」与「未同步（可重试）」，且不得把凭证或原始请求体带进提示。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { modelSyncNotice } from '../../src/client/data/model-sync-notice.ts'

test('modelSyncNotice：synced / unchanged / 缺省不打扰用户', () => {
  assert.equal(modelSyncNotice(undefined, '预设已保存'), undefined, '无同步事实不提示')
  assert.equal(modelSyncNotice({ status: 'synced' }, '预设已保存'), undefined)
  assert.equal(modelSyncNotice({ status: 'unchanged', message: '宿主默认模型已是目标值' }, '预设已保存'), undefined)
})

test('modelSyncNotice：failed / unavailable 明确区分「已保存」与「未同步」', () => {
  const failed = modelSyncNotice({ status: 'failed', message: '宿主默认模型写入失败' }, '预设已保存')
  assert.equal(failed?.kind, 'error')
  assert.match(failed.message, /预设已保存/)
  assert.match(failed.message, /宿主默认模型同步失败/)
  assert.match(failed.message, /可再次保存重试/)

  const unavailable = modelSyncNotice({ status: 'unavailable' }, '提示词配置已保存')
  assert.equal(unavailable?.kind, 'error')
  assert.match(unavailable.message, /提示词配置已保存/)
  assert.match(unavailable.message, /同步不可用/)
  assert.doesNotMatch(unavailable.message, /（）/, '没有细节时不留空括号')
})

test('modelSyncNotice：提示只带安全文本，不透传路径或凭证', () => {
  const notice = modelSyncNotice(
    { status: 'failed', message: '<path> 写入被拒' },
    '预设已保存',
  )
  assert.ok(notice !== undefined)
  assert.doesNotMatch(notice.message, /[A-Za-z]:\\/)
  assert.doesNotMatch(notice.message, /sk-[A-Za-z0-9]/)
})
