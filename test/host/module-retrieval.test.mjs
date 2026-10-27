import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedHome } from '../fixtures/host-harness.mjs'
import { createModuleRetrieval } from '../../src/host/module-retrieval.ts'
import { createModuleRetrievalProvider } from '../../src/runtime/module-retrieval-tools.ts'
import { makeSessionReference } from '../../engine/retrieval-reference.mjs'

const { moduleRoot } = isolatedHome('pt-retrieval-')

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
  const ctx = { inject: (_deps, cb) => ({ dispose: cb({ tools: { register: tool => {
    registrations++; tools.set(tool.name, tool)
    return () => tools.delete(tool.name)
  } } }) }) }
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
