import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { isolatedHome } from '../fixtures/host-harness.mjs'
const { home, moduleRoot } = isolatedHome('pt-session-variables-')
const { openSessionVariables } = await import('../../src/host/session-variables.ts')
const { revisionOf } = await import('../../src/host/module-write.ts')
const { readModuleVariables, editModuleVariables } = await import('../../src/host/module-variables.ts')
let sequence = 0
async function fixture(t) {
  const id = `session-${++sequence}`, dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), `id: ${id}\nmodules: []\nvariables: { count: '1' }\n`)
  const ctx = new Context(), storage = new Storage(ctx), backend = new JsonStorageBackend(join(home, id))
  const open = backend.kv.open
  let pause
  backend.kv.open = async descriptor => {
    const unit = await open(descriptor), put = unit.putRecord.bind(unit)
    unit.putRecord = async (...args) => { if (pause) { const waiting = pause; pause = undefined; waiting.started(); await waiting.wait } return put(...args) }
    return unit
  }
  storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  let owner = await openSessionVariables(facility)
  t.after(async () => { await owner.dispose(); await facility.closeAll(); await backend.close(); await ctx.fiber.dispose() })
  return { dir, owner, pause: () => { let resume, started; const wait = new Promise(resolve => { resume = resolve }), entered = new Promise(resolve => { started = resolve }); pause = { wait, started }; return { entered, resume } }, reopen: async () => { await owner.dispose(); owner = await openSessionVariables(facility); return owner } }
}
test('会话变量主路径：旧mark首读零写，首写一次迁移，模块与会话隔离并持久恢复', async t => {
  const f = await fixture(t), path = join(f.dir, 'data/.soul', `state-${revisionOf('a')}.json`)
  mkdirSync(join(f.dir, 'data/.soul'), { recursive: true })
  const legacy = JSON.stringify({ version: 1, sessionId: 'a', mark: { text: '旧状态', recordedAt: '2026-11-01T00:00:00.000Z' } })
  writeFileSync(path, legacy)
  const initial = f.owner.read(f.dir, 'a')
  assert.equal(initial.variables['soul.mark'], '旧状态')
  assert.equal(initial.revision, revisionOf(legacy))
  assert.equal(readFileSync(path, 'utf8'), legacy)
  const saved = await f.owner.edit(f.dir, 'a', { expectedRevision: initial.revision, changes: { blank: '', n: '2' } })
  assert.deepEqual(saved.variables, { 'soul.mark': '旧状态', blank: '', n: '2' })
  assert.equal(saved.updatedAt['soul.mark'], '2026-11-01T00:00:00.000Z')
  assert.equal(readFileSync(path, 'utf8'), legacy)
  assert.equal(f.owner.read(f.dir, 'b').revision, null)
  const other = join(moduleRoot, 'other-' + sequence)
  mkdirSync(other); writeFileSync(join(other, 'module.yml'), `id: other-${sequence}\nmodules: []\n`)
  assert.deepEqual(f.owner.read(other, 'a').variables, {})
  const reopened = await f.reopen()
  assert.deepEqual(reopened.read(f.dir, 'a').variables, saved.variables)
  writeFileSync(path, 'BROKEN')
  assert.deepEqual(reopened.read(f.dir, 'a').variables, saved.variables, '新存储存在后不读旧文件')
})
test('会话变量拒绝：旧版本、mark限长、授权撤销、取消及坏旧文件零提交', async t => {
  const f = await fixture(t)
  const first = await f.owner.edit(f.dir, 'a', { expectedRevision: null, changes: { n: '1' } })
  await assert.rejects(f.owner.edit(f.dir, 'a', { expectedRevision: null, changes: { n: '2' } }), /版本冲突/)
  await assert.rejects(f.owner.edit(f.dir, 'a', { expectedRevision: first.revision, changes: { 'soul.mark': 'x'.repeat(513) } }), /长度/)
  await assert.rejects(f.owner.edit(f.dir, 'a', { expectedRevision: first.revision, changes: { n: '2' } }, { assertAuthorized() { throw Error('撤权') } }), /撤权/)
  await assert.rejects(f.owner.edit(f.dir, 'a', { expectedRevision: first.revision, changes: { n: '2' } }, { signal: AbortSignal.abort() }), /abort/i)
  assert.deepEqual(f.owner.read(f.dir, 'a').variables, { n: '1' })
  const path = join(f.dir, 'data/.soul', `state-${revisionOf('b')}.json`)
  mkdirSync(join(f.dir, 'data/.soul'), { recursive: true }); writeFileSync(path, 'BROKEN')
  await assert.rejects(f.owner.edit(f.dir, 'b', { expectedRevision: null, changes: { n: '2' } }), /损坏/)
  assert.equal(readFileSync(path, 'utf8'), 'BROKEN')
})
test('会话变量边界：首次并发CAS、同值幂等、删除与ABA版本以及跨域依赖', async t => {
  const f = await fixture(t)
  const results = await Promise.allSettled([1, 2].map(n => f.owner.edit(f.dir, 'a', { expectedRevision: null, changes: { n: String(n) } })))
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1)
  const first = f.owner.read(f.dir, 'a')
  assert.deepEqual(await f.owner.edit(f.dir, 'a', { expectedRevision: first.revision, changes: first.variables }), { ...first, persisted: true })
  const removed = await f.owner.edit(f.dir, 'a', { expectedRevision: first.revision, changes: { n: null } })
  assert.deepEqual(removed.variables, {}); assert.deepEqual(removed.updatedAt, {})
  const restored = await f.owner.edit(f.dir, 'a', { expectedRevision: removed.revision, changes: first.variables })
  assert.notEqual(restored.revision, first.revision)
  const dep = readModuleVariables(f.dir)
  editModuleVariables(f.dir, { scope: 'module', changes: { count: '2' }, expectedRevisions: { module: dep.revisions.module } })
  await assert.rejects(f.owner.edit(f.dir, 'a', { expectedRevision: restored.revision, expectedDependencies: { module: dep.revisions.module }, changes: { n: '3' } }), /变化|冲突/)
  assert.deepEqual(f.owner.read(f.dir, 'a').variables, first.variables)
  assert.equal(existsSync(join(f.dir, 'data')), false, '新会话值只归官方Domain')
  const paused = f.pause(), current = readModuleVariables(f.dir)
  const writing = f.owner.edit(f.dir, 'a', { expectedRevision: restored.revision, expectedDependencies: { module: current.revisions.module }, changes: { n: 'held' } })
  await paused.entered
  assert.throws(() => editModuleVariables(f.dir, { scope: 'module', changes: { count: '3' }, expectedRevisions: { module: current.revisions.module } }), /进行|冲突/)
  const closing = f.owner.dispose()
  await assert.rejects(f.owner.edit(f.dir, 'a', { expectedRevision: restored.revision, changes: { n: 'late' } }), /释放/)
  paused.resume()
  assert.equal((await writing).persisted, true, '提交开始后的卸载不把已持久写冒充未写')
  await closing
  const reopened = await f.reopen()
  assert.equal(reopened.read(f.dir, 'a').variables.n, 'held')
  const after = readModuleVariables(f.dir)
  assert.throws(() => editModuleVariables(f.dir, { scope: 'module', changes: { count: '3' }, expectedRevisions: { module: after.revisions.module } }, { checkSession() { if (reopened.read(f.dir, 'a').revision !== restored.revision) throw Error('会话读取依赖冲突') } }), /会话读取依赖冲突/)
  assert.equal(readModuleVariables(f.dir).module.count, '2', '反向跨域提交不忽略已变化的会话读取依赖')
  assert.doesNotThrow(() => editModuleVariables(f.dir, { scope: 'module', changes: { count: '3' }, expectedRevisions: { module: after.revisions.module } }), '持久完成释放依赖锁')
})
