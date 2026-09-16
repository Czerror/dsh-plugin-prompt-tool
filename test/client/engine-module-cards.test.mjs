import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { createElement, isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { ENGINE_CAPABILITIES, engineCapability, engineRecipe } from '../../src/shared/engine-capabilities.ts'
import { ENGINE_PARAM_DEFINITIONS, ENGINE_PARAM_KEYS } from '../../src/shared/engine-params.ts'
import { displayLayers } from '../../src/client/features/prompts/prompt-config-policy.ts'
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
const { EngineParamFields } = await import('../../src/client/features/modules/EngineParamFields.tsx')
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
  assert.match(page, /<CustomToolsCard/)
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

test('插入点顺序恒为六层，公共默认值不伪装成 pre-step 能力', () => {
  assert.deepEqual(displayLayers([]), ['pre-step', 'system-section', 'runtime-context', 'agent-request', 'llm-stream', 'tool-pipeline'])
  const list = read('features/modules/EngineModuleList.tsx')
  assert.match(list, /EnginePromptDefaultsCard/)
  assert.doesNotMatch(list, /name="提示词生成默认值" layer="pre-step"/)
  const editor = read('features/prompts/PromptConfigsEditor.tsx')
  assert.match(editor, /aria-label=\{t\('configs\.common\.aria'\)\}/)
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
  // 主会话把筛选值同时下发给配置与能力卡；自定义工具卡只在全部/工具链视图出现。
  const page = read('app/workspace/pages/MainSessionPage.tsx')
  assert.match(page, /layerFilter=\{viewFilter\}/)
  assert.match(page, /hidden=\{viewFilter !== 'all' && viewFilter !== 'tool-pipeline'\}/)
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
  const menu = tree(EngineCapabilityCreateMenu, { t, store: { ...store, fields: { ...store.fields, writePreset: true },
    createEngineCapability: async (...args) => { created.push(args); return true } }, onCreated: (id) => revealed.push(id) })
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
