import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { isolatedHome } from '../fixtures/host-harness.mjs'
import { createModuleRetrieval } from '../../src/host/module-retrieval.ts'
import { createModuleRetrievalProvider } from '../../src/runtime/module-retrieval-tools.ts'
import { makeSessionReference } from '../../engine/retrieval-reference.mjs'

const { moduleRoot } = isolatedHome('pt-retrieval-')

test('归一化命中保留原始文件和会话偏移，数字不吞边界', async () => {
  const dir = join(moduleRoot, 'normalized')
  mkdirSync(join(dir, 'data'), { recursive: true })
  writeFileSync(join(dir, 'data/notes.md'), ['ＡＢＣ 62,829 中文', '162829', '12,34'].join('\n'))
  const events = [{ seq: 0, type: 'user/message', data: { text: '前缀 ＡＢＣ 62,829 中文' } }]
  const retrieval = createModuleRetrieval(() => ({ moduleId: 'normalized', dir, paths: ['data/notes.md'], session: { id: 'current', snapshotEvents: () => events } }))
  const found = await retrieval.search({ query: 'abc 62829 中文' })
  assert.equal(found.hits.length, 2)
  assert.ok(found.hits.every(hit => hit.match === 'normalized'))
  for (const hit of found.hits) assert.equal((await retrieval.open(hit.reference)).content, hit.content)
  assert.equal((await retrieval.search({ query: '62829' })).hits.length, 2)
  assert.equal((await retrieval.search({ query: '1234' })).hits.length, 0)
})

test('声明近义表只扩展一次且精确优先，原文回取不变', async () => {
  const dir = join(moduleRoot, 'synonyms')
  mkdirSync(join(dir, 'data'), { recursive: true })
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets/terms.json'), JSON.stringify([['压缩', '整理'], ['整理', '归档']]))
  writeFileSync(join(dir, 'data/notes.md'), ['整理资料', '归档资料', '压缩资料', '再整理'].join('\n'))
  const base = { moduleId: 'synonyms', dir, paths: ['data/notes.md'] }
  const retrieval = createModuleRetrieval(() => ({ ...base, synonymsFile: 'assets/terms.json' }))
  const found = await retrieval.search({ query: '压缩' })
  assert.deepEqual(found.hits.map(hit => [hit.content, hit.match]), [['压缩资料', 'exact'], ['整理资料', 'synonym'], ['再整理', 'synonym']])
  for (const hit of found.hits) assert.equal((await retrieval.open(hit.reference)).content, hit.content)
  assert.equal((await retrieval.search({ query: '整理' })).hits.length, 4, '同一组双向，直接相邻组可用但不递归')
  assert.equal((await createModuleRetrieval(() => base).search({ query: '压缩' })).hits.length, 1)
  writeFileSync(join(dir, 'data/notes.md'), ['压缩一', '压缩二', '压缩三', '整理'].join('\n'))
  assert.equal((await retrieval.search({ query: '压缩' })).hits.length, 3, '三条精确命中不再扩展')
  writeFileSync(join(dir, 'assets/terms.json'), JSON.stringify([['压缩', '整理'], ['']]))
  await assert.rejects(retrieval.search({ query: '压缩' }), /近义表/)
  const { configContract } = await import('../../engine/retrieval.mjs')
  assert.equal(configContract.parse({ synonymsFile: 'assets/terms.json' }, 'retrieval').synonymsFile, 'assets/terms.json')
  assert.equal(configContract.parse({}, 'retrieval').synonymsFile, undefined)
})

