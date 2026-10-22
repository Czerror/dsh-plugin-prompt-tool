import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { parse } from 'yaml'
import { isolatedHome, fixtureRule } from '../fixtures/host-harness.mjs'
import { moduleOrderConfigs, reorderToView, sameConfigPosition } from '../../src/client/data/prompt-config-order.ts'
import { configIdentityKey } from '../../src/shared/module-config-order.ts'

const { moduleRoot } = isolatedHome('pt-config-order-')
const { appendModuleConfigOrder, readModuleConfigOrder, saveModuleConfigOrder } = await import('../../src/host/module-config-order.ts')
const { setModuleEnabled } = await import('../../src/host/config-store.ts')
const { ensureModuleReady } = await import('../../src/host/write-module.ts')

function fixture(name, cards) {
  const root = join(moduleRoot, name, 'modules')
  for (const [moduleId, configs] of Object.entries(cards)) {
    const dir = join(root, moduleId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'module.yml'), '# keep comment\n' + JSON.stringify({ id: moduleId, modules: ['rule-engine'], custom: 'keep', rules: configs.map(fixtureRule) }))
  }
  return root
}
const identities = snapshot => snapshot.entries.map(({ moduleId, configId }) => ({ moduleId, configId }))

test('配置排序：跨模块同名卡保留受众与策略，身份排序写回各自定义且正文不变', () => {
  const root = fixture('append', {
    a: [{ id: 'same', text: 'A1', audience: 'main' }, { id: 'last', text: 'A2', audience: 'subagent', strategy: 'context-activation', params: { activation: { scan: 'batch' }, constant: true } }],
    b: [{ id: 'same', text: 'B1' }, { id: 'shared', text: 'B2', audience: null }],
  })
  assert.deepEqual(appendModuleConfigOrder(root, 'a'), ['a'])
  setModuleEnabled(root, 'a', true)
  appendModuleConfigOrder(root, 'b')
  setModuleEnabled(root, 'b', true)
  const initial = readModuleConfigOrder(root)
  assert.deepEqual(initial.entries.map(x => [x.moduleId, x.configId, x.sequence, x.audience, x.strategy]), [
    ['a', 'same', 0, 'main', 'static'], ['a', 'last', 10, 'subagent', 'context-activation'],
    ['b', 'same', 20, undefined, 'static'], ['b', 'shared', 30, undefined, 'static'],
  ])
  assert.ok(initial.entries.every(entry => !('text' in entry) && !('templateFile' in entry)))
  const drafts = moduleOrderConfigs(initial.entries)
  const mainIds = drafts.filter(card => card.audience !== 'subagent').map(card => card.id)
  const entryByKey = new Map(initial.entries.map(entry => [configIdentityKey(entry), entry]))
  const movedMain = reorderToView(drafts, '["b","same"]', '["a","same"]', true, mainIds)
  const mainOrder = movedMain.map(card => entryByKey.get(card.id))
  saveModuleConfigOrder(root, initial.revision, identities({ entries: mainOrder }))
  const afterMain = readModuleConfigOrder(root)
  assert.deepEqual(afterMain.entries.map(entry => [entry.moduleId, entry.configId]), [['b', 'same'], ['a', 'same'], ['a', 'last'], ['b', 'shared']], '移到目标前：源卡落在目标卡紧前，其余卡保持相对顺序')
  const subDrafts = moduleOrderConfigs(afterMain.entries)
  const subIds = subDrafts.filter(card => card.audience !== 'main').map(card => card.id)
  const activationIds = subDrafts.filter(card => card.audience !== 'main' && card.strategy === 'context-activation').map(card => card.id)
  assert.equal(reorderToView(subDrafts, '["a","last"]', '["b","shared"]', false, activationIds), subDrafts)
  assert.equal(sameConfigPosition(subDrafts[0], { ...subDrafts[1], position: 'before-user' }), false)
  const movedSub = reorderToView(subDrafts, '["a","last"]', '["b","shared"]', false, subIds)
  const reordered = movedSub.map(card => entryByKey.get(card.id))
  saveModuleConfigOrder(root, afterMain.revision, identities({ entries: reordered }))
  assert.deepEqual(readModuleConfigOrder(root).entries.map(entry => [entry.moduleId, entry.configId]), [['b', 'same'], ['a', 'same'], ['b', 'shared'], ['a', 'last']], '移到目标后：目标卡之后即源卡')
  for (const id of ['a', 'b']) ensureModuleReady(id, { modulesRoot: root })
  for (const id of ['b', 'a']) ensureModuleReady(id, { modulesRoot: root })
  assert.deepEqual(identities(readModuleConfigOrder(root)), identities({ entries: reordered }), '重建不会按模块数组重新编号')
  for (const [id, texts] of [['a', ['A1', 'A2']], ['b', ['B1', 'B2']]]) {
    const raw = readFileSync(join(root, id, 'module.yml'), 'utf8')
    assert.match(raw, /# keep comment/)
    const spec = parse(raw)
    assert.equal(spec.custom, 'keep')
    assert.deepEqual(spec.rules.map(card => card.then[0].config.text), texts)
  }
})

test('配置排序：过期版本、未知卡、重复卡拒绝且所有模块字节不变', () => {
  const root = fixture('reject', { a: [{ id: 'a', text: 'A' }], b: [{ id: 'b', text: 'B' }] })
  for (const id of ['a', 'b']) { appendModuleConfigOrder(root, id); setModuleEnabled(root, id, true) }
  const snapshot = readModuleConfigOrder(root)
  const before = ['a', 'b'].map(id => readFileSync(join(root, id, 'module.yml'), 'utf8'))
  assert.throws(() => saveModuleConfigOrder(root, 'stale', identities(snapshot)), /版本|变化/)
  assert.throws(() => saveModuleConfigOrder(root, snapshot.revision, [{ moduleId: 'a', configId: 'missing' }, identities(snapshot)[1]]), /配置卡|集合/)
  assert.throws(() => saveModuleConfigOrder(root, snapshot.revision, [identities(snapshot)[0], identities(snapshot)[0]]), /重复|集合/)
  assert.deepEqual(['a', 'b'].map(id => readFileSync(join(root, id, 'module.yml'), 'utf8')), before)
  const rename = fs.renameSync
  for (const external of [false, true]) {
    let failures = 0
    mock.method(fs, 'renameSync', (from, to) => {
      if (basename(to) === '_settings.yml' && basename(dirname(dirname(to))) === 'b' && failures < 2) {
        failures++
        if (external && failures === 2) {
          const file = join(root, 'a', 'module.yml')
          const source = parse(readFileSync(file, 'utf8'))
          source.custom = 'EXTERNAL DURING FAILURE'
          writeFileSync(file, JSON.stringify(source))
        }
        throw new Error('publication failure after module b commit')
      }
      return rename(from, to)
    })
    syncBuiltinESMExports()
    try { assert.throws(() => saveModuleConfigOrder(root, snapshot.revision, identities(snapshot).reverse())) }
    finally { mock.restoreAll(); syncBuiltinESMExports() }
    assert.equal(readFileSync(join(root, 'b', 'module.yml'), 'utf8'), before[1], 'persisted失败模块也回滚')
    if (external) assert.equal(parse(readFileSync(join(root, 'a', 'module.yml'), 'utf8')).custom, 'EXTERNAL DURING FAILURE', '外部新改动不被盲回滚覆盖')
    else {
      assert.equal(readFileSync(join(root, 'a', 'module.yml'), 'utf8'), before[0], '先成功模块恢复原定义')
    }
  }
})

test('配置排序：重复启用幂等；新增卡追加，停用模块重排后重建与再次启用保序', () => {
  const root = fixture('idempotent', { a: [{ id: 'a', text: 'A' }], b: [{ id: 'b', text: 'B' }] })
  for (const id of ['a', 'b']) { appendModuleConfigOrder(root, id); setModuleEnabled(root, id, true) }
  const before = readFileSync(join(root, 'a', 'module.yml'), 'utf8')
  assert.deepEqual(appendModuleConfigOrder(root, 'a'), [])
  assert.equal(readFileSync(join(root, 'a', 'module.yml'), 'utf8'), before)
  const spec = parse(before)
  spec.rules.push(fixtureRule({ id: 'new', text: 'NEW' }))
  writeFileSync(join(root, 'a', 'module.yml'), JSON.stringify(spec))
  appendModuleConfigOrder(root, 'a')
  const ordered = readModuleConfigOrder(root)
  assert.deepEqual(ordered.entries.map(x => [x.configId, x.sequence]), [['a', 0], ['b', 10], ['new', 20]])
  setModuleEnabled(root, 'a', false)
  const other = readFileSync(join(root, 'b', 'module.yml'), 'utf8')
  const disabled = readModuleConfigOrder(root, 'a')
  assert.deepEqual(disabled.entries.map(x => [x.moduleId, x.configId, x.sequence]), [['a', 'a', 0], ['a', 'new', 20]])
  saveModuleConfigOrder(root, disabled.revision, identities(disabled).reverse(), 'a')
  ensureModuleReady('a', { modulesRoot: root })
  assert.deepEqual(readModuleConfigOrder(root, 'a').entries.map(x => [x.configId, x.sequence]), [['new', 0], ['a', 20]])
  assert.equal(readFileSync(join(root, 'b', 'module.yml'), 'utf8'), other, '单模块重排不改其他模块槽位')
  appendModuleConfigOrder(root, 'a')
  setModuleEnabled(root, 'a', true)
  assert.deepEqual(readModuleConfigOrder(root).entries.map(x => [x.configId, x.sequence]), [['new', 0], ['b', 10], ['a', 20]])
  setModuleEnabled(root, 'a', false)
  const activeOnly = readModuleConfigOrder(root)
  saveModuleConfigOrder(root, activeOnly.revision, identities(activeOnly))
  appendModuleConfigOrder(root, 'a')
  setModuleEnabled(root, 'a', true)
  assert.deepEqual(readModuleConfigOrder(root).entries.map(x => [x.configId, x.sequence]), [['b', 0], ['new', 30], ['a', 40]], '部分槽位被占后整体追加仍保留用户排好的相对次序')
  const freshRoot = fixture('disabled-unassigned', { fresh: [{ id: 'x', text: 'X' }, { id: 'y', text: 'Y' }] })
  const fresh = readModuleConfigOrder(freshRoot, 'fresh')
  saveModuleConfigOrder(freshRoot, fresh.revision, identities(fresh).reverse(), 'fresh')
  ensureModuleReady('fresh', { modulesRoot: freshRoot })
  assert.deepEqual(readModuleConfigOrder(freshRoot, 'fresh').entries.map(x => [x.configId, x.sequence]), [['y', 0], ['x', 10]], '未启用且未分配序号的模块同样可排序')
})

// ── 排序请求生命周期（T9）：hook 与页面影子实现合并后的唯一接缝 ──────────────────────
// 断言落在三处真实接缝：发出的载荷、调用序列、会话状态对象；不渲染 React，也不 mock 被测逻辑。

const sessionFactory = async () => (await import('../../src/client/data/use-module-config-order.ts')).createModuleConfigOrderSession
const { PROMPT_TOOL_DICTS } = await import('../../src/client/locales.ts')

/** 真实 zh 文案（键或插值缺失即抛错）：合并后的错误必须仍是用户看得懂的那几条。 */
const t = (key, params) => {
  const template = PROMPT_TOOL_DICTS.zh[key]
  assert.ok(template !== undefined, `缺少文案键：${key}`)
  return template.replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''))
}

