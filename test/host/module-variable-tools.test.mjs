import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-module-variable-tools-')
const { globalVariablesFile } = await import('../../src/host/paths.ts')
const { resolveModuleToolTarget } = await import('../../src/host/module-tool-target.ts')
const tick = () => new Promise(resolve => setImmediate(resolve))
async function setup(t, id, late = false, sessionStorage = false) {
  const dir = join(moduleRoot, id), file = join(dir, 'module.yml')
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, `id: ${id}\nmodules: []\nrules: []\nvariables: { keep: KEEP, blank: "" }\n`)
  rmSync(globalVariablesFile(), { force: true })
  t.after(() => rmSync(globalVariablesFile(), { force: true }))
  const { registerModuleVariableTools } = await import('../../src/runtime/module-variable-tools.ts')
  const shell = await import('../../engine/module-variable-tools.mjs')
  const root = new Context()
  await root.plugin(SystemPrompt)
  let sessionOwner, pauseWrite, withdrawOwner
  if (sessionStorage) {
    const storage = new Storage(root), backend = new JsonStorageBackend(join(dir, 'official-storage'))
    const open = backend.kv.open
    let gate
    backend.kv.open = async descriptor => {
      const unit = await open(descriptor), put = unit.putRecord.bind(unit)
      unit.putRecord = async (...args) => { if (gate) { const waiting = gate; gate = undefined; waiting.started(); await waiting.wait } return put(...args) }
      return unit
    }
    pauseWrite = () => {
      let resume, started
      const wait = new Promise(resolve => { resume = resolve }), entered = new Promise(resolve => { started = resolve })
      gate = { wait, started }; return { resume, entered }
    }
    storage.backend.register('json', backend)
    const facility = new DomainFacility(root, { backend: 'json' })
    const { openSessionVariables } = await import('../../src/host/session-variables.ts')
    sessionOwner = await openSessionVariables(facility)
    const owned = sessionOwner
    withdrawOwner = () => { sessionOwner = undefined; return owned }
    t.after(async () => { await owned.dispose(); await facility.closeAll(); await backend.close() })
  }
  if (!late) { await root.plugin(ToolRuntime); await root.plugin(NativeExecutor) }
  t.after(() => root.fiber.dispose())
  const targets = { ids: [id] }
  const host = { target: (exec, moduleId) => resolveModuleToolTarget(exec, moduleRoot, () => targets.ids, moduleId), rebuild: async () => { assert.fail('变量内容更新不能重新装配 Agent') } }
  root.provide('pt-module-variable-tools', { mount: ctx => registerModuleVariableTools(ctx, host, () => sessionOwner) })
  const agent = { id: 'agent-' + id, session: { id: 'session-' + id, header: {} } }
  const scope = createScope(root, agent)
  agent.ctx = scope.ctx
  const wrapper = await scope.ctx.plugin(shell)
  await tick()
  let calls = 0
  const call = async (args, signal = new AbortController().signal, caller = agent) => (await root.tools.execute({
    calls: [{ type: 'tool-call', id: 'call-' + ++calls, name: 'module_variables', arguments: JSON.stringify(args) }], agent: caller, signal,
  })).results[0].result
  const success = async args => { const result = await call(args); assert.equal(result.isError, false, JSON.stringify(result)); return result.value }
  return { root, scope, agent, targets, wrapper, call, success, file, dir, sessionOwner, pauseWrite, withdrawOwner }
}

test('变量工具主路径：两级持久值、空占位、来源与显式删除回落在真实工具管线往返', async t => {
  const f = await setup(t, 'values')
  const before = await f.success({ action: 'list', scope: 'module', moduleId: 'values' })
  assert.deepEqual(before.variables, { keep: 'KEEP', blank: '' })
  const missing = await f.success({ action: 'get', scope: 'module', moduleId: 'values', key: 'toString' })
  assert.equal(missing.value, null)
  assert.equal(missing.source, null)
  const global = await f.success({ action: 'set', scope: 'global', moduleId: 'values', key: 'mood', value: 'calm', expectedRevisions: before.revisions })
  assert.equal(global.source, 'global')
  const local = await f.success({ action: 'set', scope: 'module', moduleId: 'values', key: 'mood', value: '', expectedRevisions: global.revisions })
  assert.equal(local.value, '')
  assert.equal(local.source, 'module')
  assert.deepEqual(parse(readFileSync(f.file, 'utf8')).variables, { keep: 'KEEP', blank: '', mood: '' })
  const child = { id: 'child-values', session: { id: 'child-values', header: { delegationDepth: 1 } } }
  child.ctx = createScope(f.root, child, { parent: f.agent }).ctx
  const childRead = await f.call({ action: 'get', scope: 'module', moduleId: 'values', key: 'mood' }, undefined, child)
  assert.equal(childRead.isError, false, JSON.stringify(childRead))
  assert.equal(childRead.value.value, '')
  const deleted = await f.success({ action: 'delete', scope: 'module', moduleId: 'values', key: 'mood', expectedRevisions: local.revisions })
  assert.equal(deleted.value, 'calm')
  assert.equal(deleted.source, 'global')
  assert.equal((await f.success({ action: 'get', scope: 'module', moduleId: 'values', key: 'keep' })).value, 'KEEP')
})

