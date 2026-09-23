import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { createElement, isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { parse } from 'yaml'
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
const { LayerSettingsContent, layerParamCards, layerHasSettings, layerAssembledCapabilities, engineLayerSlots } = await import('../../src/client/app/workspace/pages/EngineLayersPanel.tsx')
const { LayerCard } = await import('../../src/client/ui/LayerCard.tsx')
const { EngineModuleCards, EngineCapabilityCreateMenu } = await import('../../src/client/features/modules/EngineModuleList.tsx')
const { PromptConfigForm } = await import('../../src/client/features/prompts/PromptConfigForm.tsx')
const { OptionField } = await import('../../src/client/features/prompts/PromptConfigFields.tsx')
const { PromptConfigList } = await import('../../src/client/features/prompts/PromptConfigList.tsx')
const { PromptConfigCard } = await import('../../src/client/features/prompts/PromptConfigCard.tsx')
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
    assert.ok(html.includes(`aria-label="${label}"`), `${key} 必须有可访问输入控件`)
  }
})

test('层设置内容按装配事实列出本层能力，未装配的能力不出现', () => {
  const active = {
    ...store,
    fields: { ...EMPTY_FIELDS, presetTemplate: 'pt-cards', writePreset: true },
    moduleFacts: withModules(['filesystem-editor', 'tool-config-engine', 'tool-git-bash']),
  }
  // 装配事实按主归属层分组：str-replace-editor 由 filesystem-editor 行提供，仍归 tool-pipeline。
  assert.deepEqual(layerAssembledCapabilities(active, 'system-section'), [])
  assert.deepEqual([...layerAssembledCapabilities(active, 'tool-pipeline')].sort(), ['str-replace-editor', 'tool-config-engine', 'tool-git-bash'])
  assert.deepEqual(layerAssembledCapabilities(active, 'pre-step'), [])
  const html = render(LayerSettingsContent, { store: active, t, layer: 'tool-pipeline' })
  for (const id of ['tool-config-engine', 'tool-git-bash', 'str-replace-editor']) {
    assert.match(html, new RegExp(`data-layer-capability="${id}"`), `${id} 应出现在本层装配清单`)
  }
  assert.doesNotMatch(html, /data-layer-capability="tool-bootstrap"/, '不列其他层的能力')
  assert.doesNotMatch(html, /aria-label="编辑行为"/, '不恢复旧能力编辑目标选择器')
  // 历史隐式策略仍在运行：照样列出，便于管理授权。
  const legacyPolicy = { ...active, moduleFacts: { ...withModules(['delegation']), effectiveModules: ['delegation', 'subagent-tool-policy'] } }
  assert.deepEqual(layerAssembledCapabilities(legacyPolicy, 'tool-pipeline'), ['subagent-tool-policy'])
  // 官方组合行不伪装成本插件能力。
  const official = { ...active, moduleFacts: { ...active.moduleFacts, sourceMode: 'official' } }
  assert.deepEqual(layerAssembledCapabilities(official, 'tool-pipeline'), [])
})

test('能力与组合只引用新模块名，不接受旧模块名或编辑器模块别名', () => {
  const editor = engineCapability('str-replace-editor')
  assert.deepEqual(editor.moduleKeys, ['filesystem-editor'])
  assert.deepEqual(editor.rowIds, ['str-replace-editor'])
  for (const id of ['tool-config-engine', 'tool-git-bash']) {
    assert.deepEqual(engineCapability(id).moduleKeys, [id])
    assert.deepEqual(engineCapability(id).rowIds, [id])
  }
  assert.equal(engineCapability('code-presentation'), undefined)
  assert.equal(engineCapability('cot-drip'), undefined)
  assert.equal(engineCapability('bootstrap-filesystem'), undefined, '旧模块名不再被能力目录识别')
  const legacy = {
    ...store,
    moduleFacts: { ...withModules(['bootstrap-filesystem', 'str-replace-editor', 'custom-bash', 'code-presentation', 'cot-drip']), sourceMode: 'composition', rowIds: ['str-replace-editor', 'promoted-code-mode', 'progress-reminder'] },
  }
  assert.deepEqual(layerAssembledCapabilities(legacy, 'tool-pipeline'), [], '组合来源的旧模块名不生成能力条目')
  assert.deepEqual(layerParamCards(legacy, 'tool-pipeline'), [], '旧别名不产生可编辑参数组')
  // 旧别名既不生成能力条目，也不产生可编辑参数组。
  for (const id of ['phase-control', 'phase-control-ptc', 'deliberation']) assert.equal(engineRecipe(id), undefined)
})

