/**
 * 装配集合视图的资产卡主语回归（T6）：每张资产卡的主语只能来自它的归属模块。
 *
 * 判据（RED 现场）：卡按归属取主语与读数（props / 逐模块事实），不从 store 全局兜底；
 * 缺主语时整块不渲染、不建草稿键；同一层两个模块的实例卡互不串读。
 * 卡片只渲染、请求走 store：请求主语用 stub fetch 断言 `x-module-id`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderElement, withSsr, makeTranslate } from './support/ssr-render.mjs'
import { createWorkspaceDrafts } from '../../src/client/data/workspace-drafts.ts'
import { EMPTY_PARAMS } from '../../src/client/data/param-overrides.ts'
import { canEditModule } from '../../src/client/data/module-subject.ts'

const t = makeTranslate()
const { LayerSettingsContent, injectionPointSlots } = await withSsr([
  new URL('../../src/client/app/workspace/pages/InjectionPointsPanel.tsx', import.meta.url).href,
])
const { RulesWorkspace } = await withSsr([
  new URL('../../src/client/features/prompts/RulesWorkspace.tsx', import.meta.url).href,
])
const { usePromptToolStore } = await withSsr([
  new URL('../../src/client/data/use-prompt-tool-store.ts', import.meta.url).href,
])

const facts = (editable = true) => ({ declaredModules: [], effectiveModules: [], rowIds: [], sourceMode: 'explicit', editable })
const twoModules = [
  { id: 'mod-a', name: 'A', enabled: true, facts: facts() },
  { id: 'mod-b', name: 'B', enabled: true, facts: facts() },
]

/** 卡只读 store 上的这几个面：事实来自 /meta 的 modules[].facts，草稿与读数按模块归属。 */
const stubStore = (drafts, modules = twoModules) => {
  const fields = { modulesEnabled: true, promptConfigs: [] }
  return {
    fields,
    meta: { layers: [], modules },
    editorDrafts: drafts,
    showNotice: () => {},
    getFields: () => fields,
    subscribeFields: () => () => {},
    getDraftRevision: () => 0,
    subscribeDrafts: () => () => {},
    publishDrafts: () => {},
    enqueueModuleTask: (_moduleId, task) => task(),
    enqueueRuleTask: (task) => task(),
  }
}

/** 工具卡草稿：loaded 后按归属只读自己模块的条目。 */
const toolsDraft = (ids) => ({
  tools: ids.map((id) => ({ id })), saved: [], expanded: new Set(), fields: new Map(),
  loaded: true, error: '', saving: false,
})

test('无主语：资产卡整块不渲染（装配集合为空即无卡），也不建任何草稿键', () => {
  const drafts = createWorkspaceDrafts()
  const html = renderElement(LayerSettingsContent, { store: stubStore(drafts), t, layer: 'tool-pipeline' })
  assert.equal(html, '', '没有归属模块就没有资产卡')
  assert.equal(drafts.fields.size, 0)
  assert.equal(drafts.expanded.size, 0)
  assert.equal(drafts.policies.size, 0)
  assert.equal(drafts.tools.size, 0)
})

test('同一层两个模块的实例卡各自渲染自己模块的资产', () => {
  const drafts = createWorkspaceDrafts()
  drafts.tools.set('mod-a', toolsDraft(['tool-a']))
  drafts.tools.set('mod-b', toolsDraft(['tool-b']))
  const render = (moduleId) => renderElement(LayerSettingsContent, { store: stubStore(drafts), t, layer: 'tool-pipeline', moduleId })
  const a = render('mod-a')
  const b = render('mod-b')
  assert.match(a, /tool-a/, 'A 卡渲染 A 模块的工具')
  assert.doesNotMatch(a, /tool-b/, 'A 卡不得读到 B 模块的工具')
  assert.match(b, /tool-b/, 'B 卡渲染 B 模块的工具')
  assert.doesNotMatch(b, /tool-a/, 'B 卡不得读到 A 模块的工具')
})

/** 规则卡草稿：一张 tool-pipeline 层的实例卡（展开态由 browse.expanded 指定）。 */
const rulesDraft = (id) => ({
  entries: [{ key: id, previousId: null, value: { id, name: id, layer: 'tool-pipeline', then: [] } }],
  saved: [], fields: new Map(), loaded: true, validated: true, sequence: 1, nextKey: 2,
})