test('会话变量工具在真实执行会话内持久覆盖，拒绝伪造会话和过期版本', async t => {
  const f = await setup(t, 'session-tool', false, true)
  const before = await f.success({ action: 'list', scope: 'session', moduleId: 'session-tool' })
  assert.equal(before.variables.keep, 'KEEP')
  assert.equal(before.revisions.session, null)
  const saved = await f.success({ action: 'set', scope: 'session', moduleId: 'session-tool', key: 'keep', value: '', expectedRevisions: before.revisions })
  assert.equal(saved.value, '')
  assert.equal(saved.source, 'session')
  assert.equal(saved.persisted, true)
  assert.equal(f.sessionOwner.read(f.dir, f.agent.session.id).variables.keep, '')
  assert.equal(parse(readFileSync(f.file, 'utf8')).variables.keep, 'KEEP')
  const child = { id: 'session-tool-child', session: { id: 'session-tool-child', header: { delegationDepth: 1 } } }
  child.ctx = createScope(f.root, child, { parent: f.agent }).ctx
  const childRead = await f.call({ action: 'get', scope: 'session', moduleId: 'session-tool', key: 'keep' }, undefined, child)
  assert.equal(childRead.isError, false)
  assert.equal(childRead.value.value, 'KEEP')
  assert.equal((await f.call({ action: 'set', scope: 'session', moduleId: 'session-tool', key: 'keep', value: 'STALE', expectedRevisions: before.revisions })).isError, true)
  assert.equal((await f.call({ action: 'set', scope: 'session', moduleId: 'session-tool', key: 'keep', value: 'FORGED', expectedRevisions: saved.revisions, sessionId: child.session.id })).isError, true)
  const removed = await f.success({ action: 'delete', scope: 'session', moduleId: 'session-tool', key: 'keep', expectedRevisions: saved.revisions })
  assert.equal(removed.value, 'KEEP')
  assert.equal(removed.source, 'module')
  const paused = f.pauseWrite()
  const pending = f.call({ action: 'set', scope: 'session', moduleId: 'session-tool', key: 'keep', value: 'WITHDRAWN BODY', expectedRevisions: removed.revisions })
  await paused.entered
  const owned = f.withdrawOwner()
  paused.resume()
  const finished = await pending
  assert.equal(finished.isError, false, '已持久写不能冒充失败而诱发重试')
  assert.equal(finished.value.persisted, true)
  assert.equal(finished.value.publicationSuppressed, true)
  assert.equal(Object.hasOwn(finished.value, 'value'), false)
  assert.doesNotMatch(JSON.stringify(finished.content), /WITHDRAWN BODY/)
  assert.equal(owned.read(f.dir, f.agent.session.id).variables.keep, 'WITHDRAWN BODY')
})