test('时间线按可信时刻稳定合并，未知时间明确标记且版本变化拒绝旧游标', async () => {
  const dir = join(moduleRoot, 'timeline')
  mkdirSync(join(dir, 'data'), { recursive: true })
  const line = JSON.stringify({ t: '2026-10-31T08:00:00+08:00', type: 'fact', text: 'FIRST' })
  writeFileSync(join(dir, 'data/02-soul.jsonl'), line + '\n')
  const events = [{ seq: 0, type: 'user/message', time: Date.parse('2026-10-31T00:00:00Z') }, { seq: 1, type: 'user/message' }]
  const scope = { moduleId: 'timeline', dir, paths: ['data/02-soul.jsonl'], session: { id: 'current', snapshotEvents: () => events } }
  const retrieval = createModuleRetrieval(() => scope)
  const page = await retrieval.search({ mode: 'timeline', limit: 1 })
  assert.equal(page.hits[0].reference.kind, 'file')
  assert.equal(page.hits[0].time, '2026-10-31T00:00:00.000Z')
  assert.ok(page.nextCursor)
  const next = await retrieval.search({ mode: 'timeline', limit: 1, cursor: page.nextCursor })
  assert.equal(next.hits[0].reference.kind, 'session')
  const last = await retrieval.search({ mode: 'timeline', limit: 1, cursor: next.nextCursor })
  assert.equal(last.hits[0].time, null)
  assert.equal(last.hits[0].timeState, 'unknown')
  for (const hit of [...page.hits, ...next.hits, ...last.hits]) assert.equal((await retrieval.open(hit.reference)).content, hit.content)
  const filtered = await retrieval.search({ mode: 'timeline', since: '2026-10-31T08:00:00+08:00', until: '2026-10-31T00:00:00Z' })
  assert.equal(filtered.hits.length, 2, '时间过滤不把未知时间猜进窗口')
  events.push({ seq: 2, type: 'user/message', time: Date.parse('2026-10-31T01:00:00Z') })
  await assert.rejects(retrieval.search({ mode: 'timeline', limit: 1, cursor: page.nextCursor }), /游标.*失效/)
  await assert.rejects(retrieval.search({ mode: 'timeline', since: 'yesterday' }), /时间/)
  let finishLoad, authorized = ['history']
  const guarded = createModuleRetrieval(() => ({ ...scope, sessions: authorized }), async () => new Promise(resolve => { finishLoad = resolve }))
  const waiting = guarded.search({ mode: 'timeline' })
  while (!finishLoad) await Promise.resolve()
  authorized = []
  finishLoad({ id: 'history', snapshotEvents: () => [{ seq: 0, type: 'user/message', time: 1 }] })
  await assert.rejects(waiting, /未授权/)
})

test('索引状态只读且按Agent隔离，刷新、失效和失败保留最后成功观测', async t => {
  const tools = new Map(), dir = join(moduleRoot, 'observations')
  let loads = 0, fail = false
  const ctx = { get: () => ({ register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } }) }
  const agent = { ctx, session: { id: 'current', snapshotEvents: () => [] } }
  const provider = createModuleRetrievalProvider({ target: () => ({ id: 'observations', dir }) }, async id => {
    loads++
    if (fail) throw new Error('PRIVATE STORAGE FAILURE')
    return { id, snapshotEvents: () => [{ seq: 0, type: 'user/message' }] }
  })
  assert.deepEqual(provider.status(agent, 'observations'), { state: 'unauthorized' })
  const off = provider.mount(ctx, { paths: [], sessions: ['history'] }, { agent, sourceModuleId: 'observations', sourceModuleDir: dir })
  t.after(off)
  assert.deepEqual(provider.status(agent, 'observations'), { state: 'unbuilt' })
  assert.deepEqual(provider.status({ ...agent }, 'observations'), { state: 'unauthorized' })
  assert.equal(loads, 0, 'status不加载历史，也不要求目录存在')
  await provider.refresh(agent, 'observations')
  const ready = provider.status(agent, 'observations')
  assert.equal(ready.state, 'ready')
  assert.equal(ready.events, 1)
  assert.ok(Number.isFinite(Date.parse(ready.observedAt)))
  provider.invalidate(agent, 'observations')
  assert.deepEqual(provider.status(agent, 'observations'), { ...ready, state: 'stale' })
  fail = true
  await assert.rejects(provider.refresh(agent, 'observations'), /不可读取/)
  assert.deepEqual(provider.status(agent, 'observations'), { ...ready, state: 'failed' })
  assert.equal(loads, 2)
  off()
  assert.deepEqual(provider.status(agent, 'observations'), { state: 'unauthorized' })
})

