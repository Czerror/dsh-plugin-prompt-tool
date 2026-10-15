import test from 'node:test'
import assert from 'node:assert/strict'
import { beginLatest, isLatest } from '../../src/client/data/resource-track.ts'

// 最新优先是六个资源编辑器共用的一条策略：只有最新一次请求拥有落地与清理权。
// 各家用自己的行为测试覆盖落地路径（如 module-variables.test.mjs 的「迟到响应不能覆盖新读取」），
// 这里只钉住原语本身的判据，免得策略被「顺手」改成 >= 或把清理权给晚到者。
test('最新优先：序号单调递增，只有最新一次请求算当前', () => {
  const holder = { latest: 0 }
  const first = beginLatest(holder)
  assert.equal(first, 1)
  assert.equal(isLatest(holder, first), true)
  const second = beginLatest(holder)
  assert.equal(second, 2)
  assert.equal(isLatest(holder, first), false, '旧请求在新请求开始后不再是最新')
  assert.equal(isLatest(holder, second), true)
  assert.equal(isLatest(holder, second + 1), false, '未来序号不算当前')
})