const orderEntry = (moduleId, configId, sequence, extra = {}) =>
  ({ moduleId, configId, sequence, name: configId, layer: 'pre-step', position: 'after-user', enabled: true, ...extra })
const orderSnapshot = (revision, ...entries) => ({ revision, entries })
const swappedCards = cards => [cards[1], cards[0]]
const firstSnapshot = orderSnapshot('rev-1', orderEntry('a', 'x', 0), orderEntry('b', 'y', 10))
const swappedSnapshot = orderSnapshot('rev-2', orderEntry('b', 'y', 0), orderEntry('a', 'x', 10))

/** 建会话：`respond(body, nth)` 决定每个请求的结果（读取时 body 为 undefined），`calls` 记录载荷。 */
async function makeOrderSession(respond, reloadConfigs) {
  const createModuleConfigOrderSession = await sessionFactory()
  const calls = []
  const session = createModuleConfigOrderSession({
    t,
    request: async (body, nth) => { calls.push(body); return respond(body, nth) },
    reloadConfigs,
  })
  return { session, calls }
}

test('排序请求：读取期间的 reset 让迟到响应不写入状态', async () => {
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const { session, calls } = await makeOrderSession(() => pending)
  const loading = session.load()
  session.reset()
  release({ ok: true, value: firstSnapshot })
  assert.equal(await loading, false, '已失效的读取不算成功')
  assert.equal(session.state.snapshot, undefined)
  assert.deepEqual(session.state.configs, [])
  assert.equal(session.state.error, '')
  assert.equal(session.state.busy, false)
  assert.equal(calls.length, 1, 'reset 不补发请求')
})