test('同模块提交使所有Agent观测过期，卸载后不再持有状态且迟到刷新不能ready', async t => {
  const ctx = { get: () => ({ register: () => () => {} }) }
  const first = { ctx, session: { id: 'one', snapshotEvents: () => [] } }, second = { ctx, session: { id: 'two', snapshotEvents: () => [] } }
  const dir = join(moduleRoot, 'module-observations')
  let finishLoad
  const provider = createModuleRetrievalProvider({ target: () => ({ id: 'shared', dir }) }, id => new Promise(resolve => { finishLoad = () => resolve({ id, snapshotEvents: () => [] }) }))
  const config = { paths: [], sessions: [] }
  const off1 = provider.mount(ctx, config, { agent: first, sourceModuleId: 'shared', sourceModuleDir: dir })
  const off2 = provider.mount(ctx, config, { agent: second, sourceModuleId: 'shared', sourceModuleDir: dir })
  t.after(off1); t.after(off2)
  await provider.refresh(first, 'shared'); await provider.refresh(second, 'shared')
  const one = provider.status(first, 'shared'), two = provider.status(second, 'shared')
  provider.invalidateModule('shared')
  assert.deepEqual(provider.status(first, 'shared'), { ...one, state: 'stale' })
  assert.deepEqual(provider.status(second, 'shared'), { ...two, state: 'stale' })
  const off3 = provider.mount(ctx, { paths: [], sessions: ['history'] }, { agent: first, sourceModuleId: 'shared', sourceModuleDir: dir })
  t.after(off3)
  const pending = provider.refresh(first, 'shared')
  while (!finishLoad) await Promise.resolve()
  provider.invalidateModule('shared')
  finishLoad()
  await assert.rejects(pending, /状态已变化/)
  off1(); off3(); off2()
  provider.invalidateModule('shared')
  assert.deepEqual(provider.status(first, 'shared'), { state: 'unauthorized' })
  assert.deepEqual(provider.status(second, 'shared'), { state: 'unauthorized' })
})

test('刷新期间声明变更或显式失效拒绝迟到ready，释放旧挂载不扰动当前声明', async t => {
  const ctx = { get: () => ({ register: () => () => {} }) }
  const agent = { ctx, session: { id: 'current', snapshotEvents: () => [] } }
  const dir = join(moduleRoot, 'observation-race'), pending = []
  const provider = createModuleRetrievalProvider({ target: () => ({ id: 'race', dir }) }, id => new Promise(resolve => {
    pending.push(() => resolve({ id, snapshotEvents: () => [] }))
  }))
  const options = { agent, sourceModuleId: 'race', sourceModuleDir: dir }
  const off1 = provider.mount(ctx, { paths: [], sessions: ['history'] }, options)
  t.after(off1)
  const old = provider.refresh(agent, 'race')
  while (!pending.length) await Promise.resolve()
  assert.equal(provider.status(agent, 'race').state, 'refreshing')
  const off2 = provider.mount(ctx, { paths: [], sessions: ['history'] }, options)
  t.after(off2)
  assert.equal(provider.status(agent, 'race').state, 'stale')
  pending.shift()()
  await assert.rejects(old, /声明已变化/)
  assert.equal(provider.status(agent, 'race').state, 'stale')
  const fresh = provider.refresh(agent, 'race')
  while (!pending.length) await Promise.resolve()
  off1()
  pending.shift()()
  await fresh
  const ready = provider.status(agent, 'race')
  assert.equal(ready.state, 'ready')
  const invalidated = provider.refresh(agent, 'race')
  while (!pending.length) await Promise.resolve()
  provider.invalidate(agent, 'race')
  pending.shift()()
  await assert.rejects(invalidated, /状态已变化/)
  assert.deepEqual(provider.status(agent, 'race'), { ...ready, state: 'stale' })
  const removed = provider.refresh(agent, 'race')
  while (!pending.length) await Promise.resolve()
  off2()
  pending.shift()()
  await assert.rejects(removed, /未授权/)
  assert.deepEqual(provider.status(agent, 'race'), { state: 'unauthorized' })
})

