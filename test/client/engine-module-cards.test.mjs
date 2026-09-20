import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { createElement, isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { ENGINE_CAPABILITIES, ENGINE_EDITOR_GROUP_MAP, ENGINE_LAYER_ORDER, engineCapability, engineRecipe, isEditorGroupVisible } from '../../src/shared/engine-capabilities.ts'
import { ENGINE_PARAM_DEFINITIONS, ENGINE_PARAM_KEYS } from '../../src/shared/engine-params.ts'
import { displayLayers, INSERTION_LAYERS } from '../../src/client/features/prompts/prompt-config-policy.ts'
import { EMPTY_FIELDS } from '../../src/client/data/prompt-tool-fields.ts'
import { PROMPT_TOOL_DICTS } from '../../src/client/locales.ts'
import { useTemplatePicker } from '../../src/client/features/prompts/useTemplatePicker.ts'
import { getEngineMeta } from '../../engine/schema.mjs'

const read = (path) => readFileSync(new URL(`../../src/client/${path}`, import.meta.url), 'utf8')
const reactModules = Object.fromEntries(['react', 'react/jsx-runtime', 'react-dom'].map((name) => [name, import.meta.resolve(name)]))
const loader = registerHooks({
  resolve(specifier, context, nextResolve) {
    return reactModules[specifier] === undefined ? nextResolve(specifier, context) : { url: reactModules[specifier], shortCircuit: true }
  },
  load(url, context, nextLoad) {
    // 真实类名表：SSR 断言与 `{ ...styles }` 合并都要看得到 CSS Modules 键。
    if (url.endsWith('.css')) {
      const source = readFileSync(new URL(url), 'utf8')
      const names = [...new Set([...source.matchAll(/\.([A-Za-z_][\w-]*)/g)].map(([, name]) => name))]
      return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(Object.fromEntries(names.map((name) => [name, name])))}` }
    }
    if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 },
    }).outputText }
    return nextLoad(url, context)
  },
})
const { EngineParamFields, EngineParamField } = await import('../../src/client/features/modules/EngineParamFields.tsx')
const { ToolPipelineSettingsCard, TOOL_PIPELINE_SETTING_GROUPS } = await import('../../src/client/app/workspace/pages/EngineLayersPanel.tsx')
const { LayerSettingsContent, layerParamCards, layerHasSettings } = await import('../../src/client/app/workspace/pages/EngineLayersPanel.tsx')
const { LayerCard } = await import('../../src/client/ui/LayerCard.tsx')
const { EngineModuleCards, EngineCapabilityCreateMenu } = await import('../../src/client/features/modules/EngineModuleList.tsx')
const { PromptConfigForm } = await import('../../src/client/features/prompts/PromptConfigForm.tsx')
const { OptionField } = await import('../../src/client/features/prompts/PromptConfigFields.tsx')
const { PromptConfigList } = await import('../../src/client/features/prompts/PromptConfigList.tsx')
const { TemplatePicker } = await import('../../src/client/ui/TemplatePicker.tsx')
loader.deregister()
const render = (component, props) => renderToStaticMarkup(createElement(component, props))
const tree = (component, props) => {
  let result
  function Probe() { result = component(props); return null }
  render(Probe)
  return result
}
const find = (node, predicate) => {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean)
  if (!isValidElement(node)) return undefined
  return predicate(node) ? node : find(node.props.children, predicate)
}
/** 渲染用翻译：与官方 locale 同形（键 + {name} 插值），断言直接对比 zh 词典值。 */
const zh = PROMPT_TOOL_DICTS.zh
const t = (key, params) => {
  let text = zh[key] ?? key
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}
const store = {
  fields: { ...EMPTY_FIELDS },
  moduleFacts: { sourceMode: 'explicit', effectiveModules: [], declaredModules: [], editable: true, rowIds: [] },
}
/** 能力存在性以显式 modules 声明为准：测试同时给出声明与生效清单，避免两处漂移。 */
const withModules = (modules) => ({ ...store.moduleFacts, effectiveModules: modules, declaredModules: modules })

test('模块字段从目录渲染，每个参数有且只有一个配置卡 owner', () => {
  const engineCards = new Set(ENGINE_CAPABILITIES.map(({ id }) => id))
  const specializedCards = new Set(['main-model', 'subagent-model', 'subagent-tools'])
  for (const key of ENGINE_PARAM_KEYS) {
    const definition = ENGINE_PARAM_DEFINITIONS[key]
    assert.ok(engineCards.has(definition.card) || specializedCards.has(definition.card) || definition.card === 'prompt-defaults', key)
    if (specializedCards.has(definition.card)) continue
    // 显示标签来自 UI 字典（shared 只给键），键名规则 `param.<键>`。
    const label = zh[`param.${key}`]
    assert.ok(typeof label === 'string' && label.length > 0, `${key} 必须有 UI 字典词条`)
    const html = render(EngineParamFields, { store, card: definition.card, t })
    assert.ok(html.includes(label.replaceAll('&', '&amp;')), `${key} 必须有字段标签`)
    if (key !== 'stages') assert.ok(html.includes(`aria-label="${label}"`), `${key} 必须有可访问输入控件`)
  }
})

test('卡片存在性来自装配事实，一项装配能力一张卡', () => {
  const absent = render(EngineModuleCards, { store, t })
  assert.doesNotMatch(absent, /class="configName">tool-bootstrap</)
  const active = { ...store, moduleFacts: withModules(['tool-bootstrap', 'filesystem-editor', 'promoted-code-mode', 'progress-reminder']) }
  const html = render(EngineModuleCards, { store: active, t, showPromptDefaults: false })
  assert.equal((html.match(/data-module-card="true"/g) ?? []).length, 4, '每项装配能力一张卡')
  for (const id of ['tool-bootstrap', 'promoted-code-mode', 'progress-reminder', 'str-replace-editor']) assert.match(html, new RegExp(`class="configName">${id}<`))
  // 卡头 meta 显示提供该能力的 modules 行（str-replace-editor 由 filesystem-editor 行提供）。
  assert.match(html, /class="configMeta">filesystem-editor</)
  assert.doesNotMatch(html, /编辑行为/, '不再提供编辑目标选择器')
  const filtered = render(EngineModuleCards, { store: active, t, layerFilter: 'pre-step' })
  assert.doesNotMatch(filtered, /class="configName">tool-bootstrap</)
  assert.doesNotMatch(filtered, /class="configName">str-replace-editor</)
  assert.doesNotMatch(filtered, /class="configName">(?:promoted-code-mode|progress-reminder)</)
  const anchored = render(EngineModuleCards, { store: { ...store, moduleFacts: withModules(['anchor-turn']) }, t, layerFilter: 'pre-step' })
  assert.ok(anchored.includes('class="configName">anchor-turn<'), 'pre-step 过滤只留本层能力卡')
  assert.doesNotMatch(render(EngineModuleCards, { store: { ...store, moduleFacts: withModules(['anchor-turn']) }, t, layerFilter: 'system-section' }), /class="configName">anchor-turn</)
  const legacyPolicy = { ...store, moduleFacts: { ...withModules(['delegation']), effectiveModules: ['delegation', 'subagent-tool-policy'] } }
  assert.match(render(EngineModuleCards, { store: legacyPolicy, t, layerFilter: 'tool-pipeline' }),
    /class="configName">subagent-tool-policy</, '历史隐式策略仍在运行，必须显示能力卡以便管理授权')
  const official = render(EngineModuleCards, { store: { ...active, moduleFacts: { ...active.moduleFacts, sourceMode: 'official' } }, t })
  assert.doesNotMatch(official, /class="configName">tool-bootstrap</)
})

test('能力与组合只引用新模块名，不接受旧模块名或编辑器模块别名', () => {
  const editor = engineCapability('str-replace-editor')
  assert.deepEqual(editor.moduleKeys, ['filesystem-editor'])
  assert.deepEqual(editor.rowIds, ['str-replace-editor'])
  for (const id of ['promoted-code-mode', 'progress-reminder']) {
    assert.deepEqual(engineCapability(id).moduleKeys, [id])
    assert.deepEqual(engineCapability(id).rowIds, [id])
  }
  assert.equal(engineCapability('code-presentation'), undefined)
  assert.equal(engineCapability('cot-drip'), undefined)
  const legacy = {
    ...store,
    moduleFacts: { ...withModules(['bootstrap-filesystem', 'str-replace-editor', 'custom-bash', 'code-presentation', 'cot-drip']), sourceMode: 'composition', rowIds: ['str-replace-editor', 'promoted-code-mode', 'progress-reminder'] },
  }
  assert.doesNotMatch(render(EngineModuleCards, { store: legacy, t }), /class="configName">(?:str-replace-editor|promoted-code-mode|progress-reminder)</)
  assert.deepEqual(engineRecipe('phase-control-ptc'), {
    id: 'phase-control-ptc', capabilities: ['context-gate', 'tool-bootstrap', 'promoted-code-mode'], initialParams: { usePtcMode: true },
  })
  assert.deepEqual(engineRecipe('deliberation'), {
    id: 'deliberation', capabilities: ['deliberation-gate', 'progress-reminder'], initialParams: { deliberationGate: true, cotDrip: true },
  })
})

test('字段类型、零值与 system 只读由同一渲染器处理', () => {
  const current = { ...store, fields: { ...EMPTY_FIELDS, stagePreUnlock: 0, stages: [{ name: '读取', tools: 'read' }] } }
  const html = render(EngineParamFields, { store: current, card: 'tool-bootstrap', t })
  assert.match(html, /id="pt-param-stagePreUnlock"[^>]*value="0"/)
  assert.match(html, /阶段 1 名称/)
  assert.match(html, /阶段 1 工具集/)
  const readonly = render(EngineParamFields, { store: { ...store, moduleFacts: { ...store.moduleFacts, editable: false } }, card: 'anchor-turn', t })
  assert.match(readonly, /disabled=""/)
  assert.match(readonly, /aria-label="锚定轮文本"/)
})

test('递归深度和专用模型卡保留，过滤字段不重复出现在委派卡', () => {
  const delegation = read('features/subagents/DelegationToolsCard.tsx')
  assert.match(delegation, /ariaLabel=\{t\('param\.maxDepth'\)\}/)
  assert.match(delegation, /fields\.maxDepth/)
  assert.doesNotMatch(delegation, /pt-tool-filter-allow|pt-tool-filter-deny|pt-allow-kinds/)
  assert.equal(ENGINE_PARAM_DEFINITIONS.toolFilterAllow.card, 'tool-filter')
  assert.equal(ENGINE_PARAM_DEFINITIONS.allowKinds.card, 'context-gate')
})

test('自定义工具编辑入口保留，能力删除仍需二次确认', () => {
  const page = read('app/workspace/pages/MainSessionPage.tsx')
  assert.match(page, /t\('main\.addTemplate', \{ layer: translateLabel\(t, LAYER_LABEL_KEYS, layer\) \}\)/)
  assert.match(page, /create:blank-tool/)
  // 自定义工具卡由统一层装配入口渲染；页面只传创建意图，不自己拼卡片。
  assert.match(page, /toolCreate,/)
  assert.match(read('app/workspace/pages/EngineLayersPanel.tsx'), /<CustomToolsCard/)
  assert.match(read('features/tools/CustomToolsCard.tsx'), /<CustomToolCard/)
  assert.match(read('ui/EngineModuleCard.tsx'), /确认删除/)
  const removed = []
  const cards = tree(EngineModuleCards, {
    store: {
      ...store,
      fields: { ...store.fields, writePreset: true },
      moduleFacts: withModules(['context-gate', 'anchor-turn']),
      removeEngineCapability: (id) => removed.push(id),
    },
    t,
  })
  const card = find(cards, (node) => node.props?.name === 'anchor-turn' && node.props.onDelete !== undefined)
  assert.ok(card, 'anchor-turn 必须有自己的卡片')
  assert.deepEqual(removed, [])
  card.props.onDelete()
  assert.deepEqual(removed, ['anchor-turn'], '删除回调只操作本卡对应的能力')
})

test('插入点顺序恒为九层（含三个新层），层序由 meta.layerOrder 下发而非本地清单', () => {
  const order = ['pre-step', 'system-section', 'runtime-context', 'agent-request', 'llm-stream', 'tool-pipeline', 'turn-stop', 'subagent-start', 'subagent-end']
  // 层序唯一来源是引擎 /meta：客户端只消费，不再各写一份清单。
  const engineMeta = getEngineMeta()
  assert.deepEqual(engineMeta.layerOrder, order)
  assert.deepEqual([...ENGINE_LAYER_ORDER], order, '前端退化默认必须与引擎 layerOrder 同源')
  assert.deepEqual(displayLayers(engineMeta.layerOrder, []), order)
  // 旧宿主不下发 layerOrder（或首屏）时退化，不崩也不清空层列表。
  assert.deepEqual(displayLayers(undefined, []), order)
  assert.deepEqual(displayLayers([], []), order)
  // 引擎 /meta 下发的层必须全部落在固定顺序里：只加一端会让下拉/模板菜单露出裸 id。
  for (const layer of engineMeta.layers) assert.ok(order.includes(layer), `引擎层 ${layer} 未进入客户端固定顺序`)
  for (const layer of ['turn-stop', 'subagent-start', 'subagent-end']) assert.ok(engineMeta.layers.includes(layer), `引擎未下发新层 ${layer}`)
  // 固定顺序之外的层仍追加在末尾，不丢未知配置（旧数据可读）。
  assert.deepEqual(displayLayers(engineMeta.layerOrder, ['future-layer']), [...order, 'future-layer'])
  const list = read('features/modules/EngineModuleList.tsx')
  assert.match(list, /EnginePromptDefaultsCard/)
  assert.doesNotMatch(list, /name="提示词生成默认值" layer="pre-step"/)
  const editor = read('features/prompts/PromptConfigsEditor.tsx')
  assert.match(editor, /aria-label=\{t\('configs\.common\.aria'\)\}/)
})

test('编辑组主归属唯一且只引用合法层：能力卡与专用卡共用同一份映射', () => {
  const order = getEngineMeta().layerOrder
  const ids = ENGINE_EDITOR_GROUP_MAP.map((group) => group.id)
  assert.equal(new Set(ids).size, ids.length, '同一编辑组不得有两个主归属（含能力组与专用组冲突）')
  for (const capability of ENGINE_CAPABILITIES) {
    const group = ENGINE_EDITOR_GROUP_MAP.find(({ id }) => id === capability.id)
    assert.ok(group, `能力 ${capability.id} 必须有主归属`)
    assert.equal(group.displayLayer, capability.displayLayer, `${capability.id} 的归属必须与能力定义同源`)
  }
  for (const group of ENGINE_EDITOR_GROUP_MAP) {
    assert.ok(order.includes(group.displayLayer), `${group.id} 主归属层非法：${group.displayLayer}`)
    assert.ok(typeof group.hook === 'string' && group.hook.length > 0, `${group.id} 必须登记真实生效通道`)
    for (const related of group.relatedLayers ?? []) {
      assert.ok(order.includes(related), `${group.id} 相关层非法：${related}`)
      assert.notEqual(related, group.displayLayer, `${group.id} 相关层不能与主归属层相同`)
    }
  }
  // 专用编辑组的 id 必须是真实存在的 card：参数目录里出现过，或前端有同名卡片/展开键。
  const registered = new Set(ENGINE_EDITOR_GROUP_MAP.map(({ id }) => id))
  for (const id of ['prompt-defaults', 'persona', 'variables', 'main-model', 'subagent-model', 'custom-tools']) {
    assert.ok(registered.has(id), `专用编辑组 ${id} 未登记主归属`)
  }
  // subagent-tools（递归深度）走预置顶层 subagent 段，九层归属未定，明确记为缺口而不是硬塞一层。
  const cards = new Set(ENGINE_PARAM_KEYS.map((key) => ENGINE_PARAM_DEFINITIONS[key].card))
  for (const card of cards) {
    if (card === 'subagent-tools') continue
    assert.ok(registered.has(card), `参数 card ${card} 没有主归属`)
  }
  // 相关层只在确有第二通道时登记：人设的 includeRuntimeContext 同时抑制 runtime-context 快照。
  assert.deepEqual(ENGINE_EDITOR_GROUP_MAP.find(({ id }) => id === 'persona').relatedLayers, ['runtime-context'])
})

test('模板菜单覆盖九个插入层：新层分组标题来自字典而不是裸层名', () => {
  const templates = [...INSERTION_LAYERS].map((layer) => ({ file: `${layer}.yml`, spec: { id: `example-${layer}`, layer } }))
  const html = render(TemplatePicker, { t, anchorRef: { current: null }, templates, onPick() {}, onClose() {} })
  for (const layer of INSERTION_LAYERS) {
    assert.ok(html.includes(zh[`templates.layer.${layer}`]), `模板菜单缺 ${layer} 的分组标题文案`)
    assert.ok(html.includes(`${layer}.yml`), `模板菜单缺 ${layer} 的模板条目`)
  }
})

test('模板浮层按层级只列该层模板，不再渲染分组标题', () => {
  const templates = [
    { file: '10-pre-step.yml', spec: { id: 'example-pre-step', layer: 'pre-step' } },
    { file: '20-system-section.yml', spec: { id: 'example-system-section', layer: 'system-section' } },
  ]
  const html = render(TemplatePicker, { t, anchorRef: { current: null }, templates, layer: 'system-section', onPick() {}, onClose() {} })
  assert.match(html, /20-system-section\.yml/)
  assert.doesNotMatch(html, /10-pre-step\.yml/)
  assert.doesNotMatch(html, /templateGroupTitle/)
})

test('统一列表平铺渲染配置与能力卡，层级筛选只过滤不分区', () => {
  const configs = [{ id: 'persona-main', layer: 'system-section', strategy: 'static' }]
  const meta = {
    layers: ['pre-step', 'system-section', 'runtime-context', 'agent-request', 'llm-stream', 'tool-pipeline'],
    strategies: [], slotKinds: [], positions: [], dedupes: [], promotions: [], audienceModes: [], modelScopes: [], roles: [], mergeModes: [], fills: [],
    layerFieldPolicies: {}, layerLabels: {},
  }
  const active = { ...store, moduleFacts: withModules(['anchor-turn']) }
  const props = {
    t,
    meta,
    configs,
    viewFilter: 'all',
    onViewFilterChange() {},
    moduleCards: createElement(EngineModuleCards, { store: active, t, showActions: false, showPromptDefaults: false, showStatus: false }),
    onPatchConfigs() {},
    onSaveConfigs() {},
    onNotice() {},
  }
  const html = render(PromptConfigList, props)
  assert.doesNotMatch(html, /data-insertion-point/)
  assert.ok(html.includes('persona-main'), '层级配置卡与模块卡同列表渲染')
  assert.match(html, /class="configMeta">anchor-turn</)
  // 视觉排序：模块卡（引擎能力）在层级配置卡之前；promptConfigs 的注入顺序仍由 ordered 决定。
  assert.ok(html.indexOf('anchor-turn') < html.indexOf('persona-main'), '模块卡排在层级配置卡之前')
  // 选中插入点层级：只留该层配置与能力卡，仍不生成分类区块。
  const filtered = render(PromptConfigList, {
    ...props,
    viewFilter: 'pre-step',
    moduleCards: createElement(EngineModuleCards, { store: active, t, layerFilter: 'pre-step', showActions: false, showPromptDefaults: false, showStatus: false }),
  })
  assert.doesNotMatch(filtered, /data-insertion-point/)
  assert.doesNotMatch(filtered, /persona-main/)
  assert.match(filtered, /class="configMeta">anchor-turn</)
  // 主会话把筛选值下发给统一层装配入口；编辑组卡在哪层可见由共享契约判定，
  // 页面不再各自手写层名（旧实现按 `viewFilter !== 'tool-pipeline'` 内联硬编码）。
  const page = read('app/workspace/pages/MainSessionPage.tsx')
  assert.match(page, /const layers = engineLayerSlots\(\{/)
  assert.match(page, /viewFilter,/)
  assert.doesNotMatch(page, /isEditorGroupVisible/)
  assert.doesNotMatch(page, /hidden=\{viewFilter !== 'all' && viewFilter !== 'tool-pipeline'\}/, '层可见性不再内联硬编码层名')
  // 世界书只隐藏模块区域，不卸载工具草稿 owner。
  const worldBook = tree(PromptConfigList, { ...props, viewFilter: 'world-book' })
  const owner = find(worldBook, (node) => node.props.children === props.moduleCards)
  assert.equal(owner.props.hidden, true)
  // 模块卡容器与层级配置卡同款列表间距（configList），不是无间距的裸 div。
  assert.match(owner.props.className, /configList/)
})

test('能力卡默认折叠，只有创建/定位到该能力才展开', () => {
  const active = { ...store, moduleFacts: withModules(['context-gate', 'anchor-turn', 'tool-bootstrap']) }
  const collapsed = render(EngineModuleCards, { store: active, t, showPromptDefaults: false })
  assert.equal((collapsed.match(/aria-expanded="true"/g) ?? []).length, 0, '未创建/未定位时全部折叠')
  assert.doesNotMatch(collapsed, /aria-label="锚定轮文本"/, '折叠的卡不渲染参数表单')
  const revealed = render(EngineModuleCards, { store: active, t, showPromptDefaults: false, focusCapability: { id: 'anchor-turn', token: 1 } })
  assert.equal((revealed.match(/aria-expanded="true"/g) ?? []).length, 1, '只展开定位到的那张卡')
  assert.match(revealed, /aria-label="锚定轮文本"/, '定位目标的参数表单可见')
  // 定位锚点与展开信号解耦：锚点始终是能力 id，展开信号只用于变化检测。
  assert.match(revealed, /data-module-card-id="anchor-turn"/, '能力卡带稳定定位锚点')
  // 重复创建同一能力：token 变化 → 重新展开（旧实现在第二次创建时不展开）。
  const again = render(EngineModuleCards, { store: active, t, showPromptDefaults: false, focusCapability: { id: 'anchor-turn', token: 2 } })
  assert.equal((again.match(/aria-expanded="true"/g) ?? []).length, 1, '同一能力重复创建仍展开')
})

test('创建菜单始终列出全部未添加能力，不按当前层过滤', async () => {
  const created = []
  const revealed = []
  const menuTree = tree(EngineCapabilityCreateMenu, { t, store: { ...store, fields: { ...store.fields, writePreset: true },
    createEngineCapability: async (...args) => { created.push(args); return true } }, onCreated: (id) => revealed.push(id) })
  const menu = find(menuTree, (node) => Array.isArray(node.props.items))
  assert.ok(menu, '键盘焦点容器内保留官方创建菜单')
  assert.deepEqual(menu.props.items.filter(({ id }) => id.startsWith('cap:')).map(({ id }) => id.slice(4)), ENGINE_CAPABILITIES.map(({ id }) => id))
  menu.props.onSelect('cap:tool-filter')
  await Promise.resolve()
  assert.deepEqual(created, [['create', 'tool-filter']])
  assert.deepEqual(revealed, ['tool-filter'])
})

test('通用模板可重复创建空卡，独立指令提示入口归为动态填充', () => {
  const source = { file: 'hint.yml', spec: { id: 'hint', layer: 'pre-step', strategy: 'instruction-hint', text: '', identity: { field: 'plugin', value: 'hint' } } }
  let picker
  const picked = []
  function Probe() { picker = useTemplatePicker([{ id: 'hint' }, { id: 'hint-2' }], (config) => picked.push(config), () => {}, t); return null }
  render(Probe)
  picker.pickTemplate(source)
  assert.equal(picked[0].id, 'hint-3')
  assert.equal(picked[0].identity.value, 'hint-3')
  assert.equal(picked[0].text, '')
  assert.equal(picked[0].strategy, 'placeholder')
  assert.equal(picked[0].fill, 'instruction-hint')
  assert.equal(source.spec.strategy, 'instruction-hint', '不修改模板对象')
  const patches = []
  const form = tree(PromptConfigForm, { t, meta: getEngineMeta(), config: source.spec, onPatch: (patch) => patches.push(patch) })
  const strategy = find(form, (node) => node.type === OptionField && node.props.label === t('form.strategy.label'))
  assert.equal(strategy.props.value, 'placeholder')
  assert.equal(strategy.props.options.includes('instruction-hint'), false)
  const fill = find(form, (node) => node.type === OptionField && node.props.label === t('form.fill.label'))
  assert.equal(fill.props.value, 'instruction-hint')
  fill.props.onChange('skill-catalog')
  assert.deepEqual(patches, [{ strategy: 'placeholder', fill: 'skill-catalog' }])
})

test('编辑组层可见性来自共享契约，页面不再各自手写层名', () => {
  // 全部/世界书视图保持既有平铺位置；选中层只留主归属与登记过的相关层。
  assert.equal(isEditorGroupVisible('custom-tools', 'all'), true)
  assert.equal(isEditorGroupVisible('custom-tools', 'world-book'), true)
  assert.equal(isEditorGroupVisible('custom-tools', 'tool-pipeline'), true)
  assert.equal(isEditorGroupVisible('custom-tools', 'pre-step'), false)
  assert.equal(isEditorGroupVisible('prompt-defaults', 'pre-step'), true)
  assert.equal(isEditorGroupVisible('prompt-defaults', 'llm-stream'), false)
  // 人设注册 system-section 段，includeRuntimeContext 同时抑制 runtime-context 快照（真实跨层）。
  assert.equal(isEditorGroupVisible('persona', 'system-section'), true)
  assert.equal(isEditorGroupVisible('persona', 'runtime-context'), true)
  assert.equal(isEditorGroupVisible('persona', 'turn-stop'), false)
  // 子代理模型路由随子代理启动注入 agentOptions，采样三参数写 agent-request patch。
  assert.equal(isEditorGroupVisible('subagent-model', 'subagent-start'), true)
  assert.equal(isEditorGroupVisible('subagent-model', 'agent-request'), true)
  // 能力组与专用编辑组共用一张归属表：能力 id 也能直接查询。
  assert.equal(isEditorGroupVisible('deliberation-gate', 'tool-pipeline'), true)
  assert.equal(isEditorGroupVisible('deliberation-gate', 'pre-step'), false)
  // 未登记的 id 不猜归属：一律可见（新增卡忘登记时是「哪层都能看到」，不是整张消失）。
  assert.equal(isEditorGroupVisible('not-registered-yet', 'turn-stop'), true)
  // 主/子页面消费同一装配入口：页面只声明受众视图，层名判断由 EngineLayersPanel 统一提供。
  const mainPage = read('app/workspace/pages/MainSessionPage.tsx')
  const subagentPage = read('app/workspace/pages/SubagentPage.tsx')
  assert.match(mainPage, /engineLayerSlots\(\{/)
  assert.match(subagentPage, /engineLayerSlots\(\{/)
  assert.doesNotMatch(mainPage, /isEditorGroupVisible/)
  assert.doesNotMatch(subagentPage, /isEditorGroupVisible/)
  const panel = read('app/workspace/pages/EngineLayersPanel.tsx')
  assert.match(panel, /const shows = \(groupId: string\): boolean => isEditorGroupVisible\(groupId, viewFilter\)/)
  assert.match(panel, /shows\('subagent-tools'\)/)
  assert.match(panel, /shows\('variables'\)/)
})

test('共享参数镜像控件：两处渲染读同一 store 字段，DOM id 不重复', () => {
  const store = {
    fields: { ...EMPTY_FIELDS, presetTemplate: 'pt-mirror', writePreset: true, toolFilterAllow: 'read' },
    moduleFacts: { editable: true },
    editorDrafts: undefined,
    patch() {},
    persistParamOverrides() { return Promise.resolve(true) },
  }
  // 层卡内的默认渲染点与工具管线共享设置区的镜像渲染点：值同源，只有 DOM id 不同。
  const primary = render(EngineParamField, { store, param: 'toolFilterAllow', t })
  const mirror = render(EngineParamField, { store, param: 'toolFilterAllow', t, instanceId: 'tool-pipeline' })
  assert.match(primary, /id="pt-param-toolFilterAllow"/)
  assert.match(mirror, /id="pt-param-tool-pipeline-toolFilterAllow"/)
  assert.ok(!primary.includes('pt-param-tool-pipeline-'), '默认渲染点不带实例前缀')
  // 两处读的是同一个 store 字段（TagInput 把列表值渲染成标签，断言值本身出现即可）。
  assert.ok(primary.includes('read') && mirror.includes('read'), '两处读到同一 store 字段值')
  assert.notEqual(primary.match(/id="([^"]+)"/)?.[1], mirror.match(/id="([^"]+)"/)?.[1], 'DOM id 必须不同')
})

/** 共享设置区渲染用 store：展开态由草稿池给出，字段与保存动作与能力卡同源。 */
const pipelineStore = () => ({
  fields: { ...EMPTY_FIELDS, presetTemplate: 'pt-pipeline', writePreset: true },
  moduleFacts: { editable: true },
  editorDrafts: { expanded: new Map([['pt-pipeline:tool-pipeline-settings', true]]), fields: new Map() },
  patch() {},
  persistParamOverrides() { return Promise.resolve(true) },
})

test('工具管线共享设置区覆盖本层每个带参数的能力，不漏键也不另抄键表', () => {
  // 分组集合必须覆盖 tool-pipeline 层所有「确实有扁平参数」的能力 card；
  // subagent-tool-policy 的结构化授权走自己的策略编辑器，不伪造扁平参数。
  const groupCards = new Set(TOOL_PIPELINE_SETTING_GROUPS.map((group) => group.card))
  const cardsWithParams = new Set(ENGINE_PARAM_KEYS.map((key) => ENGINE_PARAM_DEFINITIONS[key].card))
  const missing = ENGINE_CAPABILITIES
    .filter(({ id, displayLayer }) => displayLayer === 'tool-pipeline' && cardsWithParams.has(id) && !groupCards.has(id))
    .map(({ id }) => id)
  assert.deepEqual(missing, [], '本层带参数的能力 card 必须进入共享设置区')
  // 分组内渲染的参数完全来自 shared 定义：既不重复声明键，也不遗漏。
  const html = render(ToolPipelineSettingsCard, { store: pipelineStore(), t })
  for (const group of TOOL_PIPELINE_SETTING_GROUPS) {
    assert.ok(html.includes(`data-pipeline-group="${group.id}"`), `缺少分组 ${group.id}`)
    const keys = ENGINE_PARAM_KEYS.filter((key) => ENGINE_PARAM_DEFINITIONS[key].card === group.card)
    for (const key of keys) {
      // 控件形态随类型不同（Switch 无 id、TagInput 有 id），标签是共同的可断言标识。
      assert.ok(html.includes(zh[`param.${key}`]), `分组 ${group.id} 缺少参数 ${key}`)
    }
  }
  // 镜像控件的 DOM id 必须唯一：两处渲染同一参数时靠 instanceId 前缀区分。
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id)
  assert.equal(new Set(ids).size, ids.length, '共享设置区内 DOM id 不得重复')
  assert.ok(ids.some((id) => id.startsWith('pt-param-tool-pipeline-tool-filter-')), '镜像渲染点带实例前缀')
})

test('工具管线共享设置区登记跨层相关设置，并说明真实主归属层', () => {
  const html = render(ToolPipelineSettingsCard, { store: pipelineStore(), t })
  // 首阶段工具目录主归属 system-section、子代理授权主归属 subagent-start：同源第二处编辑点。
  assert.ok(html.includes('data-pipeline-group="bootstrap-tools"') && html.includes('data-pipeline-group="subagent-delegation"'))
  assert.ok(html.includes(t('layer.system-section')) && html.includes(t('layer.subagent-start')), '跨层组标明真实主归属层')
  assert.ok(html.includes(t('modules.group.bootstrap-tools')) && html.includes(t('modules.group.subagent-delegation')))
  // 相关层必须是真实登记过的归属：与 shared 契约一致，前端不另写层名。
  for (const group of TOOL_PIPELINE_SETTING_GROUPS.filter((item) => item.relatedLayer !== undefined)) {
    assert.equal(isEditorGroupVisible(group.card, group.relatedLayer), true, `${group.card} 未登记相关层 ${group.relatedLayer}`)
  }
})

test('EngineParamFields 把 instanceId 透传给组内每个字段', () => {  const store = {
    fields: { ...EMPTY_FIELDS, presetTemplate: 'pt-pipeline', writePreset: true, toolFilterEnabled: true, toolFilterAllow: 'read' },
    moduleFacts: { editable: true },
    editorDrafts: undefined,
    patch() {},
    persistParamOverrides() { return Promise.resolve(true) },
  }
  const html = render(EngineParamFields, { store, card: 'tool-filter', t, instanceId: 'tool-pipeline' })
  assert.ok(html.includes(zh['param.toolFilterAllow']) && html.includes(zh['param.toolFilterDeny']))
  assert.ok(html.includes('id="pt-param-tool-pipeline-toolFilterAllow"'), '组内字段继承实例前缀')
})

test('共享参数的未完成输入与错误态在镜像控件之间同步，且一次修改只保存一次', () => {
  const listeners = new Set()
  const drafts = { fields: new Map() }
  let revision = 0
  let saves = 0
  const store = {
    fields: { ...EMPTY_FIELDS, presetTemplate: 'pt-mirror', writePreset: true, deliberationMinChars: 10 },
    moduleFacts: { editable: true },
    editorDrafts: drafts,
    patch(partial) { Object.assign(store.fields, partial) },
    persistParamOverrides() { saves += 1; return Promise.resolve(true) },
    getDraftRevision() { return revision },
    subscribeDrafts(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    publishDrafts() { revision += 1; for (const listener of listeners) listener() },
  }
  const control = (instanceId) => find(tree(EngineParamField, { store, param: 'deliberationMinChars', t, instanceId }), (node) => node.type === 'input')
  // SSR 只用 getServerSnapshot，不会调用 subscribe：接线本身由源码契约守卫，
  // 真实重渲染同步由浏览器 smoke 覆盖（两处控件读同一草稿键）。
  assert.match(read('features/modules/EngineParamFields.tsx'), /useSyncExternalStore\(store\.subscribeDrafts \?\? subscribeNothing/,
    '参数控件订阅共享草稿通道')
  // 两处渲染点有独立 DOM id，但读同一字段与同一草稿键。
  assert.equal(control(undefined).props.value, '10')
  assert.equal(control('tool-pipeline-deliberation-gate').props.value, '10')
  // 未完成的数字输入写在共享草稿里：另一处立即读到同一半成品，不是各自一份本地 state。
  control(undefined).props.onChange({ target: { value: '12a' } })
  assert.equal(control(undefined).props.value, '12a')
  assert.equal(control('tool-pipeline-deliberation-gate').props.value, '12a')
  assert.equal(saves, 0, '未完成的输入不落盘')
  // 在镜像渲染点失焦：错误态同为共享草稿，两处一起进入 aria-invalid 并播报同一条错误。
  control('tool-pipeline-deliberation-gate').props.onBlur()
  assert.equal(saves, 0)
  const primary = render(EngineParamField, { store, param: 'deliberationMinChars', t })
  const mirror = render(EngineParamField, { store, param: 'deliberationMinChars', t, instanceId: 'tool-pipeline-deliberation-gate' })
  for (const html of [primary, mirror]) {
    assert.match(html, /aria-invalid="true"/)
    assert.match(html, /role="alert"/)
  }
  assert.equal(drafts.fields.get('pt-mirror:param:deliberationMinChars').text, '12a', '错误草稿保留半成品原文')
  // 改成合法值后失焦：一次语义变更只提交一次保存，两处回落到同一个字段值。
  control(undefined).props.onChange({ target: { value: '20' } })
  assert.equal(saves, 0, '输入过程不保存')
  control('tool-pipeline-deliberation-gate').props.onBlur()
  assert.equal(saves, 1, '一次失焦只提交一次保存')
  assert.equal(store.fields.deliberationMinChars, 20)
  assert.equal(drafts.fields.has('pt-mirror:param:deliberationMinChars'), false, '保存成功后清掉草稿')
  assert.equal(control(undefined).props.value, '20')
  assert.equal(control('tool-pipeline-deliberation-gate').props.value, '20')
})

test('切层与受众切换保留草稿：卡片隐藏而不卸载，草稿键与层无关', () => {
  const hidden = render(LayerCard, { visible: false, children: 'CARD-MARKER' })
  assert.match(hidden, /hidden=""/)
  assert.ok(hidden.includes('CARD-MARKER'), '不可见的卡留在 DOM 里：切层不丢草稿、不重跑读取')
  assert.doesNotMatch(render(LayerCard, { visible: true, children: 'CARD-MARKER' }), /hidden=/)
  // 参数草稿键按「预设 + 参数字段」保存，展开键按「预设 + 卡片身份」保存：都不含层名，
  // 因此切层、筛选与主/子受众切换后读回的是同一份草稿。
  assert.match(read('features/modules/EngineParamFields.tsx'),
    /const draftKey = `\$\{store\.fields\.presetTemplate\}:param:\$\{param\}`/)
  assert.match(read('app/workspace/pages/EngineLayersPanel.tsx'),
    /const expandedKey = `\$\{store\.fields\.presetTemplate\}:tool-pipeline-settings`/)
  // 主/子代理是同源视图：两页只声明受众，配置卡草稿作用域都取当前预设。
  assert.match(read('app/workspace/pages/MainSessionPage.tsx'), /draftScope=\{fields\.presetTemplate\}/)
  assert.match(read('app/workspace/pages/SubagentPage.tsx'), /audience: 'subagent'/)
  // 两页共用同一装配入口：不存在第二份按层保存的草稿或按层过滤的写通道。
  assert.doesNotMatch(read('app/workspace/pages/EngineLayersPanel.tsx'), /localStorage|sessionStorage/)
})

test('统一搜索：配置名、标识、注入层与参数名都能命中，且不改变保存载荷', () => {
  const configs = [
    { id: 'anchor-main', name: '首轮锚定', layer: 'pre-step', strategy: 'first-turn-anchor', order: 10, enabled: true },
    { id: 'sys-guard', name: '系统约束', layer: 'system-section', strategy: 'static', order: 0, enabled: true, params: { maxOutputChars: 2048 } },
  ]
  const listProps = (keyword) => ({
    t, meta: getEngineMeta(), configs, viewFilter: 'all', keyword, onPatchConfigs: () => {}, onSaveConfigs: async () => true, onNotice: () => {},
  })
  const shown = (keyword) => {
    const html = render(PromptConfigList, listProps(keyword))
    return configs.filter((config) => html.includes(`data-config-id="${config.id}"`)).map((config) => config.id)
  }
  // 中文名、标识（技术键）、注入层中文名与参数名各自都能命中，未命中的实例不出现。
  assert.deepEqual(shown('首轮锚定'), ['anchor-main'])
  assert.deepEqual(shown('sys-guard'), ['sys-guard'])
  assert.deepEqual(shown('系统提示段'), ['sys-guard'], '注入层中文名参与匹配')
  assert.deepEqual(shown('maxOutputChars'), ['sys-guard'], '局部参数键参与匹配')
  assert.deepEqual(shown('首轮锚定'), ['anchor-main'])
  assert.deepEqual(shown(''), ['anchor-main', 'sys-guard'], '空搜索词不过滤')
  // 搜索只影响展示：不产生保存、不改写实例数组。
  const before = structuredClone(configs)
  const patches = []
  const nodes = tree(PromptConfigList, {
    t, meta: getEngineMeta(), configs, viewFilter: 'all', keyword: '首轮', onPatchConfigs: (next) => patches.push(next), onSaveConfigs: async () => true, onNotice: () => {},
  })
  assert.ok(nodes)
  assert.deepEqual(patches, [])
  assert.deepEqual(configs, before)
})

test('统一搜索：能力卡与共享设置区按分组名、参数键与参数中文标签过滤', () => {
  // 共享设置区：分组标题命中「深思门」，其余分组隐藏；没有命中时给搜索空状态而不是整卡消失。
  const byLabel = render(ToolPipelineSettingsCard, { store: pipelineStore(), t, keyword: '深思门' })
  assert.ok(byLabel.includes('data-pipeline-group="deliberation-gate"'))
  assert.equal(byLabel.includes('data-pipeline-group="tool-filter"'), false)
  const byKey = render(ToolPipelineSettingsCard, { store: pipelineStore(), t, keyword: 'cotdripevery' })
  assert.ok(byKey.includes('data-pipeline-group="progress-reminder"'), '参数技术键参与匹配')
  assert.equal(byKey.includes('data-pipeline-group="bootstrap-tools"'), false)
  const noHit = render(ToolPipelineSettingsCard, { store: pipelineStore(), t, keyword: '没有这个能力' })
  assert.ok(noHit.includes(t('modules.status.emptySearch', { keyword: '没有这个能力' })))
  assert.ok(noHit.includes(t('modules.toolPipeline.name')), '整卡仍在，只给空状态')
  // 能力卡：能力 id（技术键）与参数中文标签都能命中；未命中的能力卡不渲染。
  const active = { ...store, moduleFacts: withModules(['deliberation-gate', 'progress-reminder', 'tool-filter']) }
  const cards = (keyword) => render(EngineModuleCards, { store: active, t, keyword, showPromptDefaults: false, showStatus: false })
  assert.match(cards('deliberation'), /deliberation-gate/)
  assert.doesNotMatch(cards('deliberation'), /progress-reminder/)
  assert.match(cards(t('param.cotDrip')), /progress-reminder/, '参数中文标签参与匹配')
  assert.doesNotMatch(cards('没有这个能力'), /progress-reminder/)
})

test('统一搜索：无匹配给定位提示，层内无内容给空状态与新增入口', () => {
  const listProps = (viewFilter, keyword = '') => ({
    t, meta: getEngineMeta(), configs: [], viewFilter, keyword, onCreate: () => {}, onPatchConfigs: () => {}, onSaveConfigs: async () => true, onNotice: () => {},
  })
  // 层内没有内容：空状态 + 新增入口（不自动创建空卡，也不说「无匹配」）。
  const layerEmpty = render(PromptConfigList, listProps('llm-stream'))
  assert.ok(layerEmpty.includes(t('configs.empty.layer.title', { layer: t('layer.llm-stream') })))
  assert.ok(layerEmpty.includes(t('configs.createFirst')), '空层保留新增入口')
  assert.equal(layerEmpty.includes(t('configs.noMatch', { keyword: t('layer.llm-stream') })), false)
  // 有搜索词但没命中：仍是「无匹配 + 清除筛选」。
  const noMatch = render(PromptConfigList, listProps('all', '不存在'))
  assert.ok(noMatch.includes(t('configs.noMatch', { keyword: '不存在' })))
  assert.ok(noMatch.includes(t('configs.clearFilters')))
  // 世界书策略视图保持原语义（既有回归）：不因层空态改动而改变。
  const worldBook = render(PromptConfigList, listProps('world-book'))
  assert.ok(worldBook.includes(t('configs.noMatch', { keyword: 'world-book' })))
})

test('层设置内容：参数分组按共享契约派生，能力装配状态与移除入口同区', () => {
  const active = {
    ...store,
    fields: { ...EMPTY_FIELDS, presetTemplate: 'pt-layer', writePreset: true },
    moduleFacts: withModules(['deliberation-gate', 'tool-filter']),
  }
  // 参数分组按主归属层派生，且只列当前确实可编辑的组：能力组要求真实装配。
  assert.deepEqual(layerParamCards(active, 'tool-pipeline'), ['tool-filter', 'deliberation-gate'])
  assert.deepEqual(layerParamCards(active, 'llm-stream'), [])
  // 专用编辑组不依赖模块装配（提示词生成默认值始终可编辑）；能力组随装配出现。
  assert.deepEqual(layerParamCards(active, 'pre-step'), ['prompt-defaults'])
  const withGate = { ...active, moduleFacts: withModules(['context-gate', 'deliberation-gate', 'tool-filter']) }
  assert.deepEqual(layerParamCards(withGate, 'pre-step'), ['context-gate', 'prompt-defaults'])
  assert.deepEqual([...layerParamCards(withGate, 'tool-pipeline')].sort(), ['deliberation-gate', 'tool-filter'])
  assert.equal(layerHasSettings(active, 'tool-pipeline'), true)
  assert.equal(layerHasSettings(active, 'llm-stream'), false)
  // 内容：本层参数组 + 已装配能力条目（只列本层，且装配事实来自 moduleFacts）。
  const html = render(LayerSettingsContent, { store: active, t, layer: 'tool-pipeline' })
  assert.match(html, /data-layer-param-group="deliberation-gate"/)
  assert.match(html, /data-layer-param-group="tool-filter"/)
  assert.equal(html.includes('data-layer-param-group="progress-reminder"'), false, '只渲染本层 card')
  assert.match(html, /data-layer-capabilities="tool-pipeline"/)
  assert.match(html, /data-layer-capability="deliberation-gate"/)
  assert.match(html, /data-layer-capability="tool-filter"/)
  assert.ok(html.includes(t('modules.layer.assembled')))
  // 镜像控件的 DOM id 带层前缀：与能力卡默认渲染点、其他层的镜像都不冲突。
  assert.match(html, /id="pt-param-layer-tool-pipeline-deliberation-gate-deliberationMinChars"/)
  // 只读预设：仍显示装配状态，但不提供移除入口。
  const readOnly = render(LayerSettingsContent, { store: { ...active, fields: { ...EMPTY_FIELDS, presetTemplate: 'pt-layer', writePreset: false } }, t, layer: 'tool-pipeline' })
  assert.ok(readOnly.includes(t('modules.layer.capability', { id: 'tool-filter' })))
  assert.equal(readOnly.includes(t('modules.layer.remove')), false)
  // 该层既没有参数也没有装配能力：不渲染任何内容（层设置区不出现空壳）。
  const empty = render(LayerSettingsContent, {
    store: { ...active, moduleFacts: withModules([]) },
    t,
    layer: 'llm-stream',
  })
  assert.equal(empty, '')
})

test('本层无配置卡时用不写盘的兜底容器承载引擎设置', () => {
  const marker = 'STANDALONE-LAYER-SETTINGS'
  const patches = []
  const saves = []
  const base = (extra) => ({
    t, meta: getEngineMeta(), configs: [], viewFilter: 'tool-pipeline', onCreate: () => {},
    onPatchConfigs: (next) => patches.push(next), onSaveConfigs: async (next) => { saves.push(next); return true }, onNotice: () => {},
    ...extra,
  })
  // 该层有设置且没有任何配置卡：渲染兜底容器，内容来自注入回调，并说明不写入配置列表。
  const withSettings = render(PromptConfigList, base({
    renderLayerSettings: (layer) => `${marker}:${layer}`,
    hasLayerSettings: (layer) => layer === 'tool-pipeline',
  }))
  assert.match(withSettings, /data-layer-settings-standalone="tool-pipeline"/)
  assert.ok(withSettings.includes(`${marker}:tool-pipeline`), '兜底容器渲染该层设置内容')
  assert.ok(withSettings.includes(t('configs.layerSettings.title', { layer: t('layer.tool-pipeline') })))
  assert.ok(withSettings.includes(t('configs.layerSettings.note')), '说明不写入预设配置列表')
  assert.equal(withSettings.includes(t('configs.empty.layer.title', { layer: t('layer.tool-pipeline') })), false, '有设置时不再显示层空态')
  // 只渲染不写入：不产生保存、不创建配置对象、不触发 patch。
  assert.deepEqual(patches, [])
  assert.deepEqual(saves, [])
  // 该层有配置卡：兜底容器让位给实例卡（设置改为嵌在卡内）。
  const withCard = render(PromptConfigList, base({
    configs: [{ id: 'pipe-rule-a', layer: 'tool-pipeline', order: 0, enabled: true, strategy: 'static' }],
    renderLayerSettings: (layer) => `${marker}:${layer}`,
    hasLayerSettings: () => true,
  }))
  assert.equal(withCard.includes('data-layer-settings-standalone'), false)
  assert.ok(withCard.includes('pipe-rule-a'))
  // 该层没有可编辑设置：保持既有层空态与新增入口。
  const noSettings = render(PromptConfigList, base({ renderLayerSettings: () => marker, hasLayerSettings: () => false }))
  assert.equal(noSettings.includes('data-layer-settings-standalone'), false)
  assert.ok(noSettings.includes(t('configs.empty.layer.title', { layer: t('layer.tool-pipeline') })))
  // 注入回调存在但该层无设置判定为假时，回调不被调用（不产生无谓渲染）。
  let called = 0
  render(PromptConfigList, base({ renderLayerSettings: () => { called += 1; return marker }, hasLayerSettings: () => false }))
  assert.equal(called, 0)
})