test('字段类型、零值与 system 只读由同一渲染器处理', () => {
  const current = { ...store, fields: { ...EMPTY_FIELDS, modelTemperature: 0, customToolRequireApproval: 'shell' } }
  assert.match(render(EngineParamFields, { store: current, card: 'main-model', t }), /id="pt-param-modelTemperature"[^>]*value="0"/)
  assert.match(render(EngineParamFields, { store: current, card: 'tool-config-engine', t }), /shell/)
  const readonly = render(EngineParamFields, { store: { ...store, moduleFacts: { ...store.moduleFacts, editable: false } }, card: 'prompt-defaults', t })
  assert.match(readonly, /disabled=""/)
  assert.match(readonly, /readonly=""/)
  assert.ok(readonly.includes(`aria-label="${zh['param.firstTurnText']}"`))
})

test('现存参数按目录顺序渲染，不生成已撤销能力的成对开关', () => {
  for (const card of ['prompt-defaults', 'str-replace-editor', 'tool-config-engine', 'tool-git-bash']) {
    const html = render(EngineParamFields, { store, card, t })
    const keys = [...html.matchAll(/data-param-key="([^"]+)"/g)].map((match) => match[1])
    const expected = ENGINE_PARAM_KEYS.filter((key) => ENGINE_PARAM_DEFINITIONS[key].card === card)
    assert.deepEqual(keys, expected, '完整字段集合和顺序保持')
    assert.doesNotMatch(html, /data-param-pair=/)
  }
})

test('数字参数在两个设置实例中保留独立DOM身份与同一草稿值', () => {
  const active = { ...store, fields: { ...EMPTY_FIELDS, writePreset: true, strReplaceEditorMaxOutputChars: 4096 } }
  const html = ['rule-a', 'rule-b'].map((instanceId) => render(EngineParamFields, { store: active, card: 'str-replace-editor', t, instanceId })).join('')
  const ids = [...html.matchAll(/id="([^"]+-strReplaceEditorMaxOutputChars)"/g)].map((match) => match[1])
  assert.deepEqual(ids, ['pt-param-rule-a-strReplaceEditorMaxOutputChars', 'pt-param-rule-b-strReplaceEditorMaxOutputChars'])
  assert.equal(new Set(ids).size, 2)
  assert.equal((html.match(/value="4096"/g) ?? []).length, 2)
})

test('递归深度和专用模型卡保留，过滤字段不重复出现在委派卡', () => {
  const delegation = read('features/subagents/DelegationToolsCard.tsx')
  assert.match(delegation, /ariaLabel=\{t\('param\.maxDepth'\)\}/)
  assert.match(delegation, /fields\.maxDepth/)
  assert.doesNotMatch(delegation, /pt-tool-filter-allow|pt-tool-filter-deny|pt-allow-kinds/)
  assert.equal(ENGINE_PARAM_DEFINITIONS.customToolRequireApproval.card, 'tool-config-engine')
  assert.equal(ENGINE_PARAM_DEFINITIONS.maxDepth.card, 'subagent-tools')
})

test('自定义工具编辑入口保留，能力删除仍需二次确认', () => {
  const page = read('app/workspace/pages/MainSessionPage.tsx')
  assert.match(page, /t\('main\.addTemplate', \{ layer: translateLabel\(t, LAYER_LABEL_KEYS, layer\) \}\)/)
  assert.match(page, /templatesOnly/)
  // 顶部只创建模板；工具创建由层内编辑器提供，页面仍持有草稿。
  assert.match(page, /toolEditor: toolEditor\.content/)
  assert.match(read('app/workspace/pages/EngineLayersPanel.tsx'), /<CustomToolsCard/)
  assert.match(read('features/tools/CustomToolsCard.tsx'), /<CustomToolCard/)
  assert.match(read('ui/EngineModuleCard.tsx'), /确认删除/)
  const removed = []
  const cards = tree(EngineModuleCards, {
    store: {
      ...store,
      fields: { ...store.fields, writePreset: true },
      moduleFacts: withModules(['filesystem-editor', 'tool-config-engine']),
      removeEngineCapability: (id) => removed.push(id),
    },
    t,
  })
  const card = find(cards, (node) => node.props?.name === 'str-replace-editor' && node.props.onDelete !== undefined)
  assert.ok(card, 'str-replace-editor 必须有自己的卡片')
  assert.deepEqual(removed, [])
  card.props.onDelete()
  assert.deepEqual(removed, ['str-replace-editor'], '删除回调只操作本卡对应的能力')
})

