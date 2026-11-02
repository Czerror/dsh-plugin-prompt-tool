import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedHome } from '../fixtures/host-harness.mjs'
import { registerSoulStateTools } from '../../src/runtime/soul-state-tools.ts'
import { readSoulState } from '../../src/host/soul-state.ts'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openSessionVariables } from '../../src/host/session-variables.ts'

const { moduleRoot } = isolatedHome('pt-soul-state-')
async function fixture(t, id) {
  const dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), `id: ${id}\nmodules: []\nrules: []\n`)
  const tools = new Map()
  const ctx = { inject: (_names, setup) => ({ dispose: setup({ tools: { register: tool => {
    tools.set(tool.name, tool); return () => tools.delete(tool.name)
  } } }) }) }
  const host = { target: (_exec, moduleId) => { if (moduleId !== id) throw new Error('模块未授权'); return { id, dir } } }
  const observe = { status: () => ({ state: 'observed' }), check: (_exec, _id, includeUpgrade) => ({ state: includeUpgrade ? 'upgrade-preview' : 'not-observed' }) }
  const root = new Context(), storage = new Storage(root), backend = new JsonStorageBackend(join(moduleRoot, id + '-storage'))
  const open = backend.kv.open
  let gate
  backend.kv.open = async descriptor => {
    const unit = await open(descriptor), put = unit.putRecord.bind(unit)
    unit.putRecord = async (...args) => { if (gate) { const waiting = gate; gate = undefined; waiting.started(); await waiting.wait } return put(...args) }
    return unit
  }
  storage.backend.register('json', backend)
  const facility = new DomainFacility(root, { backend: 'json' }), owner = await openSessionVariables(facility)
  let available = owner
  let off = registerSoulStateTools(ctx, host, observe, () => available)
  t.after(async () => { off(); await owner.dispose(); await facility.closeAll(); await backend.close(); await root.fiber.dispose() })
  const call = (args, sessionId = 'session-a', signal = new AbortController().signal) => tools.get('soul_state').execute({ moduleId: id, ...args }, { agent: { session: { id: sessionId } }, signal })
  return { dir, call, tools, owner, withdraw: () => { available = undefined }, pause: () => {
    let resume, started
    const wait = new Promise(resolve => { resume = resolve }), entered = new Promise(resolve => { started = resolve })
    gate = { wait, started }; return { resume, entered }
  }, remount: () => { off(); assert.equal(tools.size, 0); off = registerSoulStateTools(ctx, host, observe, () => available) } }
}

test('soul_state以真实会话隔离mark，状态只读且重挂后保留显式标记', async t => {
  const f = await fixture(t, 'state-flow')
  assert.deepEqual(await f.call({ action: 'status' }), { sessionId: 'session-a', mark: null, revision: null, observation: { state: 'observed' } })
  assert.equal(existsSync(join(f.dir, 'data')), false, '读取不能隐式初始化')
  const marked = await f.call({ action: 'mark', text: '正在核对账本', expectedRevision: null })
  assert.equal(marked.mark.text, '正在核对账本')
  assert.ok(Number.isFinite(Date.parse(marked.mark.recordedAt)))
  assert.equal(typeof marked.revision, 'string')
  assert.deepEqual((await f.call({ action: 'status' }, 'session-b')).mark, null)
  f.remount()
  assert.equal((await f.call({ action: 'status' })).mark.text, '正在核对账本')
  assert.deepEqual((await f.call({ action: 'check' })).observation, { state: 'not-observed' })
  assert.deepEqual((await f.call({ action: 'check', includeUpgrade: true })).observation, { state: 'upgrade-preview' })
  await assert.rejects(f.call({ action: 'status', includeUpgrade: true }), /只有check/)
  const pause = f.pause(), pending = f.call({ action: 'mark', text: '迟到正文', expectedRevision: marked.revision })
  await pause.entered
  f.withdraw(); pause.resume()
  const persisted = await pending
  assert.equal(persisted.persisted, true)
  assert.equal(persisted.publicationSuppressed, true)
  assert.equal(Object.hasOwn(persisted, 'mark'), false, '已持久但撤权只确认提交，不发布mark正文')
  assert.equal(f.owner.read(f.dir, 'session-a').variables['soul.mark'], '迟到正文')
})

test('soul_state拒绝伪造会话、旧版本和取消，重复同值不改版本或记录时间', async t => {
  const f = await fixture(t, 'state-cas')
  const first = await f.call({ action: 'mark', text: '处理中', expectedRevision: null })
  const second = await f.call({ action: 'mark', text: '处理中', expectedRevision: first.revision })
  assert.deepEqual(second, first)
  await assert.rejects(f.call({ action: 'mark', text: '完成', expectedRevision: null }), /版本冲突/)
  await assert.rejects(f.call({ action: 'mark', text: '伪造', expectedRevision: first.revision, sessionId: 'session-b' }), /未知字段/)
  await assert.rejects(f.call({ action: 'mark', text: 'X'.repeat(513), expectedRevision: first.revision }), /上限|长度/)
  await assert.rejects(f.call({ action: 'mark', text: '取消', expectedRevision: first.revision }, 'session-a', AbortSignal.abort()), /abort/i)
  assert.deepEqual((await f.call({ action: 'status' })).mark, first.mark)
  writeFileSync(join(f.dir, 'module.yml'), 'id: [broken YAML\n')
  assert.deepEqual(readSoulState(f.dir, 'session-a', f.owner).mark, first.mark, '只读状态允许已授权定义内容暂时损坏')
  await assert.rejects(f.call({ action: 'mark', text: '不能写', expectedRevision: first.revision }), /定义无效/)
})
