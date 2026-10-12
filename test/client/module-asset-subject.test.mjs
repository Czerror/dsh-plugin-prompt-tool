/**
 * 装配集合视图的资产卡主语回归（T6）：每张资产卡的主语只能来自它的归属模块。
 *
 * 判据（RED 现场）：卡按归属取主语与读数（props / 逐模块事实），不从 store 全局兜底；
 * 缺主语时整块不渲染（`html === ''`，不在界面上出卡）；同一层两个模块的实例卡互不串读；
 * 卡片只渲染、请求走 store：请求主语用 stub fetch 断言 `x-module-id`（含「未声明＝零请求」）。
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
const { MainSessionPage } = await withSsr([
  new URL('../../src/client/app/workspace/pages/MainSessionPage.tsx', import.meta.url).href,
])
const { usePromptToolStore } = await withSsr([
  new URL('../../src/client/data/use-prompt-tool-store.ts', import.meta.url).href,
])
const { ModulePersonaCard, personaWriteBody, readModulePersona } = await withSsr([
  new URL('../../src/client/features/persona/ModulePersonaCard.tsx', import.meta.url).href,
])
const { readCustomTools } = await withSsr([
  new URL('../../src/client/features/tools/CustomToolsCard.tsx', import.meta.url).href,
])
const { readSubagentPolicy } = await withSsr([
  new URL('../../src/client/features/subagents/SubagentToolPolicyCard.tsx', import.meta.url).href,
])
const { saveModuleVariables: saveVariablesRequest } = await import('../../src/client/data/module-variables.ts')

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
    // 参数编辑器读回值：桩里没有按主语的读数，契约默认值就是「未读回」的视图。
    moduleParamsOf: () => EMPTY_PARAMS,
  }
}

/** 工具卡草稿：loaded 后按归属只读自己模块的条目。 */
const toolsDraft = (ids) => ({
  tools: ids.map((id) => ({ id })), saved: [], expanded: new Set(), fields: new Map(),
  loaded: true, error: '', saving: false,
})

test('无主语：资产卡整块不渲染（装配集合为空即无卡）', () => {
  const drafts = createWorkspaceDrafts()
  const html = renderElement(LayerSettingsContent, { store: stubStore(drafts), t, layer: 'tool-pipeline' })
  assert.equal(html, '', '没有归属模块就没有资产卡')
})

/** 声明面来自 `/meta` 的 `declares`：只决定「这一步发不发读」与「空内容从哪来」。
 *  固定卡（指令卡的参数组、人设卡）不受它影响；通用资产卡未声明时仍改出添加入口（既有行为不变）。 */
const modulesDeclaring = (declares) => [
  { id: 'mod-a', name: 'A', enabled: true, facts: facts(), declares },
]

test('声明面：未声明 customTools 的模块不出这张通用卡，改出添加入口（不渲染草稿里的工具）', () => {
  const drafts = createWorkspaceDrafts()
  drafts.tools.set('mod-a', toolsDraft(['tool-a']))
  const store = stubStore(drafts, modulesDeclaring(['rules']))
  const html = renderElement(LayerSettingsContent, { store, t, layer: 'tool-pipeline', moduleId: 'mod-a' })
  assert.doesNotMatch(html, /tool-a/, '未声明就不出这张卡：草稿里的工具不渲染')
  assert.doesNotMatch(html, /data-layer-asset="custom-tools"/, '未声明的资产卡整体不出场')
  assert.match(html, /data-declare-section="customTools"/, '该处改出添加入口（节名＝module.yml 顶层键）')
  assert.match(html, new RegExp(`aria-label="${t('declare.add', { name: t('customTools.aria') })} · ${t('rules.source', { module: 'mod-a' })}"`),
    '添加入口的主语＝该模块')
})

test('声明面：声明了 customTools 但内容为空 → 卡片渲染为空态，不给添加入口', () => {
  const drafts = createWorkspaceDrafts()
  const store = stubStore(drafts, modulesDeclaring(['rules', 'customTools']))
  const html = renderElement(LayerSettingsContent, { store, t, layer: 'tool-pipeline', moduleId: 'mod-a' })
  assert.match(html, /data-layer-asset="custom-tools"/, '声明了该节就出卡（空态由卡自己渲染）')
  assert.doesNotMatch(html, /data-declare-section="customTools"/, '已声明不再给添加入口（两种形态不同）')
})

