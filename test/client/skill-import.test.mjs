import test from 'node:test'
import assert from 'node:assert/strict'
import { requestSkillImport } from '../../src/client/data/skill-import.ts'

const success = { ok: true, value: { path: '/skills', count: 1, overwritten: 1 } }
const conflict = (names) => ({ ok: false, code: 'skills-overwrite-required', conflicts: names })

test('技能导入无冲突直接完成；取消不重发写请求', async () => {
  assert.deepEqual(await requestSkillImport(async () => success, async () => { throw new Error('不应提问') }), success)
  let requests = 0
  const result = await requestSkillImport(async () => { requests += 1; return conflict(['a']) }, async () => false)
  assert.equal(result.code, 'skills-import-cancelled')
  assert.equal(requests, 1)
})

test('技能导入等待确认后只提交已确认目录，新冲突再次确认', async () => {
  const requests = []
  const confirmations = []
  let decide
  const task = requestSkillImport(async (overwrite) => {
    requests.push(overwrite)
    return requests.length === 1 ? conflict(['a']) : requests.length === 2 ? conflict(['b']) : success
  }, async (names) => {
    confirmations.push(names)
    if (names[0] === 'a') return new Promise((resolve) => { decide = resolve })
    return true
  })
  await Promise.resolve()
  assert.deepEqual(requests, [undefined], '确认前没有覆盖请求')
  decide(true)
  assert.deepEqual(await task, success)
  assert.deepEqual(confirmations, [['a'], ['b']])
  assert.deepEqual(requests, [undefined, ['a'], ['a', 'b']])
})
