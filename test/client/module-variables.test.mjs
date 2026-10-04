import test from 'node:test'
import assert from 'node:assert/strict'
import { retryModuleVariablesPublication, saveModuleVariables } from '../../src/client/data/module-variables.ts'

const baseline = () => ({ variables: { name: 'before' }, enabled: true, revisions: { rules: { first: 'body-1' }, settings: 'settings-1', variables: 'variables-1' } })
const result = (variables = { name: 'sent' }, extra = {}) => ({ ok: true, value: { variables, enabled: false,
  revisions: { rules: { first: 'body-other' }, settings: 'settings-2', variables: 'variables-2' }, ...extra } })

test('变量 bridge 只携带所写集合的 CAS，不把无关状态指纹升级', async () => {
  const calls = []
  const request = async body => { calls.push(body); return result() }
  const values = await saveModuleVariables('module-a', baseline(), { variables: { name: 'sent', '': 'draft row' }, enabled: true }, request)
  assert.deepEqual(calls[0], { expectedModuleId: 'module-a', expectedRevisions: { variables: 'variables-1' }, variables: { name: 'sent' } })
  assert.deepEqual(values.baseline, { variables: { name: 'sent' }, enabled: true,
    revisions: { rules: { first: 'body-1' }, settings: 'settings-1', variables: 'variables-2' } })
  const enabled = await saveModuleVariables('module-a', values.baseline, { variables: { name: 'sent' }, enabled: false }, request)
  assert.deepEqual(calls[1], { expectedModuleId: 'module-a', expectedRevisions: { settings: 'settings-1' }, enabled: false })
  assert.equal(enabled.baseline.revisions.settings, 'settings-2')
  await saveModuleVariables('module-a', enabled.baseline, { variables: { name: 'sent' }, enabled: false }, request)
  assert.equal(calls.length, 2)
})

test('变量 bridge 拒绝保留旧基线；已保存但发布失败只确认请求快照', async () => {
  const before = baseline()
  await assert.rejects(saveModuleVariables('module-a', before, { variables: { name: 'sent' }, enabled: false }, async () => ({ ok: false, code: 'rules-conflict', message: 'changed' })), /changed/)
  assert.deepEqual(before, baseline())
  let release
  const pending = new Promise(resolve => { release = resolve })
  const desired = { variables: { name: 'sent' }, enabled: true }
  const saving = saveModuleVariables('module-a', before, desired, async () => pending)
  desired.variables.name = 'new typing'
  desired.enabled = false
  release(result({ name: 'sent' }, { persisted: true, publicationError: 'refresh failed' }))
  const saved = await saving
  assert.equal(saved.publicationError, 'refresh failed')
  assert.equal(saved.baseline.publicationPending, true)
  assert.deepEqual(saved.baseline.variables, { name: 'sent' })
  assert.deepEqual(desired, { variables: { name: 'new typing' }, enabled: false }, '在途新输入不会被确认成已保存')
  const calls = []
  let releaseRefresh
  const refreshing = retryModuleVariablesPublication('module-a', saved.baseline, body => { calls.push(body); return new Promise(resolve => { releaseRefresh = resolve }) })
  desired.variables.name = 'typed during refresh'
  releaseRefresh(result({ name: 'sent' }))
  const refreshed = await refreshing
  assert.deepEqual(calls, [{ expectedModuleId: 'module-a', refreshOnly: true }])
  assert.equal(refreshed.baseline.publicationPending, undefined)
  assert.deepEqual(refreshed.baseline.variables, { name: 'sent' })
  assert.equal(desired.variables.name, 'typed during refresh')
})
