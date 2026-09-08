import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { ENGINE_CAPABILITIES } from '../../src/shared/engine-capabilities.ts'
import { ENGINE_PARAM_DEFINITIONS, ENGINE_PARAM_KEYS } from '../../src/shared/engine-params.ts'
import { EMPTY_FIELDS } from '../../src/client/data/prompt-tool-fields.ts'

const read = (path) => readFileSync(new URL(`../../src/client/${path}`, import.meta.url), 'utf8')
const reactModules = Object.fromEntries(['react', 'react/jsx-runtime', 'react-dom'].map((name) => [name, import.meta.resolve(name)]))
const loader = registerHooks({
  resolve(specifier, context, nextResolve) {
    return reactModules[specifier] === undefined ? nextResolve(specifier, context) : { url: reactModules[specifier], shortCircuit: true }
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default new Proxy({}, { get: (_, key) => key })' }
    if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 },
    }).outputText }
    return nextLoad(url, context)
  },
})
const { EngineParamFields } = await import('../../src/client/features/modules/EngineParamFields.tsx')
const { EngineModuleCards } = await import('../../src/client/features/modules/EngineModuleList.tsx')
loader.deregister()
const render = (component, props) => renderToStaticMarkup(createElement(component, props))
const store = {
  fields: { ...EMPTY_FIELDS },
  moduleFacts: { sourceMode: 'explicit', effectiveModules: [], declaredModules: [], editable: true, rowIds: [] },
}

test('模块字段从目录渲染，每个参数有且只有一个配置卡 owner', () => {
  const engineCards = new Set(ENGINE_CAPABILITIES.map(({ id }) => id))
  const specializedCards = new Set(['main-model', 'subagent-model', 'subagent-tools'])
  for (const key of ENGINE_PARAM_KEYS) {
    const definition = ENGINE_PARAM_DEFINITIONS[key]
    assert.ok(engineCards.has(definition.card) || specializedCards.has(definition.card) || definition.card === 'prompt-defaults', key)
    if (specializedCards.has(definition.card)) continue
    const html = render(EngineParamFields, { store, card: definition.card })
    assert.ok(html.includes(definition.label.replaceAll('&', '&amp;')), `${key} 必须有字段标签`)
    if (key !== 'stages') assert.ok(html.includes(`aria-label="${definition.label}"`), `${key} 必须有可访问输入控件`)
  }
})

test('卡片存在性来自装配事实，bootstrap-filesystem 显示为编辑工具能力', () => {
  const absent = render(EngineModuleCards, { store })
  assert.doesNotMatch(absent, /class="configName">tool-bootstrap</)
  const active = { ...store, moduleFacts: { ...store.moduleFacts, effectiveModules: ['tool-bootstrap', 'bootstrap-filesystem'] } }
  const html = render(EngineModuleCards, { store: active })
  assert.match(html, /class="configName">tool-bootstrap</)
  assert.match(html, /class="configName">str-replace-editor</)
  const filtered = render(EngineModuleCards, { store: active, layerFilter: 'pre-step' })
  assert.doesNotMatch(filtered, /class="configName">tool-bootstrap</)
  assert.doesNotMatch(filtered, /class="configName">str-replace-editor</)
  const official = render(EngineModuleCards, { store: { ...active, moduleFacts: { ...active.moduleFacts, sourceMode: 'official' } } })
  assert.doesNotMatch(official, /class="configName">tool-bootstrap</)
})

test('字段类型、零值与 system 只读由同一渲染器处理', () => {
  const current = { ...store, fields: { ...EMPTY_FIELDS, stagePreUnlock: 0, stages: [{ name: '读取', tools: 'read' }] } }
  const html = render(EngineParamFields, { store: current, card: 'tool-bootstrap' })
  assert.match(html, /id="pt-param-stagePreUnlock"[^>]*value="0"/)
  assert.match(html, /阶段 1 名称/)
  assert.match(html, /阶段 1 工具集/)
  const readonly = render(EngineParamFields, { store: { ...store, moduleFacts: { ...store.moduleFacts, editable: false } }, card: 'anchor-turn' })
  assert.match(readonly, /disabled=""/)
  assert.match(readonly, /aria-label="锚定轮文本"/)
})

test('递归深度和专用模型卡保留，过滤字段不重复出现在委派卡', () => {
  const delegation = read('features/subagents/DelegationToolsCard.tsx')
  assert.match(delegation, /ariaLabel="递归深度"/)
  assert.match(delegation, /fields\.maxDepth/)
  assert.doesNotMatch(delegation, /pt-tool-filter-allow|pt-tool-filter-deny|pt-allow-kinds/)
  assert.equal(ENGINE_PARAM_DEFINITIONS.toolFilterAllow.card, 'tool-filter')
  assert.equal(ENGINE_PARAM_DEFINITIONS.allowKinds.card, 'context-gate')
})

test('自定义工具编辑入口保留，能力删除仍需二次确认', () => {
  const custom = read('features/tools/CustomToolsCard.tsx')
  assert.match(custom, /从模板新建/)
  assert.match(custom, /新建工具/)
  assert.match(custom, /<CustomToolCard/)
  assert.match(read('ui/EngineModuleCard.tsx'), /确认删除/)
  assert.match(read('features/modules/EngineModuleList.tsx'), /store\.removeEngineCapability\(capability\.id\)/)
})