test('排序请求：dispose（卸载）后迟到响应不写入状态', async () => {
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const { session, calls } = await makeOrderSession(() => pending)
  const loading = session.load()
  session.dispose()
  release({ ok: true, value: firstSnapshot })
  assert.equal(await loading, false)
  assert.equal(session.state.snapshot, undefined)
  assert.deepEqual(session.state.configs, [])
  assert.equal(calls.length, 1)
})

test('排序请求：保存携带完整身份列表与读取时的 revision', async () => {
  const { session, calls } = await makeOrderSession((body) => body === undefined ? { ok: true, value: firstSnapshot } : { ok: true, value: swappedSnapshot })
  assert.equal(await session.load(), true)
  await session.save(swappedCards(session.state.configs))
  assert.deepEqual(calls, [
    undefined,
    { expectedRevision: 'rev-1', entries: [{ moduleId: 'b', configId: 'y' }, { moduleId: 'a', configId: 'x' }] },
  ])
  assert.deepEqual(session.state.snapshot, swappedSnapshot, '成功后采纳服务端回执')
  assert.equal(session.state.busy, false)
})

test('排序请求：保存失败显示错误并重读一次，重读成功也不静默清错误', async () => {
  let reads = 0
  const { session, calls } = await makeOrderSession((body) => {
    if (body !== undefined) return { ok: false, code: 'rules-conflict', message: '版本已变化' }
    reads += 1
    return { ok: true, value: reads === 1 ? firstSnapshot : swappedSnapshot }
  })
  await session.load()
  await session.save(swappedCards(session.state.configs))
  assert.equal(calls.length, 3, '失败后恰好重读一次')
  assert.equal(calls[2], undefined, '重读不带载荷')
  assert.deepEqual(session.state.snapshot, swappedSnapshot, '重读结果被采纳')
  assert.match(session.state.error, /排序保存失败，调整已保留：版本已变化/)
  assert.equal(session.state.busy, false)
})

