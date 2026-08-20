import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installDefaultModelRoute } from '../../lib/index.mjs'

test('installDefaultModelRoute：参数非空时写入官方 agent-default-model 默认选择', () => {
  const saved = []
  const ctx = {
    get: (name) => name === 'agentDefaultModel'
      ? { saveSelection: (selection) => { saved.push(selection) } }
      : undefined,
  }
  const apply = installDefaultModelRoute(
    ctx,
    () => true,
    () => 'deepseek-official',
    () => 'deepseek-v4-flash',
  )
  assert.deepEqual(saved, [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }], '安装时立即写入一次')
  apply()
  assert.equal(saved.length, 2, '重放幂等写入')
})

test('installDefaultModelRoute：未启用（任一参数为空）时不干预', () => {
  let called = false
  const ctx = {
    get: (name) => name === 'agentDefaultModel'
      ? { saveSelection: () => { called = true } }
      : undefined,
  }
  installDefaultModelRoute(ctx, () => false, () => '', () => '')
  assert.equal(called, false, '未设置固定模型路由时不得覆盖用户选择')
})

test('installDefaultModelRoute：agent-default-model 服务缺失时静默跳过不抛错', () => {
  const ctx = { get: () => undefined }
  const apply = installDefaultModelRoute(ctx, () => true, () => 'p', () => 'm')
  apply()
  assert.ok(true, '服务缺失不应抛异常')
})
