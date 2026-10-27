import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedHome } from '../fixtures/host-harness.mjs'
import { installSoulRuntime } from '../../src/runtime/soul-runtime.ts'
import { registerSoulLedgerTools } from '../../src/runtime/soul-ledger-tools.ts'
import { resolveModuleToolTarget } from '../../src/host/module-tool-target.ts'
import { SOUL_MAINTENANCE_SERVICE, SOUL_SELF_SERVICE, toolServiceName } from '../../engine/service-names.mjs'
import { createPromptConfigs } from '../../engine/schema.mjs'

const { moduleRoot } = isolatedHome('pt-soul-runtime-')

function fixture(t, id) {
  const dir = join(moduleRoot, id)
  mkdirSync(join(dir, 'data'), { recursive: true })
  writeFileSync(join(dir, 'module.yml'), `id: ${id}\nmodules: []\nrules: []\n`)
  writeFileSync(join(dir, 'data', 'SELF.src.md'), '# SHARED SELF\nKeep promises.')
  const tools = new Map(), services = new Map(), cleanups = [], calls = []
  let failRead = false
  const ctx = {
    provide: (name, value) => services.set(name, value),
    get: name => services.get(name),
    effect: setup => { const off = setup(); if (off) cleanups.push(off); return off },
    inject: (_deps, setup) => ({ dispose: setup(ctx) }),
    on: () => () => {},
    tools: { register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
  }
  services.set('tools', ctx.tools)
  const history = [{ seq: 0, type: 'user/message', data: { text: 'HISTORY KNOWN LITERAL' } }]
  services.set('sessionPersistence', { open: async (sessionId, access) => {
    calls.push(['open', sessionId, access])
    return { id: sessionId, read: async (offset, length) => {
      calls.push(['read', offset, length])
      if (failRead) throw new Error('SECRET RAW STORAGE CONTENT')
      return { events: history }
    }, close: async () => { calls.push(['close', sessionId]) } }
  } })
  const agent = { id: id + '-agent', ctx, session: { id: id + '-session', header: { delegationDepth: 0 }, snapshotEvents: () => [] },
    runMaintenance: async callback => callback(new AbortController().signal), followup: () => { throw new Error('DEFAULT MAINTENANCE MUST NOT WAKE') } }
  const host = { root: moduleRoot, target: (exec, moduleId) => resolveModuleToolTarget(exec, moduleRoot, () => [id], moduleId), rebuild: async () => {} }
  installSoulRuntime(ctx, host, agentId => agentId === agent.id ? [id] : [])
  const retrieval = services.get(toolServiceName('retrieval'))
  const offRetrieval = retrieval.mount(ctx, { paths: ['data/02-soul.jsonl', 'data/SELF.src.md'], sessions: ['authorized-history'] }, { agent, sourceModuleId: id, sourceModuleDir: dir })
  const offLedger = registerSoulLedgerTools(ctx, host)
  t.after(() => { offLedger(); offRetrieval(); for (const off of cleanups) off() })
  return { id, dir, tools, services, calls, agent, ctx, failRead: () => { failRead = true } }
}

test('Soul实际宿主接线贯通账本append→search/open，SELF和默认维护使用相同授权来源', async t => {
  const f = fixture(t, 'runtime-flow'), exec = { agent: f.agent, signal: new AbortController().signal }
  const written = await f.tools.get('soul_ledger').execute({ moduleId: f.id, action: 'append', type: 'fact', text: 'PUBLIC LITERAL FACT' }, exec)
  assert.equal(written.entry.by, f.agent.session.id)
  const found = await f.tools.get('module_search').execute({ moduleId: f.id, query: 'PUBLIC LITERAL FACT', limit: 1 }, exec)
  assert.equal(found.hits.length, 1)
  const opened = await f.tools.get('module_open').execute({ moduleId: f.id, reference: found.hits[0].reference }, exec)
  assert.equal(opened.content, readFileSync(join(f.dir, 'data', '02-soul.jsonl'), 'utf8').trim())
  assert.deepEqual(JSON.parse(opened.content), written.entry)
  assert.deepEqual(f.calls, [], '文件链路没有扫描历史会话')

  const maintenance = f.services.get(SOUL_MAINTENANCE_SERVICE)
  const off = maintenance.mount(f.ctx, { enabled: true, intervalMs: 60000, wake: false, audience: 'main', budgetBytes: 12288 },
    { agent: f.agent, sourceModuleId: f.id, sourceModuleDir: f.dir })
  t.after(off)
  await maintenance.tick(f.id)
  assert.deepEqual(maintenance.status(f.id), { state: 'ready' })
  const [self] = createPromptConfigs([{ id: 'self', strategy: 'placeholder', fill: 'soul-self', layer: 'runtime-context' }], { sourceModuleId: f.id })
  const rendered = (await self.resolve({ ctx: f.ctx, agent: f.agent, signal: exec.signal })).text
  assert.match(rendered, /SHARED SELF/)
  assert.match(rendered, /文件 2；会话 2；事件 1/)
  assert.match(rendered, new RegExp(f.agent.session.id))
  assert.throws(() => self.resolve({ ctx: f.ctx, agent: { ...f.agent, id: 'unrelated-agent' } }), /未参与/)
  assert.throws(() => self.resolve({ ctx: f.ctx, agent: f.agent, signal: AbortSignal.abort() }), /abort/i)
  f.services.delete(SOUL_SELF_SERVICE)
  assert.throws(() => self.resolve({ ctx: f.ctx, agent: f.agent }), /SELF dependency missing/)
  assert.equal(f.calls.filter(call => call[0] === 'open').length, 1, '维护确实刷新同一授权历史来源')
  assert.ok(f.calls.every(call => call[0] !== 'open' || call[2] === 'read'))
})

test('历史loader仅对授权sid打开只读句柄，成功和读取失败均close且拒绝不泄正文', async t => {
  const f = fixture(t, 'runtime-history'), exec = { agent: f.agent, signal: new AbortController().signal }
  const search = f.tools.get('module_search'), open = f.tools.get('module_open')
  const found = await search.execute({ moduleId: f.id, query: 'HISTORY KNOWN' }, exec)
  assert.equal(found.hits.length, 1)
  assert.equal(found.hits[0].reference.sessionId, 'authorized-history')
  assert.equal((await open.execute({ moduleId: f.id, reference: found.hits[0].reference }, exec)).content, found.hits[0].content)
  assert.equal(f.calls.filter(call => call[0] === 'close').length, 2)
  const before = f.calls.length
  await assert.rejects(open.execute({ moduleId: f.id, reference: { ...found.hits[0].reference, sessionId: 'not-authorized' } }, exec), /未授权/)
  assert.equal(f.calls.length, before, '伪造sid在持久读取前拒绝')
  f.failRead()
  await assert.rejects(search.execute({ moduleId: f.id, query: 'HISTORY KNOWN' }, exec), error => {
    assert.doesNotMatch(error.message, /SECRET RAW STORAGE CONTENT/)
    return /不可读取/.test(error.message)
  })
  assert.equal(f.calls.filter(call => call[0] === 'open').length, 3)
  assert.equal(f.calls.filter(call => call[0] === 'close').length, 3)
  assert.ok(f.calls.every(call => call[0] !== 'open' || call[2] === 'read'))
})