test('声明面：逐节判定——声明了 customTools 不给它入口，未声明的 subagentToolPolicy 仍出入口', () => {
  const store = stubStore(createWorkspaceDrafts(), modulesDeclaring(['rules', 'customTools']))
  const html = renderElement(LayerSettingsContent, { store, t, layer: 'tool-pipeline', moduleId: 'mod-a' })
  assert.doesNotMatch(html, /data-declare-section="customTools"/, '已声明的节不给入口')
  assert.match(html, /data-declare-section="subagentToolPolicy"/, '同层别的未声明节照旧出入口')
})

test('声明面：声明面未下发（老载荷／损坏模块）＝未知，照旧出卡不误判成未声明', () => {
  const drafts = createWorkspaceDrafts()
  drafts.tools.set('mod-a', toolsDraft(['tool-a']))
  const store = stubStore(drafts, twoModules)
  const html = renderElement(LayerSettingsContent, { store, t, layer: 'tool-pipeline', moduleId: 'mod-a' })
  assert.match(html, /tool-a/, '未知声明面不改变今天的渲染')
  assert.doesNotMatch(html, /data-declare-section="customTools"/)
})

test('声明面：params／layerSettings 未声明也照常渲染参数组（固定设置区，不是通用卡）', () => {
  const store = stubStore(createWorkspaceDrafts(), modulesDeclaring(['rules']))
  const html = renderElement(LayerSettingsContent, { store, t, layer: 'pre-step', moduleId: 'mod-a' })
  assert.match(html, /data-layer-param-group="prompt-defaults"/, '未声明 params 也出参数组（不许 return []）')
  assert.match(html, /data-layer-param-fields="prompt-defaults"/, '参数控件照旧渲染出来')
  // 对照：声明了 params 的模块渲染形态一致（渲染不随声明面变）。
  const declaredStore = stubStore(createWorkspaceDrafts(), modulesDeclaring(['rules', 'params']))
  const declaredHtml = renderElement(LayerSettingsContent, { store: declaredStore, t, layer: 'pre-step', moduleId: 'mod-a' })
  assert.match(declaredHtml, /data-layer-param-group="prompt-defaults"/, '已声明照旧出参数组')
})

test('声明面：未声明任何节的模块，参数组与添加入口同时在场（入口不是唯一通路）', () => {
  const store = stubStore(createWorkspaceDrafts(), modulesDeclaring(['rules']))
  const html = renderElement(LayerSettingsContent, { store, t, layer: 'pre-step', moduleId: 'mod-a' })
  assert.match(html, /data-layer-param-group="prompt-defaults"/, '参数编辑器在场')
  assert.match(html, /data-layer-param-fields="prompt-defaults"/, '参数控件（含路径指引设置）渲染出来')
  assert.doesNotMatch(html, /data-declare-section="params"/, '参数组不走「添加入口」通路，没有多余的入口')
})

test('声明面：人设写载荷——创建模式不传 expectedRevision，已声明带读取版本', () => {
  const creating = personaWriteBody('mod-a', { main: { prefix: 'P' } }, '', true)
  assert.deepEqual(creating, { persona: { main: { prefix: 'P' } }, expectedModuleId: 'mod-a' }, '创建模式不带版本期望（空串会被服务端当非法版本拒绝）')
  assert.equal('expectedRevision' in creating, false)
  const declared = personaWriteBody('mod-a', { main: { prefix: 'P' } }, 'a'.repeat(64), false)
  assert.equal(declared.expectedRevision, 'a'.repeat(64), '已声明带读取时的模块版本')
  assert.equal(personaWriteBody('mod-a', {}, '', true).persona, null, '空对象仍是删除语义')
})