test('插入点顺序恒为九层（含三个新层），层序由 meta.layerOrder 下发而非本地清单', () => {
  const order = ['pre-step', 'system-section', 'runtime-context', 'agent-request', 'llm-stream', 'tool-pipeline', 'turn-stop', 'subagent-start', 'subagent-end']
  // 层序唯一来源是引擎 /meta：客户端只消费，不再各写一份清单。
  const engineMeta = getEngineMeta()
  assert.deepEqual(engineMeta.layerOrder, order)
  assert.deepEqual([...ENGINE_LAYER_ORDER], order, '前端退化默认必须与引擎 layerOrder 同源')
  assert.deepEqual(displayLayers(engineMeta.layerOrder, []), order)
  assert.deepEqual(displayLayers([], []), [], '消费实际层序，不补旧宿主缺省值')
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
    ...getEngineMeta(),
    layers: ['pre-step', 'system-section', 'runtime-context', 'agent-request', 'llm-stream', 'tool-pipeline'],
    strategies: [], slotKinds: [], positions: [], dedupes: [], promotions: [], audienceModes: [], modelScopes: [], roles: [], mergeModes: [], fills: [],
    layerFieldPolicies: {}, layerLabels: {},
  }
  const active = { ...store, moduleFacts: withModules(['filesystem-editor']) }
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
  assert.match(html, /class="configName">str-replace-editor</)
  assert.match(html, /class="configMeta">filesystem-editor</)
  // 视觉排序：模块卡（引擎能力）在层级配置卡之前；promptConfigs 的注入顺序仍由 ordered 决定。
  assert.ok(html.indexOf('str-replace-editor') < html.indexOf('persona-main'), '模块卡排在层级配置卡之前')
  // 选中插入点层级：只留该层配置与能力卡，仍不生成分类区块。
  const filtered = render(PromptConfigList, {
    ...props,
    viewFilter: 'tool-pipeline',
    moduleCards: createElement(EngineModuleCards, { store: active, t, layerFilter: 'tool-pipeline', showActions: false, showPromptDefaults: false, showStatus: false }),
  })
  assert.doesNotMatch(filtered, /data-insertion-point/)
  assert.doesNotMatch(filtered, /persona-main/)
  assert.match(filtered, /class="configName">str-replace-editor</)
  assert.match(filtered, /class="configMeta">filesystem-editor</)
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
  const active = { ...store, moduleFacts: withModules(['filesystem-editor', 'tool-config-engine', 'tool-git-bash']) }
  const collapsed = render(EngineModuleCards, { store: active, t, showPromptDefaults: false })
  assert.equal((collapsed.match(/aria-expanded="true"/g) ?? []).length, 0, '未创建/未定位时全部折叠')
  assert.equal(collapsed.includes(`aria-label="${zh['param.strReplaceEditorMaxOutputChars']}"`), false, '折叠的卡不渲染参数表单')
  const revealed = render(EngineModuleCards, { store: active, t, showPromptDefaults: false, focusCapability: { id: 'str-replace-editor', token: 1 } })
  assert.equal((revealed.match(/aria-expanded="true"/g) ?? []).length, 1, '只展开定位到的那张卡')
  assert.ok(revealed.includes(`aria-label="${zh['param.strReplaceEditorMaxOutputChars']}"`), '定位目标的参数表单可见')
  // 定位锚点与展开信号解耦：锚点始终是能力 id，展开信号只用于变化检测。
  assert.match(revealed, /data-module-card-id="str-replace-editor"/, '能力卡带稳定定位锚点')
  // 重复创建同一能力：token 变化 → 重新展开（旧实现在第二次创建时不展开）。
  const again = render(EngineModuleCards, { store: active, t, showPromptDefaults: false, focusCapability: { id: 'str-replace-editor', token: 2 } })
  assert.equal((again.match(/aria-expanded="true"/g) ?? []).length, 1, '同一能力重复创建仍展开')
})

test('层内创建菜单按能力主层过滤，撤销组合不再出现', async () => {
  const created = []
  const revealed = []
  const active = { ...store, fields: { ...store.fields, writePreset: true }, createEngineCapability: async (...args) => { created.push(args); return true } }
  const menuFor = (layer) => find(tree(EngineCapabilityCreateMenu, { t, store: active, layer, onCreated: (id) => revealed.push(id) }), (node) => Array.isArray(node.props.items))
  const menu = menuFor(undefined)
  assert.ok(menu, '键盘焦点容器内保留官方创建菜单')
  assert.deepEqual(menu.props.items.filter(({ id }) => id.startsWith('cap:')).map(({ id }) => id.slice(4)), ENGINE_CAPABILITIES.map(({ id }) => id))
  const pipeline = menuFor('tool-pipeline')
  const ids = pipeline.props.items.map(({ id }) => id)
  assert.deepEqual(ids, ENGINE_CAPABILITIES.map(({ id }) => `cap:${id}`))
  assert.equal(ids.some((id) => id.startsWith('recipe:')), false)
  assert.equal(menuFor('pre-step'), undefined)
  pipeline.props.onSelect('cap:context-gate')
  await Promise.resolve()
  assert.deepEqual(created, [], '不接受不属于当前层菜单的选择')
  pipeline.props.onSelect('cap:str-replace-editor')
  await Promise.resolve()
  assert.deepEqual(created, [['create', 'str-replace-editor']])
  assert.deepEqual(revealed, ['str-replace-editor'])
})