test('排序请求：重读也失败时错误以重读结果为准', async () => {
  let reads = 0
  const { session } = await makeOrderSession((body) => {
    if (body !== undefined) return { ok: false, code: 'rules-conflict', message: '版本已变化' }
    reads += 1
    return reads === 1 ? { ok: true, value: firstSnapshot } : { ok: false, message: '读取超时' }
  })
  await session.load()
  await session.save(swappedCards(session.state.configs))
  assert.match(session.state.error, /读取排序失败：读取超时/)
})

test('排序请求：保存成功后刷新各模块规则版本，刷新失败如实显示', async () => {
  let refreshes = 0
  const ok = await makeOrderSession(
    (body) => body === undefined ? { ok: true, value: firstSnapshot } : { ok: true, value: swappedSnapshot },
    async () => { refreshes += 1; return true },
  )
  await ok.session.load()
  await ok.session.save(swappedCards(ok.session.state.configs))
  assert.equal(refreshes, 1, '保存成功必须刷新一次各模块规则版本')
  assert.deepEqual(ok.session.state.snapshot, swappedSnapshot)
  assert.equal(ok.session.state.error, '')

  const failed = await makeOrderSession(
    (body) => body === undefined ? { ok: true, value: firstSnapshot } : { ok: true, value: swappedSnapshot },
    async () => false,
  )
  await failed.session.load()
  await failed.session.save(swappedCards(failed.session.state.configs))
  assert.match(failed.session.state.error, /排序已保存，但配置刷新失败/)
})