test('规则工作台：同一层两个模块的规则卡各自按自己模块的事实判层内设置（跨模块不串判据）', () => {
  const drafts = createWorkspaceDrafts()
  drafts.rules.set('mod-a', rulesDraft('rule-a'))
  drafts.rules.set('mod-b', rulesDraft('rule-b'))
  // 只有 A 的装配事实含 tool-git-bash：搜索该能力时只有 A 的卡命中它自己的层内设置。
  const store = stubStore(drafts, [
    { id: 'mod-a', name: 'A', enabled: true, facts: { ...facts(), effectiveModules: ['tool-git-bash'] } },
    { id: 'mod-b', name: 'B', enabled: true, facts: facts() },
  ])
  const html = renderElement(RulesWorkspace, {
    store, t, keyword: 'tool-git-bash',
    browse: { filter: 'tool-git-bash', viewFilter: 'all', variablesExpanded: false },
    ...injectionPointSlots({ store, t, viewFilter: 'all', audience: 'main', keyword: 'tool-git-bash' }),
  })
  assert.match(html, /rule-a/, 'A 的层内设置命中自己模块的装配事实')
  assert.doesNotMatch(html, /rule-b/, 'B 的事实里没有该能力，不跟着 A 命中')
})

test('新建入口：每个已装配模块恰好一条，且入口主语是该模块（未启用模块没有入口）', () => {
  const drafts = createWorkspaceDrafts()
  drafts.rules.set('mod-a', rulesDraft('rule-a'))
  drafts.rules.set('mod-b', rulesDraft('rule-b'))
  drafts.rules.set('mod-off', rulesDraft('rule-off'))
  const store = stubStore(drafts, [
    ...twoModules,
    { id: 'mod-off', name: 'off', enabled: false, facts: facts() },
  ])
  const html = renderElement(RulesWorkspace, {
    store, t, ...injectionPointSlots({ store, t, viewFilter: 'all', audience: 'main' }),
  })
  const groups = [...html.matchAll(/data-module-create="([^"]+)"/g)].map((match) => match[1])
  assert.deepEqual(groups, ['mod-a', 'mod-b'], '每个已装配模块恰好一条新建入口，未启用模块没有入口')
  for (const moduleId of groups) {
    const ownership = ` · ${t('rules.source', { module: moduleId })}`
    assert.match(html, new RegExp(`aria-label="${t('modules.addTemplates')}${ownership}"`), `新建配置入口的归属＝${moduleId}`)
    assert.match(html, new RegExp(`aria-label="${t('main.addToolTemplate')}${ownership}"`), `新建工具模板入口的归属＝${moduleId}`)
  }
  assert.ok(!html.includes('data-module-create="mod-off"'), '未启用模块不出现新建入口')
})