test('检索工具初始化第二项失败同步上报，撤回第一项且重试没有遗留授权', async t => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  t.after(() => root.fiber.dispose())
  const agent = { id: 'retrieval-registration', session: { id: 'retrieval-registration', header: {}, snapshotEvents: () => [] } }
  await createScope(root, agent).ctx.plugin({ name: 'retrieval-test-agent', inject: ['tools'], apply(ctx) { agent.ctx = ctx } })
  const occupied = agent.ctx.tools.register(defineTool({ name: 'module_open', description: 'occupied', parameters: {}, output: { schema: { type: 'object', additionalProperties: true }, render: () => [] }, execute: async () => ({}) }))
  const dir = join(moduleRoot, 'registration')
  const provider = createModuleRetrievalProvider({ target: (_exec, id) => ({ id, dir }) })
  const options = { agent, sourceModuleId: 'registration', sourceModuleDir: dir }
  assert.throws(() => provider.mount(agent.ctx, { paths: [], sessions: [] }, options), /module_open/)
  assert.deepEqual(root.tools.schemas(agent).map(tool => tool.name), ['module_open'], '第一项检索工具已撤销，宿主原工具保留')
  await assert.rejects(provider.refresh(agent, 'registration'), /未授权/)
  occupied()
  const off = provider.mount(agent.ctx, { paths: [], sessions: [] }, options)
  assert.deepEqual(root.tools.schemas(agent).map(tool => tool.name).sort(), ['module_open', 'module_search'])
  off()
  assert.deepEqual(root.tools.schemas(agent), [])
  await assert.rejects(provider.refresh(agent, 'registration'), /未授权/)
})

test('检索已授权模块文件和账本的每种引用均可回取，查询不改原文件', async () => {
  const dir = join(moduleRoot, 'soul')
  mkdirSync(join(dir, 'data'), { recursive: true })
  writeFileSync(join(dir, 'data', 'notes.md'), '第一行\nKnown literal fact\n第三行')
  writeFileSync(join(dir, 'data', '02-soul.jsonl'), '{"text":"Known old fact"}\n{"summary":"Known new fact"}\n')
  const before = readFileSync(join(dir, 'data', '02-soul.jsonl'))
  const retrieval = createModuleRetrieval(() => ({ moduleId: 'soul', dir, paths: ['data/notes.md', 'data/02-soul.jsonl'] }))
  const found = await retrieval.search({ query: 'Known' })
  assert.deepEqual(found.hits.map(hit => hit.content), ['Known literal fact', '{"text":"Known old fact"}', '{"summary":"Known new fact"}'])
  for (const hit of found.hits) assert.equal((await retrieval.open(hit.reference)).content, hit.content)
  assert.deepEqual(await retrieval.search({ query: 'Known' }), found)
  assert.deepEqual(readFileSync(join(dir, 'data', '02-soul.jsonl')), before)
  const ctx = { get: () => ({ register: tool => { registered.set(tool.name, tool); return () => registered.delete(tool.name) } }) }
  const registered = new Map(), agent = { ctx, session: { id: 'current', snapshotEvents: () => [] } }
  const provider = createModuleRetrievalProvider({ target: () => ({ id: 'soul', dir }) })
  const off = provider.mount(ctx, { paths: ['data/02-soul.jsonl'], sessions: [] }, { agent, sourceModuleId: 'soul', sourceModuleDir: dir })
  try {
    const timeline = await registered.get('module_search').execute({ moduleId: 'soul', mode: 'timeline' }, { agent })
    assert.equal(timeline.hits.length, 2)
    assert.ok(timeline.hits.every(hit => hit.timeState === 'unknown'))
  } finally { off() }
})