test('排序请求：并发保存第二次被拒，只发一次保存请求', async () => {
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const { session, calls } = await makeOrderSession((body) => body === undefined ? { ok: true, value: firstSnapshot } : pending)
  await session.load()
  const cards = session.state.configs
  const saving = session.save([cards[1], cards[0]])
  await session.save([cards[0], cards[1]])
  assert.equal(calls.length, 2, '第二次保存被 busy 拒绝')
  release({ ok: true, value: swappedSnapshot })
  await saving
})

test('排序请求：未变化的排序不发保存请求', async () => {
  const { session, calls } = await makeOrderSession((body) => body === undefined ? { ok: true, value: firstSnapshot } : { ok: true, value: swappedSnapshot })
  await session.load()
  await session.save(session.state.configs)
  assert.equal(calls.length, 1, '同一个数组引用 = 未变化')
})

test('排序请求：订阅者在状态变化时收到通知，退订后不再收到', async () => {
  const { session } = await makeOrderSession((body) => body === undefined ? { ok: true, value: firstSnapshot } : { ok: true, value: swappedSnapshot })
  let notified = 0
  const unsubscribe = session.subscribe(() => { notified += 1 })
  assert.equal(await session.load(), true)
  assert.ok(notified > 0, '读取完成必须通知订阅者')
  const settled = notified
  unsubscribe()
  await session.save(swappedCards(session.state.configs))
  assert.equal(notified, settled, '退订后不得再收到通知')
})

test('排序请求：update 换掉依赖后，后续调用用新依赖', async () => {
  let refreshes = 0
  const { session } = await makeOrderSession(
    (body) => body === undefined ? { ok: true, value: firstSnapshot } : { ok: true, value: swappedSnapshot },
    async () => { refreshes += 1; return true },
  )
  await session.load()
  await session.save(swappedCards(session.state.configs))
  assert.equal(refreshes, 1)
  // hook 每次提交后都会刷新依赖：换掉之后旧回调不得再被调用。
  session.update({ t, reloadConfigs: async () => false })
  await session.save(swappedCards(session.state.configs))
  assert.equal(refreshes, 1, '旧回调不再被调用')
  assert.match(session.state.error, /排序已保存，但配置刷新失败/)
})

// ── 一步重排：判据与移动的唯一实现（拖拽/按钮/键盘共用） ──────────────────────

/** 视图草稿的身份键 → 排序身份：写盘只提交身份，序号由服务端按索引分配。 */
const reorderIdentities = (cards, entryByKey) => cards.map(card => {
  const entry = entryByKey.get(card.id)
  return { moduleId: entry.moduleId, configId: entry.configId }
})