test('变量工具拒绝：缺 value 不清 KEEP，过期版本/未知域/越权目标/取消和批准拒绝均不写盘', async t => {
  const f = await setup(t, 'reject')
  const before = await f.success({ action: 'list', scope: 'module', moduleId: 'reject' })
  const bytes = readFileSync(f.file, 'utf8')
  for (const request of [
    { action: 'set', key: 'keep' },
    { action: 'set', key: 'keep', value: null },
    { action: 'set', key: 'keep', value: 'LOST', expectedRevisions: {} },
    { action: 'set', key: 'keep', value: 'LOST', moduleId: 'elsewhere' },
    { action: 'set', scope: 'session', key: 'keep', value: 'LOST' },
    { action: 'set', key: 'CWD', value: 'LOST' },
    { action: 'list', path: 'outside' },
  ]) {
    assert.equal((await f.call({ scope: 'module', moduleId: 'reject', expectedRevisions: before.revisions, ...request })).isError, true)
    assert.equal(readFileSync(f.file, 'utf8'), bytes)
  }
  f.targets.ids = []
  assert.equal((await f.call({ action: 'list', scope: 'module' })).isError, true, '没有声明模块目标仍拒绝，不回退装配记录')
  assert.equal((await f.success({ action: 'list', scope: 'module', moduleId: 'reject' })).moduleId, 'reject', '主语只来自声明')
  f.targets.ids = ['reject']
  const abort = new AbortController()
  abort.abort()
  assert.equal((await f.call({ action: 'delete', scope: 'module', key: 'keep', moduleId: 'reject', expectedRevisions: before.revisions }, abort.signal)).isError, true)
  const deny = f.root.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'test policy' }))
  assert.equal((await f.call({ action: 'delete', scope: 'module', key: 'keep', moduleId: 'reject', expectedRevisions: before.revisions })).isError, true)
  deny()
  assert.equal(readFileSync(f.file, 'utf8'), bytes)
  const changed = await f.success({ action: 'set', scope: 'module', key: 'other', value: 'KEPT', moduleId: 'reject', expectedRevisions: before.revisions })
  assert.notDeepEqual(changed.revisions, before.revisions)
  const current = readFileSync(f.file, 'utf8')
  assert.equal((await f.call({ action: 'set', scope: 'module', key: 'keep', value: 'LOST', moduleId: 'reject', expectedRevisions: before.revisions })).isError, true)
  assert.equal(readFileSync(f.file, 'utf8'), current)
})

test('变量工具主语来自参数：不声明拒绝，声明谁就读写谁、装配记录为空也不改判', async t => {
  const f = await setup(t, 'subject')
  const otherDir = join(moduleRoot, 'subject-other')
  mkdirSync(otherDir, { recursive: true })
  writeFileSync(join(otherDir, 'module.yml'), 'id: subject-other\nmodules: []\nrules: []\nvariables: { keep: OTHER }\n')
  f.targets.ids = ['subject', 'subject-other']

  const missing = await f.call({ action: 'list', scope: 'module' })
  assert.equal(missing.isError, true)
  assert.match(missing.error.message, /没有声明模块目标/)
  assert.match(missing.error.message, /subject-other/, '拒绝文案列出可选模块')

  const read = await f.success({ action: 'get', scope: 'module', moduleId: 'subject-other', key: 'keep' })
  assert.equal(read.value, 'OTHER', '读的是声明模块自己的值，不是装配记录首项')
  assert.equal(read.source, 'module')
  // 编辑通道不查启用：本 Agent 一层都没装，声明了模块还是能写它。
  f.targets.ids = []
  const written = await f.success({ action: 'set', scope: 'module', moduleId: 'subject-other', key: 'mood', value: 'calm', expectedRevisions: read.revisions })
  assert.equal(written.source, 'module')
  assert.deepEqual(parse(readFileSync(join(otherDir, 'module.yml'), 'utf8')).variables, { keep: 'OTHER', mood: 'calm' })
  assert.deepEqual(parse(readFileSync(f.file, 'utf8')).variables, { keep: 'KEEP', blank: '' }, '声明了别的模块就不写本模块')
})

test('变量工具边界：tools 服务晚到后挂载，卸载释放且重挂读取已保存值', async t => {
  const f = await setup(t, 'lifecycle', true)
  await f.root.plugin(ToolRuntime)
  await f.root.plugin(NativeExecutor)
  await tick()
  const before = await f.success({ action: 'list', scope: 'module', moduleId: 'lifecycle' })
  await f.success({ action: 'set', scope: 'module', key: 'new-placeholder', value: '', moduleId: 'lifecycle', expectedRevisions: before.revisions })
  await f.wrapper.dispose()
  await tick()
  assert.equal((await f.call({ action: 'list', scope: 'module', moduleId: 'lifecycle' })).isError, true)
  await f.scope.ctx.plugin(await import('../../engine/module-variable-tools.mjs'))
  await tick()
  const reloaded = await f.success({ action: 'list', scope: 'module', moduleId: 'lifecycle' })
  assert.deepEqual(reloaded.variables, { keep: 'KEEP', blank: '', 'new-placeholder': '' })
  assert.equal(f.root.tools.schemas(f.agent).filter(tool => tool.name === 'module_variables').length, 1)
})