/** 按钮标签定位（含 `[^>]*`，标签里没有 `>`）。 */
const labelledButtons = (html, label) => [...html.matchAll(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`, 'g'))].map((match) => match[0])

test('新建入口：规则草稿尚未读回时禁用（新规则只能落在已读回的草稿上）', () => {
  // 不预置 rules 草稿：useModuleRuleEditors 会建出 loaded=false 的草稿（SSR 不跑 effect，读回不会发生）。
  const store = stubStore(createWorkspaceDrafts())
  const html = renderElement(RulesWorkspace, {
    store, t, ...injectionPointSlots({ store, t, viewFilter: 'all', audience: 'main' }),
  })
  for (const moduleId of ['mod-a', 'mod-b']) {
    const ownership = ` · ${t('rules.source', { module: moduleId })}`
    const rule = labelledButtons(html, `${t('modules.addTemplates')}${ownership}`)
    const tool = labelledButtons(html, `${t('main.addToolTemplate')}${ownership}`)
    assert.equal(rule.length, 1, `${moduleId} 的新建配置入口在场`)
    assert.match(rule[0], /disabled/, `${moduleId} 的规则草稿未读回时新建配置禁用`)
    assert.match(tool[0], /disabled/, `${moduleId} 的规则草稿未读回时新建工具模板禁用`)
  }
  // 已读回时同一入口必须可用（对照，避免把「永远禁用」当成修好）。
  const loaded = createWorkspaceDrafts()
  loaded.rules.set('mod-a', rulesDraft('rule-a'))
  loaded.rules.set('mod-b', rulesDraft('rule-b'))
  const loadedHtml = renderElement(RulesWorkspace, {
    store: stubStore(loaded), t, ...injectionPointSlots({ store, t, viewFilter: 'all', audience: 'main' }),
  })
  for (const moduleId of ['mod-a', 'mod-b']) {
    const ownership = ` · ${t('rules.source', { module: moduleId })}`
    assert.doesNotMatch(labelledButtons(loadedHtml, `${t('modules.addTemplates')}${ownership}`)[0], /disabled/, `${moduleId} 读回后可新建配置`)
  }
})

/** stub fetch：记录每次请求的路径、头与 JSON 载荷。 */
function withFetch(handler) {
  const requests = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const request = {
      path: String(url),
      headers: init?.headers ?? {},
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    }
    requests.push(request)
    return { status: 200, text: async () => JSON.stringify(handler(request)) }
  }
  return {
    requests,
    restore: () => { globalThis.fetch = original },
    reads: () => requests.filter((request) => request.path.endsWith('/param-overrides') && request.body?.overrides === undefined),
    writes: () => requests.filter((request) => request.path.endsWith('/param-overrides') && request.body?.overrides !== undefined),
  }
}

const settingsStub = () => {
  const document = {}
  const scope = { subscribe: () => () => {}, getSnapshot: () => ({ value: document, revision: 1, writable: true, status: 'ready' }), mutate: async () => {} }
  return { scope, ensure: async () => {}, mutate: async () => {} }
}

const bootstrapPayload = (modules) => ({
  ok: true,
  value: { value: { modulesEnabled: true }, base: {}, revision: 1 },
  meta: { meta: { layers: [], modules } },
})

/** SSR 下拿到 store 实例（不跑 effect：模块类读取由测试显式触发）。 */
function mountStore() {
  let store
  function Probe() { store = usePromptToolStore({ currentSessionId: () => undefined }, settingsStub()); return null }
  renderElement(Probe, {})
  return store
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('store：空主语 bootstrap 不带 x-module-id；模块参数按主语读一次并在层卡之间共享', async () => {
  const fetchStub = withFetch((request) => {
    if (request.path.endsWith('/bootstrap')) return bootstrapPayload(twoModules)
    if (request.path.endsWith('/param-overrides')) return { ok: true, value: { overrides: { maxDepth: 9 } } }
    return { ok: true, value: {} }
  })
  try {
    const store = mountStore()
    await store.load()
    const boot = fetchStub.requests.find((request) => request.path.endsWith('/bootstrap'))
    assert.equal(boot.headers['x-module-id'], undefined, '首屏不再带任何模块主语')

    assert.deepEqual(store.moduleParamsOf('mod-a'), EMPTY_PARAMS, '未读回前不虚构模块参数')
    fetchStub.requests.length = 0
    store.ensureModuleParams('mod-a')
    store.ensureModuleParams('mod-a')
    await tick()
    const reads = fetchStub.reads()
    assert.equal(reads.length, 1, '同一模块同一轮加载只读一次（层卡之间共享同一份）')
    assert.equal(reads[0].headers['x-module-id'], 'mod-a', '参数读的主语是该卡归属的模块')
    assert.equal(store.moduleParamsOf('mod-a').maxDepth, '9')
    assert.deepEqual(store.moduleParamsOf('mod-b'), EMPTY_PARAMS, '别的模块不继承这份读数')
  } finally {
    fetchStub.restore()
  }
})

test('store：写参数只写该模块的键与主语；不可编辑模块不发请求', async () => {
  const modules = [twoModules[0], { ...twoModules[1], facts: facts(false) }]
  const fetchStub = withFetch((request) => {
    if (request.path.endsWith('/bootstrap')) return bootstrapPayload(modules)
    if (request.path.endsWith('/param-overrides')) return { ok: true, value: { overrides: { maxDepth: 9 } } }
    return { ok: true, value: {} }
  })
  try {
    const store = mountStore()
    await store.load()
    store.ensureModuleParams('mod-a')
    await tick()
    store.setModuleParam('mod-a', 'maxDepth', '3')
    await store.persistParamOverrides('mod-a')
    const write = fetchStub.writes()[0]
    assert.equal(write.headers['x-module-id'], 'mod-a')
    assert.deepEqual(write.body, { overrides: { maxDepth: 3 }, expectedModuleId: 'mod-a' }, '只写该模块已存/已改的键')

    const before = fetchStub.requests.length
    await store.persistParamOverrides('mod-b')
    await tick()
    assert.equal(fetchStub.requests.length, before, '不可编辑的模块不发模块类请求')
    // 判据本身逐模块：同一次装配里 A 可编辑不影响 B（notice 是 React 状态，SSR 下只认判据与请求）。
    assert.equal(canEditModule({ modulesEnabled: true }, modules, 'mod-b'), false)
    assert.equal(canEditModule({ modulesEnabled: true }, modules, 'mod-a'), true)
  } finally {
    fetchStub.restore()
  }
})

test('store：模块退出装配集合后，下一轮 load 不再为它读参数（请求数随装配集合，不随历史）', async () => {
  let modules = twoModules
  const fetchStub = withFetch((request) => {
    if (request.path.endsWith('/bootstrap')) return bootstrapPayload(modules)
    if (request.path.endsWith('/param-overrides')) return { ok: true, value: { overrides: { maxDepth: 9 } } }
    return { ok: true, value: {} }
  })
  try {
    const store = mountStore()
    await store.load()
    store.ensureModuleParams('mod-a')
    store.ensureModuleParams('mod-b')
    await tick()
    assert.deepEqual(fetchStub.reads().map((request) => request.headers['x-module-id']).sort(), ['mod-a', 'mod-b'], '两个装配模块各读一次')

    // mod-b 退出装配集合（停用/删除），meta 只剩 mod-a：下一轮 load 只重读 mod-a。
    modules = [twoModules[0]]
    const mark = fetchStub.requests.length
    await store.load()
    await tick()
    const reread = fetchStub.requests.slice(mark).filter((request) => request.path.endsWith('/param-overrides'))
    assert.deepEqual(reread.map((request) => request.headers['x-module-id']), ['mod-a'], '不再为已退出装配集合的模块发请求')
  } finally {
    fetchStub.restore()
  }
})

test('store：读在飞的模块被剪枝后，迟到的读数不落地、也不复活成后续请求', async () => {
  let modules = twoModules
  let releaseModB
  const requests = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const request = {
      path: String(url),
      headers: init?.headers ?? {},
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    }
    requests.push(request)
    const respond = (payload) => ({ status: 200, text: async () => JSON.stringify(payload) })
    if (request.path.endsWith('/bootstrap')) return respond(bootstrapPayload(modules))
    if (request.path.endsWith('/param-overrides')) {
      // mod-b 的参数读悬挂在这里，等测试显式放行：模拟「读还没回来，模块已被剪枝」。
      if (request.headers['x-module-id'] === 'mod-b') await new Promise((resolve) => { releaseModB = resolve })
      return respond({ ok: true, value: { overrides: { maxDepth: 9 } } })
    }
    return respond({ ok: true, value: {} })
  }
  try {
    const store = mountStore()
    await store.load()
    store.ensureModuleParams('mod-a')
    store.ensureModuleParams('mod-b')
    await tick()
    assert.equal(typeof releaseModB, 'function', 'mod-b 的参数读已发出且悬挂中')

    // mod-b 退出装配集合（停用/删除）：这一轮 load 剪掉它的按主语状态（此时它的读还在飞）。
    modules = [twoModules[0]]
    await store.load()
    await tick()

    // 迟到的读数这时才返回：不得写回该模块的按主语状态。
    releaseModB()
    await tick()
    assert.deepEqual(store.moduleParamsOf('mod-b'), EMPTY_PARAMS, '迟到的读数不落地')

    const lateReads = requests.filter((request) => request.path.endsWith('/param-overrides') && request.headers['x-module-id'] === 'mod-b')
    assert.equal(lateReads.length, 1, '该模块的参数读只发生过一次（没有复活重读）')
    const mark = requests.length
    await store.load()
    await tick()
    const after = requests.slice(mark).filter((request) => request.path.endsWith('/param-overrides') && request.headers['x-module-id'] === 'mod-b')
    assert.equal(after.length, 0, '已退出装配集合的模块不再发请求')
  } finally {
    globalThis.fetch = original
  }
})