test('一步重排：移到目标前/后按身份顺序写回 configOrder，卡定义一个字不动', () => {
  const root = fixture('reorder', { a: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }, { id: 'C', text: 'c' }, { id: 'D', text: 'd' }] })
  setModuleEnabled(root, 'a', true)
  const initial = readModuleConfigOrder(root)
  const cards = moduleOrderConfigs(initial.entries)
  const entryByKey = new Map(initial.entries.map(entry => [configIdentityKey(entry), entry]))
  const [A, B, C, D] = cards.map(card => card.id)
  assert.deepEqual(cards.map(card => card.id), ['["a","A"]', '["a","B"]', '["a","C"]', '["a","D"]'])

  // 拖 D 到 B 前：一步重排（不是与 B 互换，也不逐个对调中间卡）
  const dropped = reorderToView(cards, D, B, true, cards.map(card => card.id))
  assert.deepEqual(dropped.map(card => card.id), [A, D, B, C])
  saveModuleConfigOrder(root, initial.revision, reorderIdentities(dropped, entryByKey))
  const afterDrop = readModuleConfigOrder(root)
  assert.deepEqual(afterDrop.entries.map(entry => entry.configId), ['A', 'D', 'B', 'C'])
  assert.deepEqual(afterDrop.entries.map(entry => entry.sequence), [0, 10, 20, 30], '写回的是身份顺序，序号由服务端按索引分配')

  // 按钮与键盘的相邻移动落到同一实现：D 下移一格 = 移到 C 之后
  const cards2 = moduleOrderConfigs(afterDrop.entries)
  const entryByKey2 = new Map(afterDrop.entries.map(entry => [configIdentityKey(entry), entry]))
  const movedNext = reorderToView(cards2, D, C, false, cards2.map(card => card.id))
  assert.deepEqual(movedNext.map(card => card.id), [A, B, C, D])
  saveModuleConfigOrder(root, afterDrop.revision, reorderIdentities(movedNext, entryByKey2))
  assert.deepEqual(readModuleConfigOrder(root).entries.map(entry => entry.configId), ['A', 'B', 'C', 'D'])

  // 排序只改顺序：正文与卡内字段都不动
  const spec = parse(readFileSync(join(root, 'a', 'module.yml'), 'utf8'))
  assert.deepEqual(spec.rules.map(rule => rule.then[0].config.text), ['a', 'b', 'c', 'd'])
})

test('一步重排：跨插入点的目标原样返回；跨官方档位由 configOrder 覆盖', () => {
  const root = fixture('reorder-guards', { a: [
    { id: 'P1', text: 'p1' }, { id: 'P2', text: 'p2' },
    { id: 'S1', text: 's1', layer: 'system-section', order: 100 },
    { id: 'S2', text: 's2', layer: 'system-section', order: 500 },
  ] })
  setModuleEnabled(root, 'a', true)
  const cards = moduleOrderConfigs(readModuleConfigOrder(root).entries)
  const key = id => `["a","${id}"]`
  const movableView = sourceId => cards
    .filter(card => sameConfigPosition(card, cards.find(item => item.id === sourceId)))
    .map(card => card.id)

  // 不变量：跨插入点绝不动——pre-step 的可移动集合里根本没有 system-section 卡
  const preStep = movableView(key('P1'))
  assert.deepEqual(preStep, [key('P1'), key('P2')])
  assert.equal(reorderToView(cards, key('P1'), key('S1'), true, preStep), cards)

  // 跨官方档位：order 不同不再拦住排序，configOrder 覆盖先后
  assert.deepEqual(movableView(key('S1')), [key('S1'), key('S2')])
  // 资格在可移动集合里判，插入位置在完整数组里算：S2 落到 S1 紧前，P1/P2 的相对位置不变
  const moved = reorderToView(cards, key('S2'), key('S1'), true, movableView(key('S2')))
  assert.deepEqual(moved.map(card => card.id), [key('P1'), key('P2'), key('S2'), key('S1')])
  // 不可移动集合外的卡不被重建：引用逐字保留
  assert.equal(moved.find(card => card.id === key('P1')), cards[0])
  assert.equal(moved.find(card => card.id === key('P2')), cards[1])
})

test('双通道版本：卡定义的官方档位被改写后，旧 revision 的排序写入被拒（409）', () => {
  const root = fixture('reorder-conflict', { a: [
    { id: 'S1', text: 's1', layer: 'system-section', order: 100 },
    { id: 'S2', text: 's2', layer: 'system-section', order: 500 },
  ] })
  setModuleEnabled(root, 'a', true)
  const before = readModuleConfigOrder(root)
  const file = join(root, 'a', 'module.yml')
  const raw = readFileSync(file, 'utf8')
  const spec = JSON.parse(raw.slice(raw.indexOf('{')))
  spec.rules.find(rule => rule.id === 'S1').then[0].config.order = 200
  writeFileSync(file, '# keep comment\n' + JSON.stringify(spec))
  assert.throws(
    () => saveModuleConfigOrder(root, before.revision, identities(before)),
    error => error.code === 'module-config-order-conflict',
    'system-section 卡的官方档位进入排序 revision：改过卡定义后旧 revision 不再可用',
  )
})