test('声明面：变量写载荷——没有前状态整键不带 expectedRevisions，有前状态照旧带版本', async () => {
  const bodies = []
  const request = async (body) => {
    bodies.push(body)
    return { ok: true, value: { global: {}, module: { k: 'v' }, effective: { k: 'v' }, revisions: { global: null, module: 'M2', settings: 'S2' }, enabled: true } }
  }
  // 创建模式：合成基线没有任何版本 → 整键缺席（只留键而值是 undefined 经 JSON 会变 `{}`，服务端读不到期望）。
  await saveVariablesRequest('mod-a', { scope: 'module', variables: {}, enabled: true, revisions: {} }, { variables: { k: 'v' }, enabled: true }, request)
  const creating = bodies[0]
  assert.deepEqual(creating, { scope: 'module', expectedModuleId: 'mod-a', variables: { k: 'v' } }, '创建写不带版本期望')
  assert.equal('expectedRevisions' in creating, false)
  // 有前状态：照旧带该 scope 的版本。
  await saveVariablesRequest('mod-a',
    { scope: 'module', variables: {}, enabled: true, revisions: { global: null, module: 'M1', settings: 'S1' } },
    { variables: { k: 'v2' }, enabled: true }, request)
  assert.deepEqual(bodies[1].expectedRevisions, { module: 'M1' }, '有前状态仍按既有并发校验')
})

test('声明面：三张通用卡的读——未声明一个请求都不发，声明后各读一次（编辑器在场不受影响）', async () => {
  const fetchStub = withFetch(() => ({ ok: true, value: {} }))
  try {
    await readCustomTools('mod-a', true)
    await readSubagentPolicy('mod-a', true)
    await readModulePersona('mod-a', true)
    assert.equal(fetchStub.requests.length, 0, '未声明时一个请求都没发出去')
    // 同一未声明主语：固定卡（人设编辑器、指令卡参数组）照常渲染——「不读」不等于「不出编辑器」。
    const drafts = createWorkspaceDrafts()
    drafts.personaSources.value = { main: 'mod-a', subagent: null }
    drafts.expanded.set('mod-a:persona:main', true)
    const persona = renderElement(ModulePersonaCard, { t, audience: 'main', moduleId: 'mod-a', modules: modulesDeclaring(['rules']), drafts, onNotice: () => {} })
    assert.match(persona, /data-config-panel="prefix"/, '未声明的 persona 编辑器在场')
    const params = renderElement(LayerSettingsContent, { store: stubStore(createWorkspaceDrafts(), modulesDeclaring(['rules'])), t, layer: 'pre-step', moduleId: 'mod-a' })
    assert.match(params, /data-layer-param-group="prompt-defaults"/, '未声明的参数组在场')

    fetchStub.requests.length = 0
    await readCustomTools('mod-a', false)
    await readSubagentPolicy('mod-a', false)
    await readModulePersona('mod-a', false)
    assert.deepEqual(fetchStub.requests.map((request) => request.path.split('/api/prompt-tool/settings')[1]),
      ['/custom-tools', '/subagent-tool-policy', '/persona'], '声明的节照旧各读一次')
    for (const request of fetchStub.requests) assert.equal(request.headers['x-module-id'], 'mod-a', '读的主语＝该模块')
  } finally {
    fetchStub.restore()
  }
})

test('声明面：逐层出卡——有参数组的层出参数编辑器，没有的层整块不出（不留死入口）', () => {
  const store = stubStore(createWorkspaceDrafts(), modulesDeclaring(['rules']))
  const render = (layer) => renderElement(LayerSettingsContent, { store, t, layer, moduleId: 'mod-a' })

  assert.match(render('pre-step'), /data-layer-param-group="prompt-defaults"/, 'pre-step 有参数组 → 渲染参数编辑器')
  assert.doesNotMatch(render('pre-step'), /data-declare-section="params"/, '参数组不走「添加入口」通路（它始终渲染）')

  // 该层没有参数组时不凭空造组、也不给参数入口：整块不出。
  for (const layer of ['system-section', 'runtime-context', 'tool-pipeline']) {
    const html = render(layer)
    assert.doesNotMatch(html, /data-layer-param-group=/, `${layer} 没有该层参数组`)
    assert.doesNotMatch(html, /data-declare-section="params"/, `${layer} 不给参数入口（点了也没编辑器）`)
  }
})

