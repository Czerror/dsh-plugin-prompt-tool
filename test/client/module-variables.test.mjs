import test from 'node:test'
import assert from 'node:assert/strict'
import { getVariablesDraft, readVariablesDraft, retryModuleVariablesPublication, saveModuleVariables } from '../../src/client/data/module-variables.ts'

const baseline = (scope = 'module') => ({ scope, variables: { name: 'before' }, enabled: true, revisions: { global: 'global-1', module: 'module-1', settings: 'settings-1' } })
const result = (variables = { name: 'sent' }, extra = {}) => ({ ok: true, value: { module: variables, global: { common: 'GLOBAL' }, effective: { common: 'GLOBAL', ...variables }, enabled: false,
  revisions: { global: 'global-2', module: 'module-2', settings: 'settings-2' }, ...extra } })

test('变量 bridge 只携带所写集合的 CAS，不把无关状态指纹升级', async () => {
  const calls = []
  const request = async body => { calls.push(body); return result() }
  const values = await saveModuleVariables('module-a', baseline(), { variables: { name: 'sent', empty: '', '': 'draft row' }, enabled: true }, request)
  assert.deepEqual(calls[0], { scope: 'module', expectedModuleId: 'module-a', expectedRevisions: { module: 'module-1' }, variables: { name: 'sent', empty: '' } })
  assert.deepEqual(values.baseline, { scope: 'module', variables: { name: 'sent', empty: '' }, enabled: true,
    revisions: { global: 'global-1', settings: 'settings-1', module: 'module-2' } })
  const enabled = await saveModuleVariables('module-a', values.baseline, { variables: values.baseline.variables, enabled: false }, request)
  assert.deepEqual(calls[1], { scope: 'module', expectedModuleId: 'module-a', expectedRevisions: { settings: 'settings-1' }, enabled: false })
  assert.equal(enabled.baseline.revisions.settings, 'settings-2')
  await saveModuleVariables('module-a', baseline('global'), { variables: { shared: '' }, enabled: false }, request)
  assert.deepEqual(calls[2], { scope: 'global', expectedModuleId: 'module-a', expectedRevisions: { global: 'global-1' }, variables: { shared: '' } })
  await saveModuleVariables('module-a', enabled.baseline, { variables: enabled.baseline.variables, enabled: false }, request)
  assert.equal(calls.length, 3)
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
  assert.deepEqual(calls, [{ scope: 'module', expectedModuleId: 'module-a', refreshOnly: true }])
  assert.equal(refreshed.baseline.publicationPending, undefined)
  assert.deepEqual(refreshed.baseline.variables, { name: 'sent' })
  assert.equal(desired.variables.name, 'typed during refresh')
})

test('变量读取按模块和范围隔离草稿，迟到响应不能覆盖新读取或未保存空行', async () => {
  const drafts = new Map(), calls = []
  const module = getVariablesDraft(drafts, 'module-a', 'module')
  const global = getVariablesDraft(drafts, 'module-a', 'global')
  const other = getVariablesDraft(drafts, 'module-b', 'module')
  let late
  const pending = readVariablesDraft('module-a', module, body => { calls.push(body); return new Promise(resolve => { late = resolve }) })
  await readVariablesDraft('module-a', module, async body => { calls.push(body); return result({ name: 'sent', empty: '' }) })
  module.variables = { ...module.variables, '': '' }
  await readVariablesDraft('module-a', global, async body => { calls.push(body); return result() })
  late(result({ name: 'STALE' }))
  await pending
  assert.deepEqual(module.variables, { name: 'sent', empty: '', '': '' })
  assert.deepEqual(global.variables, { common: 'GLOBAL' })
  assert.deepEqual(other.variables, {})
  assert.deepEqual(calls.map(body => [body.expectedModuleId, body.scope]), [['module-a', 'module'], ['module-a', 'module'], ['module-a', 'global']])
  await readVariablesDraft('module-a', module, async () => result({ name: 'EXTERNAL' }))
  assert.equal(module.variables.name, 'sent', '远端新值不覆盖本地未保存草稿')
  assert.equal(Object.hasOwn(module.variables, ''), true, '新建空白行在后台读取后仍保留')
  const outgoing = []
  const saved = await saveModuleVariables('module-a', module.baseline, { variables: module.variables, enabled: true }, async body => { outgoing.push(body); return result({ name: 'sent', empty: '' }) })
  assert.equal(Object.hasOwn(module.variables, ''), true, '保存开关不删除用户待编辑的空白行')
  assert.equal(outgoing[0].variables, undefined, '只保存开关，空白行不误写也不触发清空变量')
  module.baseline = saved.baseline
  module.variables = { name: 'sent', empty: '', created: '' }
  await saveModuleVariables('module-a', module.baseline, { variables: module.variables, enabled: true }, async body => { outgoing.push(body); return result(module.variables) })
  assert.deepEqual(outgoing[1].variables, { name: 'sent', empty: '', created: '' }, '命名完成的空字符串变量照常保存')
})