test('文件引用重新校验授权与版本；目录白名单只检索其内部，链接与越界拒绝', async () => {
  const dir = join(moduleRoot, 'guard')
  mkdirSync(join(dir, 'data'), { recursive: true })
  writeFileSync(join(dir, 'data', 'known.md'), 'KNOWN')
  writeFileSync(join(dir, 'private.md'), 'PRIVATE KNOWN')
  let paths = ['data/']
  const retrieval = createModuleRetrieval(() => ({ moduleId: 'guard', dir, paths }))
  const found = await retrieval.search({ query: 'KNOWN' })
  assert.equal(found.hits.length, 1)
  const reference = found.hits[0].reference
  paths = []
  await assert.rejects(retrieval.open(reference), /未授权/)
  paths = ['data/']
  writeFileSync(join(dir, 'data', 'known.md'), 'CHANGED')
  await assert.rejects(retrieval.open(reference), /失效/)
  let finishLoad
  const awaitingHistory = createModuleRetrieval(() => ({ moduleId: 'guard', dir, paths, sessions: ['history'] }),
    async () => new Promise(resolve => { finishLoad = resolve }))
  const pending = awaitingHistory.search({ query: 'CHANGED' })
  while (!finishLoad) await Promise.resolve()
  paths = []
  finishLoad({ id: 'history', snapshotEvents: () => [] })
  await assert.rejects(pending, /未授权/, '等待历史期间撤销文件来源，已积累命中不能返回正文')
  paths = ['data/']
  finishLoad = undefined
  const stale = awaitingHistory.search({ query: 'CHANGED' })
  while (!finishLoad) await Promise.resolve()
  writeFileSync(join(dir, 'data', 'known.md'), 'NEW VERSION')
  finishLoad({ id: 'history', snapshotEvents: () => [] })
  await assert.rejects(stale, /失效/, '等待期间文件变化不能返回旧版本命中')
  paths = ['../private.md']
  await assert.rejects(retrieval.search({ query: 'PRIVATE' }), /非法资源路径/)
  paths = ['data/']
  symlinkSync(dir, join(dir, 'data', 'link'), 'junction')
  await assert.rejects(retrieval.search({ query: 'KNOWN' }), /链接/)
})

test('正式检索工具按Agent合并模块声明，重复挂载不重复注册，释放后引用失去授权', async () => {
  const tools = new Map(), dir = join(moduleRoot, 'tools')
  mkdirSync(join(dir, 'data'), { recursive: true })
  writeFileSync(join(dir, 'data', 'notes.md'), 'TOOL FACT')
  let registrations = 0
  const ctx = { get: () => ({ register: tool => {
    registrations++; tools.set(tool.name, tool)
    return () => tools.delete(tool.name)
  } }) }
  const agent = { ctx, session: { id: 'current', snapshotEvents: () => [] } }
  let finishLoad
  const provider = createModuleRetrievalProvider({ target: (_exec, moduleId) => {
    if (moduleId !== 'tools') throw new Error('模块未授权')
    return { id: moduleId, dir }
  } }, async () => new Promise(resolve => { finishLoad = resolve }))
  const options = { agent, sourceModuleId: 'tools', sourceModuleDir: dir }
  const off1 = provider.mount(ctx, { paths: ['data/'], sessions: [] }, options)
  const off2 = provider.mount(ctx, { paths: ['data/'], sessions: ['history'] }, options)
  assert.equal(registrations, 2)
  const search = tools.get('module_search'), open = tools.get('module_open'), exec = { agent }
  const hit = (await search.execute({ moduleId: 'tools', query: 'FACT', limit: 1 }, exec)).hits[0]
  assert.equal((await open.execute({ moduleId: 'tools', reference: hit.reference }, exec)).content, 'TOOL FACT')
  await assert.rejects(search.execute({ moduleId: 'tools', query: 'FACT' }, { agent: {} }), /Agent 未授权/)
  off1()
  assert.equal((await search.execute({ moduleId: 'tools', query: 'FACT', limit: 1 }, exec)).hits.length, 1)
  const pending = search.execute({ moduleId: 'tools', query: 'HISTORY' }, exec)
  while (!finishLoad) await Promise.resolve()
  off2()
  finishLoad({ id: 'history', snapshotEvents: () => [{ seq: 0, type: 'user/message', data: { text: 'SECRET HISTORY' } }] })
  await assert.rejects(pending, /模块未授权/, '卸载后迟到历史结果不能泄露正文')
  assert.equal(tools.size, 0)
  await assert.rejects(open.execute({ moduleId: 'tools', reference: hit.reference }, exec), /模块未授权/)
})

