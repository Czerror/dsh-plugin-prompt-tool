import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdirSync, readFileSync, rmdirSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { isolatedHome } from '../fixtures/host-harness.mjs'
import { installSoulRuntime } from '../../src/runtime/soul-runtime.ts'
import { registerSoulLedgerTools } from '../../src/runtime/soul-ledger-tools.ts'
import { resolveModuleToolTarget } from '../../src/host/module-tool-target.ts'
import { readModuleFacts } from '../../src/host/module-params.ts'
import { assertModuleDirectory } from '../../src/host/module-install.ts'
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

test('SELF注入预算与维护budgetBytes同源，调大后长快照不再被固定上限拒绝', async t => {
  const body = 'SHARED BUDGET BODY\n' + 'X'.repeat(13000)
  const defaults = fixture(t, 'runtime-budget-default')
  const defaultMaintenance = defaults.services.get(SOUL_MAINTENANCE_SERVICE)
  const defaultOff = defaultMaintenance.mount(defaults.ctx,
    { enabled: true, intervalMs: 60000, wake: false, audience: 'main', ...readModuleFacts(defaults.dir).effectiveConfigs['soul-maintenance'] },
    { agent: defaults.agent, sourceModuleId: defaults.id, sourceModuleDir: defaults.dir })
  t.after(defaultOff)
  await defaultMaintenance.tick(defaults.id)
  assert.equal(defaultMaintenance.status(defaults.id).state, 'ready')
  const snapshot = join(defaults.dir, 'data', '.soul', 'SELF.md')
  const previous = readFileSync(snapshot, 'utf8')
  writeFileSync(join(defaults.dir, 'data', 'SELF.src.md'), body)
  await defaultMaintenance.tick(defaults.id)
  assert.equal(defaultMaintenance.status(defaults.id).state, 'failed')
  assert.match(defaultMaintenance.status(defaults.id).error, /超预算/)
  assert.equal(readFileSync(snapshot, 'utf8'), previous, '默认预算维护失败保留旧快照')

  const raised = fixture(t, 'runtime-budget-raised')
  writeFileSync(join(raised.dir, 'module.yml'),
    readFileSync(join(raised.dir, 'module.yml'), 'utf8') + 'moduleConfigs:\n  soul-maintenance:\n    budgetBytes: 16384\n')
  writeFileSync(join(raised.dir, 'data', 'SELF.src.md'), body)
  const raisedMaintenance = raised.services.get(SOUL_MAINTENANCE_SERVICE)
  const raisedOff = raisedMaintenance.mount(raised.ctx,
    { enabled: true, intervalMs: 60000, wake: false, audience: 'main', ...readModuleFacts(raised.dir).effectiveConfigs['soul-maintenance'] },
    { agent: raised.agent, sourceModuleId: raised.id, sourceModuleDir: raised.dir })
  t.after(raisedOff)
  await raisedMaintenance.tick(raised.id)
  assert.equal(raisedMaintenance.status(raised.id).state, 'ready')
  assert.ok(Buffer.byteLength(readFileSync(join(raised.dir, 'data', '.soul', 'SELF.md'))) > 12288)
  const [shared] = createPromptConfigs([{ id: 'self', strategy: 'placeholder', fill: 'soul-self', layer: 'runtime-context' }], { sourceModuleId: raised.id })
  const rendered = (await shared.resolve({ ctx: raised.ctx, agent: raised.agent, signal: new AbortController().signal })).text
  assert.ok(Buffer.byteLength(rendered) > 12288, '超过旧固定上限仍可注入')
  assert.ok(rendered.includes(body), '注入真实维护生成的完整骨架')
  assert.match(rendered, new RegExp(raised.agent.session.id))
})