test('声明面：通用资产卡进入创建模式后，声明一建立就退出创建模式（不粘连）', () => {
  // 卡内的创建模式提示带 role="status"；添加入口的同文案不带，所以按 role 前缀断言卡自己的形态。
  const cardHint = new RegExp(`role="status">${t('declare.createHint')}`)
  const html = (declares) => renderElement(LayerSettingsContent, {
    store: stubStore(createWorkspaceDrafts(), modulesDeclaring(declares)),
    t, layer: 'tool-pipeline', moduleId: 'mod-a', creatingSections: ['custom-tools'],
  })
  // 声明面里已含 customTools ⇒ 不是创建模式，卡回到正常形态（未声明判据是实时快照）。
  assert.match(html(['rules', 'customTools']), /data-layer-asset="custom-tools"/, '声明成立后卡照旧在场')
  assert.doesNotMatch(html(['rules', 'customTools']), cardHint, '声明成立后不再带创建模式提示')
  // 未声明时同一创建态才是创建模式（卡内提示在场）。
  assert.match(html(['rules']), /data-layer-asset="custom-tools"/, '未声明 + 创建态仍渲染该卡')
  assert.match(html(['rules']), cardHint, '未声明 + 创建态 ⇒ 卡以创建模式渲染')
})

test('声明面：人设卡按主语的声明面渲染——未声明也照常出编辑器，空态带建立声明提示', () => {
  const html = (declares) => {
    const drafts = createWorkspaceDrafts()
    drafts.personaSources.value = { main: 'mod-a', subagent: null }
    drafts.expanded.set('mod-a:persona:main', true)
    return renderElement(ModulePersonaCard, { t, audience: 'main', moduleId: 'mod-a', modules: modulesDeclaring(declares), drafts, onNotice: () => {} })
  }
  const undeclared = html(['rules'])
  assert.match(undeclared, /data-config-panel="prefix"/, '未声明也出编辑器（不许只给入口/按钮）')
  assert.match(undeclared, new RegExp(`role="status">${t('declare.createHint')}`), '空态带「保存即建立该节」提示')
  const declaredHtml = html(['rules', 'persona'])
  assert.match(declaredHtml, /data-config-panel="prefix"/, '声明了 persona 照旧出编辑器')
  assert.doesNotMatch(declaredHtml, new RegExp(`role="status">${t('declare.createHint')}`), '已声明没有「尚未声明」提示')
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

/** T18：每模块横栏已删除——创建入口只剩页级一处（不依赖「当前模块」，也不按模块重复）。 */
test('创建入口接线：页级「添加」下拉在场（主语不由菜单给）', () => {
  const drafts = createWorkspaceDrafts()
  drafts.rules.set('mod-a', rulesDraft('rule-a'))
  drafts.rules.set('mod-b', rulesDraft('rule-b'))
  const store = stubStore(drafts, [
    ...twoModules,
    { id: 'mod-off', name: 'off', enabled: false, facts: facts() },
  ])
  // 走真实页级编排：清单由页面自己算（`MainSessionPage` 不接受调用方传清单），这里只断言接线结果。
  const html = renderElement(MainSessionPage, { store, t })
  assert.match(html, new RegExp(`aria-label="${t('modules.addTemplates')}"`), '页级创建入口的可访问名＝添加注入模板')
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

test('store：全局层参数读自 /bootstrap 的全局段，写不带主语头（指令卡的一个开关）', async () => {
  const fetchStub = withFetch((request) => {
    if (request.path.endsWith('/bootstrap')) return { ...bootstrapPayload(twoModules), globalParams: { instructionHint: true } }
    if (request.path.endsWith('/param-overrides')) return { ok: true, value: { overrides: { instructionHint: true } } }
    return { ok: true, value: {} }
  })
  try {
    const store = mountStore()
    await store.load()
    assert.equal(store.globalParamsLoaded, true, '全局段随 bootstrap 读回')
    assert.equal(store.globalParams.instructionHint, true, '全局值照原样回显')

    store.setGlobalParam('instructionHint', false)
    await store.persistGlobalParams()
    const write = fetchStub.writes()[0]
    assert.equal(write.headers['x-module-id'], undefined, '全局层写不带主语头（空主语＝全局层）')
    assert.deepEqual(write.body, { overrides: { instructionHint: false } }, '只写全局层的键')
    assert.equal(fetchStub.requests.some((request) => request.headers['x-module-id'] !== undefined && request.path.endsWith('/param-overrides')), false,
      '没有任何模块被写：全局层与模块层各存各的')
  } finally {
    fetchStub.restore()
  }
})

test('store：silent load 重读 /meta 快照（创建模式写后刷新声明面的触发点）', async () => {
  const modules = [{ id: 'mod-a', name: 'A', enabled: true, facts: facts(), declares: ['rules'] }]
  const fetchStub = withFetch((request) => {
    if (request.path.endsWith('/bootstrap')) return bootstrapPayload(modules)
    return { ok: true, value: {} }
  })
  try {
    const store = mountStore()
    await store.load()
    const bootstraps = () => fetchStub.requests.filter((request) => request.path.endsWith('/bootstrap')).length
    const mark = bootstraps()
    await store.load({ silent: true })
    assert.equal(bootstraps(), mark + 1, 'silent load 仍是一次 /meta 重读（不闪 loading 但不省请求）')
  } finally {
    fetchStub.restore()
  }
})

test('store：未声明 params 的模块不发这次读；首次写走既有写路径建立声明并重读 /meta', async () => {
  const modules = [{ id: 'mod-a', name: 'A', enabled: true, facts: facts(), declares: ['rules'] }]
  const fetchStub = withFetch((request) => {
    if (request.path.endsWith('/bootstrap')) return bootstrapPayload(modules)
    if (request.path.endsWith('/param-overrides')) return { ok: true, value: { overrides: {} } }
    return { ok: true, value: {} }
  })
  try {
    const store = mountStore()
    await store.load()
    const mark = fetchStub.requests.length
    store.ensureModuleParams('mod-a')
    store.ensureModuleVariables('mod-a')
    await tick()
    const reads = fetchStub.requests.slice(mark)
    assert.equal(reads.filter((request) => request.path.endsWith('/param-overrides')).length, 0,
      '没声明 params 就不发这次读（发过去也是 400）')
    assert.equal(reads.filter((request) => request.path.endsWith('/module-variables')).length, 0,
      '没声明 variables 同样不发读')

    store.setModuleParam('mod-a', 'maxDepth', '3')
    await store.persistParamOverrides('mod-a')
    const write = fetchStub.writes()[0]
    assert.ok(write, '未声明时首次写仍走既有写路径：写就是创建这个节')
    assert.equal(write.headers['x-module-id'], 'mod-a')
    assert.deepEqual(write.body, { overrides: { maxDepth: 3 }, expectedModuleId: 'mod-a' })
    assert.ok(fetchStub.requests.filter((request) => request.path.endsWith('/bootstrap')).length >= 2,
      '写成功后重读 /meta，声明面快照随之刷新')
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

test('人设卡接线：来源＝官方（没有模块主语）时也能展开，界面与模块主语态同形（只接线）', () => {
  // 修复前：展开键在无模块主语时是 `undefined` ⇒ 卡头点不动、整个设计好的卡体看不见
  // （浏览器实测：#persona-main 点击后 aria-expanded 仍 false、textarea 数 0）。
  const drafts = createWorkspaceDrafts()
  drafts.personaSources.value = { main: null, subagent: null }
  drafts.expanded.set(':persona:main', true)
  const html = renderElement(ModulePersonaCard, { t, audience: 'main', modules: modulesDeclaring(['rules']), drafts, onNotice: () => {} })
  assert.match(html, /data-config-panel="prefix"/, '继承官方态照常展开')
  assert.match(html, /data-config-panel="suffix"/, '后置面板同样在场')
  assert.match(html, new RegExp(t('persona.sources.label', { audience: t('persona.main') })), '来源选择器在场')
  assert.match(html, new RegExp(t('persona.inherit')), '选项区仍有「继承官方」')
  assert.match(html, new RegExp(t('persona.complete.label')), '独占选项在场')
  assert.match(html, new RegExp(t('persona.runtimeContext.label')), '动态运行时上下文选项在场')
  assert.match(html, new RegExp(t('persona.reload')), '页脚「重新读取人设」在场')
})