test('授权历史按session与真实事件seq定位，增量重试和重建不串同seq或重复正文', async () => {
  const sessions = new Map([
    ['one', { id: 'one', events: [{ seq: 0, type: 'user/message', data: { text: 'DUPLICATE literal' } }, { seq: 1, type: 'assistant/message', data: { text: 'first UNIQUE' } }] }],
    ['two', { id: 'two', events: [{ seq: 0, type: 'user/message', data: { text: 'DUPLICATE literal' } }] }],
  ])
  let authorized = ['one', 'two'], loads = []
  const load = async id => { loads.push(id); const session = sessions.get(id); return session && { id, snapshotEvents: () => session.events } }
  const scope = () => ({ moduleId: 'history', dir: moduleRoot, paths: [], sessions: authorized })
  const retrieval = createModuleRetrieval(scope, load)
  const found = await retrieval.search({ query: 'DUPLICATE' })
  assert.deepEqual(found.hits.map(hit => [hit.reference.sessionId, hit.reference.seqs]), [['one', [0]], ['two', [0]]])
  for (const hit of found.hits) assert.equal((await retrieval.open(hit.reference)).content, hit.content)
  sessions.get('one').events.push({ seq: 2, type: 'user/message', data: { text: 'DUPLICATE appended' } })
  assert.equal((await retrieval.search({ query: 'DUPLICATE' })).hits.length, 3)
  assert.equal((await retrieval.search({ query: 'DUPLICATE' })).hits.length, 3)
  const rebuilt = createModuleRetrieval(scope, load)
  assert.equal((await rebuilt.open(found.hits[0].reference)).content, found.hits[0].content)
  let authorizationChecks = 0, stillAuthorized = true
  const revoking = createModuleRetrieval(() => {
    if (++authorizationChecks === 2) queueMicrotask(() => { stillAuthorized = false })
    return { ...scope(), sessions: stillAuthorized ? ['one'] : [] }
  }, load)
  await assert.rejects(revoking.open(found.hits[0].reference), /未授权/, '异步读取间撤销sid不能靠旧scope返回正文')
  const seqs = [2, 0], selected = sessions.get('one').events
  const exact = makeSessionReference('history', 'one', selected, seqs)
  assert.equal((await rebuilt.open(exact)).content, JSON.stringify(selected[2]) + '\n' + JSON.stringify(selected[0]), '按实际seq列表，不把非单调来源猜成连续范围')
  assert.deepEqual(await rebuilt.refresh(), { state: 'ready', files: 0, sessions: 2, events: 4 })
  assert.equal((await rebuilt.open(exact)).content, JSON.stringify(selected[2]) + '\n' + JSON.stringify(selected[0]))
  let sourceIds = ['one', 'two'], finishLater
  const later = createModuleRetrieval(() => ({ ...scope(), sessions: sourceIds }), async id => {
    if (id === 'one') return load(id)
    return new Promise(resolve => { finishLater = resolve })
  })
  const pending = later.search({ query: 'DUPLICATE' })
  while (!finishLater) await Promise.resolve()
  sourceIds = ['two']
  finishLater(await load('two'))
  await assert.rejects(pending, /未授权/, '后续会话加载期间撤销先前会话，全部命中须统一复核')
  authorized = ['two']; loads = []
  await assert.rejects(retrieval.open(found.hits[0].reference), /未授权/)
  assert.deepEqual(loads, [], '拒绝发生在读取未授权会话之前')
  sessions.get('two').events[0] = { seq: 0, type: 'user/message', data: { text: 'CHANGED' } }
  await assert.rejects(retrieval.open(found.hits[1].reference), /失效/)
})