test('通用模板可重复创建空卡，独立指令提示入口归为动态填充', () => {
  const source = { file: 'hint.yml', spec: { id: 'hint', layer: 'pre-step', strategy: 'placeholder', fill: 'instruction-hint', text: '', identity: { field: 'plugin', value: 'hint' } } }
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
  assert.equal(source.spec.strategy, 'placeholder', '不修改模板对象')
  const patches = []
  const form = tree(PromptConfigForm, { t, meta: getEngineMeta(), config: source.spec, onPatch: (patch) => patches.push(patch) })
  const strategy = find(form, (node) => node.type === OptionField && node.props.label === t('form.strategy.label'))
  assert.equal(strategy.props.value, 'placeholder')
  assert.equal(strategy.props.options.includes('instruction-hint'), false)
  const fill = find(form, (node) => node.type === OptionField && node.props.label === t('form.fill.label'))
  assert.equal(fill.props.value, 'instruction-hint')
  fill.props.onChange('skill-catalog')
  assert.deepEqual(patches, [{ fill: 'skill-catalog' }])
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
  assert.equal(isEditorGroupVisible('str-replace-editor', 'tool-pipeline'), true)
  assert.equal(isEditorGroupVisible('str-replace-editor', 'pre-step'), false)
  // 未登记的 id 不猜归属：一律可见（新增卡忘登记时是「哪层都能看到」，不是整张消失）。
  assert.equal(isEditorGroupVisible('not-registered-yet', 'turn-stop'), true)
  // 主/子页面消费同一装配入口：页面只声明受众视图，层名判断由 EngineLayersPanel 统一提供。
  const mainPage = read('app/workspace/pages/MainSessionPage.tsx')
  const subagentPage = read('app/workspace/pages/SubagentPage.tsx')
  assert.match(mainPage, /engineLayerSlots\(\{/)
  assert.match(subagentPage, /engineLayerSlots\(\{/)
  assert.doesNotMatch(mainPage, /isEditorGroupVisible/)
  assert.doesNotMatch(subagentPage, /isEditorGroupVisible/)
  // 层设置内容与资产都按主归属层派生，不再用展示开关逐个包卡片。
  const panel = read('app/workspace/pages/EngineLayersPanel.tsx')
  assert.match(panel, /export \{ isEditorGroupVisible \}/, '层可见性判定仍从共享契约转出')
  assert.match(panel, /group\.displayLayer === layer/)
  assert.match(panel, /id === 'persona' && <PresetPersonaCard/)
  assert.match(panel, /id === 'subagent-tool-policy'/)
})

test('共享参数镜像控件：两处渲染读同一 store 字段，DOM id 不重复', () => {
  const store = {
    fields: { ...EMPTY_FIELDS, presetTemplate: 'pt-mirror', writePreset: true, customToolRequireApproval: 'shell' },
    moduleFacts: { editable: true },
    editorDrafts: undefined,
    patch() {},
    persistParamOverrides() { return Promise.resolve(true) },
  }
  // 层卡内的默认渲染点与工具管线共享设置区的镜像渲染点：值同源，只有 DOM id 不同。
  const primary = render(EngineParamField, { store, param: 'customToolRequireApproval', t })
  const mirror = render(EngineParamField, { store, param: 'customToolRequireApproval', t, instanceId: 'tool-pipeline' })
  assert.match(primary, /id="pt-param-customToolRequireApproval"/)
  assert.match(mirror, /id="pt-param-tool-pipeline-customToolRequireApproval"/)
  assert.ok(!primary.includes('pt-param-tool-pipeline-'), '默认渲染点不带实例前缀')
  // 两处读的是同一个 store 字段（TagInput 把列表值渲染成标签，断言值本身出现即可）。
  assert.ok(primary.includes('shell') && mirror.includes('shell'), '两处读到同一 store 字段值')
  assert.notEqual(primary.match(/id="([^"]+)"/)?.[1], mirror.match(/id="([^"]+)"/)?.[1], 'DOM id 必须不同')
})

test('工具链层参数分组覆盖本层每个带参数的能力，不漏键也不另抄键表', () => {
  // 分组集合必须覆盖 tool-pipeline 层所有「确实有扁平参数」的能力 card；
  // subagent-tool-policy 的结构化授权走自己的策略编辑器，不伪造扁平参数。
  const pipelineCapabilities = ENGINE_CAPABILITIES.filter(({ displayLayer }) => displayLayer === 'tool-pipeline')
  const moduleKeys = [...new Set(pipelineCapabilities.flatMap((capability) => capability.moduleKeys))]
  const active = {
    ...store,
    fields: { ...EMPTY_FIELDS, presetTemplate: 'pt-pipeline', writePreset: true },
    moduleFacts: { sourceMode: 'explicit', editable: true, rowIds: [], declaredModules: moduleKeys, effectiveModules: moduleKeys },
  }
  const cardsWithParams = new Set(ENGINE_PARAM_KEYS.map((key) => ENGINE_PARAM_DEFINITIONS[key].card))
  const groups = layerParamCards(active, 'tool-pipeline')
  const missing = pipelineCapabilities
    .filter(({ id }) => cardsWithParams.has(id) && !groups.includes(id))
    .map(({ id }) => id)
  assert.deepEqual(missing, [], '本层带参数的能力 card 必须进入层设置区')
  // 分组内渲染的参数完全来自 shared 定义：既不重复声明键，也不遗漏。
  const html = render(LayerSettingsContent, { store: active, t, layer: 'tool-pipeline' })
  for (const id of groups) {
    assert.ok(html.includes(`data-layer-param-group="${id}"`), `缺少分组 ${id}`)
    for (const key of ENGINE_PARAM_KEYS.filter((item) => ENGINE_PARAM_DEFINITIONS[item].card === id)) {
      // 控件形态随类型不同（Switch 无 id、TagInput 有 id），标签是共同的可断言标识。
      assert.ok(html.includes(zh[`param.${key}`]), `分组 ${id} 缺少参数 ${key}`)
    }
  }
  // 同层多处渲染同一参数时靠 instanceId 前缀区分，DOM id 不得重复。
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id)
  assert.equal(new Set(ids).size, ids.length, '层设置区内 DOM id 不得重复')
  assert.ok(ids.some((id) => id.startsWith('pt-param-layer-tool-pipeline-standalone-')), '设置区渲染点带层与卡身份前缀')
})

test('EngineParamFields 把 instanceId 透传给组内每个字段', () => {  const store = {
    fields: { ...EMPTY_FIELDS, presetTemplate: 'pt-pipeline', writePreset: true, customToolRequireApproval: 'shell' },
    moduleFacts: { editable: true },
    editorDrafts: undefined,
    patch() {},
    persistParamOverrides() { return Promise.resolve(true) },
  }
  const html = render(EngineParamFields, { store, card: 'tool-config-engine', t, instanceId: 'tool-pipeline' })
  assert.ok(html.includes(zh['param.customToolRequireApproval']))
  assert.ok(html.includes('id="pt-param-tool-pipeline-customToolRequireApproval"'), '组内字段继承实例前缀')
})

test('共享参数的未完成输入与错误态在镜像控件之间同步，且一次修改只保存一次', () => {
  const listeners = new Set()
  const drafts = { fields: new Map() }
  let revision = 0
  let saves = 0
  const store = {
    fields: { ...EMPTY_FIELDS, presetTemplate: 'pt-mirror', writePreset: true, strReplaceEditorMaxOutputChars: 10 },
    moduleFacts: { editable: true },
    editorDrafts: drafts,
    patch(partial) { Object.assign(store.fields, partial) },
    persistParamOverrides() { saves += 1; return Promise.resolve(true) },
    getDraftRevision() { return revision },
    subscribeDrafts(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    publishDrafts() { revision += 1; for (const listener of listeners) listener() },
  }
  const control = (instanceId) => find(tree(EngineParamField, { store, param: 'strReplaceEditorMaxOutputChars', t, instanceId }), (node) => node.type === 'input')
  // SSR 只用 getServerSnapshot，不会调用 subscribe：接线本身由源码契约守卫，
  // 真实重渲染同步由浏览器 smoke 覆盖（两处控件读同一草稿键）。
  assert.match(read('features/modules/EngineParamFields.tsx'), /useSyncExternalStore\(store\.subscribeDrafts \?\? subscribeNothing/,
    '参数控件订阅共享草稿通道')
  // 两处渲染点有独立 DOM id，但读同一字段与同一草稿键。
  assert.equal(control(undefined).props.value, '10')
  assert.equal(control('tool-pipeline-str-replace-editor').props.value, '10')
  // 未完成的数字输入写在共享草稿里：另一处立即读到同一半成品，不是各自一份本地 state。
  control(undefined).props.onChange({ target: { value: '12a' } })
  assert.equal(control(undefined).props.value, '12a')
  assert.equal(control('tool-pipeline-str-replace-editor').props.value, '12a')
  assert.equal(saves, 0, '未完成的输入不落盘')
  // 在镜像渲染点失焦：错误态同为共享草稿，两处一起进入 aria-invalid 并播报同一条错误。
  control('tool-pipeline-str-replace-editor').props.onBlur()
  assert.equal(saves, 0)
  const primary = render(EngineParamField, { store, param: 'strReplaceEditorMaxOutputChars', t })
  const mirror = render(EngineParamField, { store, param: 'strReplaceEditorMaxOutputChars', t, instanceId: 'tool-pipeline-str-replace-editor' })
  for (const html of [primary, mirror]) {
    assert.match(html, /aria-invalid="true"/)
    assert.match(html, /role="alert"/)
  }
  assert.equal(drafts.fields.get('pt-mirror:param:strReplaceEditorMaxOutputChars').text, '12a', '错误草稿保留半成品原文')
  // 改成合法值后失焦：一次语义变更只提交一次保存，两处回落到同一个字段值。
  control(undefined).props.onChange({ target: { value: '20' } })
  assert.equal(saves, 0, '输入过程不保存')
  control('tool-pipeline-str-replace-editor').props.onBlur()
  assert.equal(saves, 1, '一次失焦只提交一次保存')
  assert.equal(store.fields.strReplaceEditorMaxOutputChars, 20)
  assert.equal(drafts.fields.has('pt-mirror:param:strReplaceEditorMaxOutputChars'), false, '保存成功后清掉草稿')
  assert.equal(control(undefined).props.value, '20')
  assert.equal(control('tool-pipeline-str-replace-editor').props.value, '20')
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

test('统一搜索：生产层装配按中文名、技术键与能力名保留真实实例，不生成空层设置卡', () => {
  const active = { ...store, fields: { ...EMPTY_FIELDS, writePreset: true }, moduleFacts: withModules(['filesystem-editor', 'tool-config-engine']) }
  const config = { id: 'pipe-a', layer: 'tool-pipeline', strategy: 'static' }
  for (const keyword of [zh['param.strReplaceEditorMaxOutputChars'], 'strreplaceeditormaxoutputchars', 'str-replace-editor']) {
    const slots = engineLayerSlots({ store: active, t, viewFilter: 'all', audience: 'main', keyword })
    assert.equal(slots.matchesLayerSettings('tool-pipeline', keyword), true)
    assert.equal(slots.matchesLayerSettings('llm-stream', keyword), false)
    const base = { ...slots, t, meta: getEngineMeta(), viewFilter: 'all', keyword, onPatchConfigs() { assert.fail('搜索不得写盘') }, onSaveConfigs() { assert.fail('搜索不得保存') }, onNotice() {} }
    assert.match(render(PromptConfigList, { ...base, configs: [config] }), /data-config-id="pipe-a"/)
    assert.doesNotMatch(render(PromptConfigList, { ...base, configs: [] }), /data-layer-config=|data-config-id=|data-layer-settings-standalone=/)
    const settings = tree(LayerSettingsContent, { store: active, t, layer: 'tool-pipeline', keyword })
    assert.equal(find(settings, (node) => node.props['data-layer-param-group'] === 'str-replace-editor').props.hidden, false)
    assert.equal(find(settings, (node) => node.props['data-layer-param-group'] === 'tool-config-engine').props.hidden, true)
  }
})

test('统一搜索：中文资产名与技术键命中同一归属层', () => {
  const active = { ...store, templateVariables: { test: 'value' } }
  const slots = engineLayerSlots({ store: active, t, viewFilter: 'all', audience: 'main' })
  for (const [label, id, layer] of [['模板变量', 'variables', 'runtime-context'], ['自定义工具', 'custom-tools', 'tool-pipeline'], ['人设', 'persona', 'system-section'], ['子代理工具策略', 'subagent-tool-policy', 'tool-pipeline']]) {
    assert.equal(slots.matchesLayerSettings(layer, label), true, label)
    assert.equal(slots.matchesLayerSettings(layer, id), true, id)
  }
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
    moduleFacts: withModules(['filesystem-editor', 'tool-config-engine']),
  }
  // 参数分组按主归属层派生，且只列当前确实可编辑的组：能力组要求真实装配。
  assert.deepEqual(layerParamCards(active, 'tool-pipeline'), ['str-replace-editor', 'tool-config-engine'])
  assert.deepEqual(layerParamCards(active, 'llm-stream'), [])
  // 专用编辑组不依赖模块装配（提示词生成默认值始终可编辑）；能力组随装配出现。
  assert.deepEqual(layerParamCards(active, 'pre-step'), ['prompt-defaults'])
  // 已有专属编辑器的组不再进通用参数分组（模型路由卡是唯一入口）。
  const withModel = { ...active, moduleFacts: withModules([]) }
  assert.deepEqual(layerParamCards(withModel, 'agent-request'), [], '主模型参数由模型路由卡承载')
  assert.deepEqual(layerParamCards(withModel, 'subagent-start'), [], '子代理模型同理只留模型路由卡')
  const withBash = { ...active, moduleFacts: withModules(['filesystem-editor', 'tool-config-engine', 'tool-git-bash']) }
  assert.deepEqual(layerParamCards(withBash, 'pre-step'), ['prompt-defaults'])
  assert.deepEqual(layerParamCards(withBash, 'tool-pipeline'), ['str-replace-editor', 'tool-config-engine', 'tool-git-bash'])
  assert.equal(layerHasSettings(active, 'tool-pipeline'), true)
  assert.equal(layerHasSettings(active, 'llm-stream'), false)
  // 内容：本层参数组 + 已装配能力条目（只列本层，且装配事实来自 moduleFacts）。
  const html = render(LayerSettingsContent, { store: active, t, layer: 'tool-pipeline' })
  assert.match(html, /data-layer-param-group="str-replace-editor"/)
  assert.match(html, /data-layer-param-group="tool-config-engine"/)
  assert.equal(html.includes('data-layer-param-group="tool-git-bash"'), false, '未装配能力不渲染参数组')
  assert.equal(html.includes('data-layer-insert-template'), false, '层设置区不提供重复的注入模板入口')
  // 代理请求层：模型路由卡仍是该层唯一模型入口，通用参数分组退场但设置区不空。
  // 资产计入 hasLayerSettings 的是 engineLayerSlots 的装配结果（导出的 layerHasSettings 只看参数与能力）。
  const modelSlots = engineLayerSlots({ store: withModel, t, viewFilter: 'all', audience: 'main' })
  assert.equal(modelSlots.hasLayerSettings('agent-request'), true, '模型路由资产让该层仍有设置')
  assert.deepEqual(layerParamCards(withModel, 'agent-request'), [], '该层不再有重复的通用分组')
  assert.match(html, /data-layer-capabilities="tool-pipeline"/)
  assert.match(html, /data-layer-capability="str-replace-editor"/)
  assert.match(html, /data-layer-capability="tool-config-engine"/)
  assert.ok(html.includes(t('modules.layer.assembled')))
  // 镜像控件的 DOM id 带「层 + 卡身份」前缀：同层多张卡、能力卡默认渲染点都不冲突。
  assert.match(html, /id="pt-param-layer-tool-pipeline-standalone-str-replace-editor-strReplaceEditorMaxOutputChars"/)
  // 只读预设：仍显示装配状态，但不提供移除入口。
  const readOnly = render(LayerSettingsContent, { store: { ...active, fields: { ...EMPTY_FIELDS, presetTemplate: 'pt-layer', writePreset: false } }, t, layer: 'tool-pipeline' })
  assert.ok(readOnly.includes(t('modules.layer.capability', { id: 'tool-config-engine' })))
  assert.equal(readOnly.includes(t('modules.layer.remove')), false)
  // 该层既没有参数也没有装配能力：不渲染任何内容（层设置区不出现空壳）。
  const empty = render(LayerSettingsContent, {
    store: { ...active, moduleFacts: withModules([]) },
    t,
    layer: 'llm-stream',
  })
  assert.equal(empty, '')
  // 同层两张实例卡各渲染一份：带卡身份的 DOM id 互不重复（同源同步靠同一 store 字段）。
  const cardA = render(LayerSettingsContent, { store: active, t, layer: 'tool-pipeline', configId: 'rule-a' })
  const cardB = render(LayerSettingsContent, { store: active, t, layer: 'tool-pipeline', configId: 'rule-b' })
  const idOf = (html) => html.match(/id="(pt-param-layer-tool-pipeline-[^"]*strReplaceEditorMaxOutputChars)"/)?.[1]
  assert.equal(idOf(cardA), 'pt-param-layer-tool-pipeline-rule-a-str-replace-editor-strReplaceEditorMaxOutputChars')
  assert.equal(idOf(cardB), 'pt-param-layer-tool-pipeline-rule-b-str-replace-editor-strReplaceEditorMaxOutputChars')
  assert.notEqual(idOf(cardA), idOf(cardB), '同层多卡的镜像控件 DOM id 必须不同')
})

test('所有参数设置只内嵌真实配置卡，空层即使有设置也不自动创建卡片', () => {
  const marker = 'LAYER-SETTINGS'
  const layers = ['agent-request', 'tool-pipeline', 'subagent-start']
  const patches = []
  const saves = []
  const base = (extra) => ({
    t, meta: getEngineMeta(), configs: [], viewFilter: 'all', onCreate: () => {},
    renderLayerSettings: (layer) => `${marker}:${layer}`,
    hasLayerSettings: (layer) => layers.includes(layer),
    matchesLayerSettings: (layer, keyword) => layer === 'tool-pipeline' && keyword === '深思门',
    onPatchConfigs: (next) => patches.push(next), onSaveConfigs: async (next) => { saves.push(next); return true }, onNotice: () => {},
    ...extra,
  })
  for (const scope of ['main', 'subagent']) {
    for (const viewFilter of ['all', ...layers, 'world-book']) {
      for (const keyword of ['', '深思门', '代理请求']) {
        const html = render(PromptConfigList, base({ scope, viewFilter, keyword }))
        assert.doesNotMatch(html, /data-layer-config=|data-layer-settings-standalone|data-config-id=/)
        assert.ok(!html.includes(marker), '无真实实例就不挂载设置控件')
      }
    }
  }
  // 只渲染不写入：不产生保存、不创建配置对象、不触发 patch。
  assert.deepEqual(patches, [])
  assert.deepEqual(saves, [])
  // 真实子代理模板卡内嵌设置，保留固定文本表单和原始身份。
  const rule = parse(readFileSync(new URL('../../templates/66-subagent-start.yml', import.meta.url), 'utf8'))
  const props = base({ configs: [rule] })
  const card = find(tree(PromptConfigList, props), (node) => node.type === PromptConfigCard)
  assert.equal(card.props.config, rule)
  assert.equal(card.props.renderLayerSettings, props.renderLayerSettings)
  const expanded = render(PromptConfigCard, { ...card.props, expanded: true })
  assert.match(expanded, /子代理通用守则/)
  assert.match(expanded, /子代理启动层 · 固定文本/)
  assert.match(expanded, /data-layer-settings="subagent-start"/)
  assert.doesNotMatch(expanded, /data-layer-config=|子代理启动层配置/)
  assert.ok(expanded.includes(t('form.text.aria')), '仍是完整提示词配置表单')
  assert.equal(props.renderLayerSettings('subagent-start', rule), `${marker}:subagent-start`)
  const noSettingsCard = find(tree(PromptConfigList, base({ configs: [rule], hasLayerSettings: () => false })), (node) => node.type === PromptConfigCard)
  assert.equal(noSettingsCard.props.renderLayerSettings, undefined, '该层无设置时不生成空设置区')
  const withCard = render(PromptConfigList, base({
    viewFilter: 'tool-pipeline',
    configs: [{ id: 'pipe-rule-a', layer: 'tool-pipeline', order: 0, enabled: true, strategy: 'static' }],
    renderLayerSettings: (layer) => `${marker}:${layer}`,
    hasLayerSettings: () => true,
  }))
  assert.equal(withCard.includes('data-layer-config'), false)
  assert.ok(withCard.includes('pipe-rule-a'))
  // 该层没有可编辑设置：保持既有层空态与新增入口。
  const noSettings = render(PromptConfigList, base({ viewFilter: 'tool-pipeline', renderLayerSettings: () => marker, hasLayerSettings: () => false }))
  assert.equal(noSettings.includes('data-layer-config'), false)
  assert.ok(noSettings.includes(t('configs.empty.layer.title', { layer: t('layer.tool-pipeline') })))
  // 注入回调存在但该层无设置判定为假时，回调不被调用（不产生无谓渲染）。
  let called = 0
  render(PromptConfigList, base({ renderLayerSettings: () => { called += 1; return marker }, hasLayerSettings: () => false }))
  assert.equal(called, 0)
  const configs = [{ id: 'pipe-rule-a', layer: 'tool-pipeline', audience: 'main', enabled: true }]
  assert.doesNotMatch(render(PromptConfigList, base({ configs, scope: 'subagent' })), /data-layer-config=|data-config-id=/, '受众不可见时也不补卡')
  assert.doesNotMatch(render(PromptConfigList, base({ configs, scope: 'main', keyword: '不存在' })), /data-layer-config=/, '搜索隐藏实例时不额外生成设置卡')
  const nodes = tree(PromptConfigList, base({ configs }))
  find(nodes, (node) => node.type === 'button' && node.props.children === t('configs.batch.disableVisible', { count: 1 })).props.onClick()
  assert.deepEqual(patches, [[{ ...configs[0], enabled: false }]], '批量操作只处理真实规则')
})