test('SELF完整求值在定义损坏后沿用最近有效预算并保留可用快照', async t => {
  const f = fixture(t, 'runtime-budget-last-good')
  const definition = join(f.dir, 'module.yml')
  const source = `id: ${f.id}\nmodules: []\nrules: []\nmoduleConfigs:\n  soul-maintenance:\n    budgetBytes: 16384\n`
  writeFileSync(definition, source)
  const body = 'LAST GOOD SELF\n' + 'X'.repeat(13000)
  mkdirSync(join(f.dir, 'data', '.soul'), { recursive: true })
  writeFileSync(join(f.dir, 'data', '.soul', 'SELF.md'), body)
  const [self] = createPromptConfigs([{ id: 'self', strategy: 'placeholder', fill: 'soul-self', layer: 'runtime-context' }], { sourceModuleId: f.id })
  const resolve = () => self.resolve({ ctx: f.ctx, agent: f.agent, signal: new AbortController().signal })
  const rendered = (await resolve()).text
  assert.ok(Buffer.byteLength(rendered) > 12288)
  assert.ok(rendered.includes(body))

  writeFileSync(definition, source.replace('modules: []', 'modules: [missing-composition-row]'))
  assert.doesNotThrow(() => assertModuleDirectory(moduleRoot, f.id), '定义与身份仍然有效，失败来自缺失组合')
  assert.equal((await resolve()).text, rendered, '组合事实读取失败不能被当成有效默认预算覆盖最近有效值')

  writeFileSync(definition, 'id: [broken YAML\n')
  assert.equal((await resolve()).text, rendered, '坏定义不能阻断最近有效预算下的SELF注入')
  assert.throws(() => assertModuleDirectory(moduleRoot, f.id), /定义无效/, '既有目录入口继续严格拒绝坏定义')
  unlinkSync(definition)
  assert.equal((await resolve()).text, rendered, '缺定义也保留最近有效预算')

  writeFileSync(definition, source + '# restored\n')
  const read = fs.readFileSync
  const readFailure = t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (String(path) === definition) throw Object.assign(new Error('DEFINITION READ DENIED'), { code: 'EACCES' })
    return read(path, ...args)
  })
  syncBuiltinESMExports()
  try { assert.equal((await resolve()).text, rendered, '普通定义内容读取失败可以回退') }
  finally { readFailure.mock.restore(); syncBuiltinESMExports() }
  const lstat = fs.lstatSync
  const metadataFailure = t.mock.method(fs, 'lstatSync', (path, ...args) => {
    if (String(path) === definition) throw Object.assign(new Error('DEFINITION METADATA DENIED'), { code: 'EACCES' })
    return lstat(path, ...args)
  })
  syncBuiltinESMExports()
  try { assert.throws(resolve, /DEFINITION METADATA DENIED/, '定义元数据权限失败不能软化') }
  finally { metadataFailure.mock.restore(); syncBuiltinESMExports() }

  writeFileSync(definition, `id: ${f.id}\nmodules: []\nrules: []\n`)
  assert.throws(resolve, /超预算/, '恢复的有效定义省略预算时默认12288覆盖旧值')
  writeFileSync(definition, source)
  assert.equal((await resolve()).text, rendered, '定义恢复后重新读取显式预算')
  writeFileSync(definition, source.replace(f.id, 'x'.repeat(f.id.length)))
  assert.throws(resolve, /定义身份不匹配/, '可读声明身份不匹配不能复用缓存')
  unlinkSync(definition)
  mkdirSync(definition)
  assert.throws(resolve, /定义不是普通文件/)
  rmdirSync(definition)
  symlinkSync(f.dir, definition, 'junction')
  assert.throws(resolve, /定义不是普通文件/, '定义链接不能软化为读取失败')

  const fresh = fixture(t, 'runtime-budget-first-bad')
  writeFileSync(join(fresh.dir, 'module.yml'), 'id: [broken YAML\n')
  mkdirSync(join(fresh.dir, 'data', '.soul'), { recursive: true })
  const freshSnapshot = join(fresh.dir, 'data', '.soul', 'SELF.md')
  writeFileSync(freshSnapshot, body)
  const [first] = createPromptConfigs([{ id: 'self', strategy: 'placeholder', fill: 'soul-self', layer: 'runtime-context' }], { sourceModuleId: fresh.id })
  assert.throws(() => first.resolve({ ctx: fresh.ctx, agent: fresh.agent }), /超预算/, '首次坏定义使用12288默认预算')
  writeFileSync(freshSnapshot, 'X'.repeat(12000))
  assert.ok((await first.resolve({ ctx: fresh.ctx, agent: fresh.agent })).text.includes('X'.repeat(12000)))
})

test('SELF预算以mtime和size提前刷新，同戳等长修改与失败尝试在1000ms到期且命中不续期', async t => {
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const f = fixture(t, 'runtime-budget-expiry')
  const definition = join(f.dir, 'module.yml'), fixedTime = new Date('2026-01-01T00:00:00Z')
  const source = `id: ${f.id}\nmodules: []\nrules: []\nmoduleConfigs:\n  soul-maintenance:\n    budgetBytes: 16384\n`
  const replaceBudget = (budget, suffix = '') => {
    writeFileSync(definition, source.replace('16384', budget) + suffix)
    utimesSync(definition, fixedTime, fixedTime)
  }
  replaceBudget('16384')
  const { mtimeMs, size } = statSync(definition)
  const body = 'TTL BUDGET BODY\n' + 'X'.repeat(20000)
  mkdirSync(join(f.dir, 'data', '.soul'), { recursive: true })
  writeFileSync(join(f.dir, 'data', '.soul', 'SELF.md'), body)
  const [self] = createPromptConfigs([{ id: 'self', strategy: 'placeholder', fill: 'soul-self', layer: 'runtime-context' }], { sourceModuleId: f.id })
  const resolve = () => self.resolve({ ctx: f.ctx, agent: f.agent })
  assert.throws(resolve, /超预算/)
  now = 100
  replaceBudget('24576')
  assert.equal(statSync(definition).mtimeMs, mtimeMs)
  assert.equal(statSync(definition).size, size, '预算改写确实同戳等长')
  assert.throws(resolve, /超预算/)
  now = 999
  assert.throws(resolve, /超预算/)
  now = 1000
  assert.ok((await resolve()).text.includes(body), '期限从上次读取算起，中途命中不续期')

  replaceBudget('00000')
  now = 2000
  assert.ok((await resolve()).text.includes(body), '非法预算读取失败，沿用24576')
  replaceBudget('16384')
  now = 2001
  assert.ok((await resolve()).text.includes(body), '失败尝试也缓存，不重复重读')
  now = 2999
  assert.ok((await resolve()).text.includes(body))
  now = 3000
  assert.throws(resolve, /超预算/, '失败期限届满后重读恢复的16384')
  now = 3001
  replaceBudget('24576', '# size changed\n')
  assert.equal(statSync(definition).mtimeMs, mtimeMs)
  assert.notEqual(statSync(definition).size, size)
  assert.ok((await resolve()).text.includes(body), '同戳不同size立即刷新')
})
