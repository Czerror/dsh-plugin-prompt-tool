// 真实导入入口和子代理页面；仅替换宿主 store / HTTP，不访问用户 DSH。
import React, { useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { PresetSwitcher } from '../../src/client/features/presets/PresetSwitcher.tsx'
import { CharactersPage } from '../../src/client/features/characters/CharactersPage.tsx'
import { SubagentPage } from '../../src/client/app/workspace/pages/SubagentPage.tsx'
import { EMPTY_FIELDS, EMPTY_META } from '../../src/client/data/prompt-tool-fields.ts'
import { PROMPT_TOOL_DICTS } from '../../src/client/locales.ts'

const t = (key, params = {}) => Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), PROMPT_TOOL_DICTS.zh[key] ?? key)
const noop = () => {}
const listeners = new Set()
let fields
let version = 0
const session = { selectable: false }
const store = {
  get fields() { return fields },
  getFields: () => fields,
  subscribeFields: listener => { listeners.add(listener); return () => listeners.delete(listener) },
  patch: patch => { fields = { ...fields, ...patch }; version++; for (const listener of listeners) listener() },
  meta: { ...EMPTY_META, layers: ['pre-step', 'system-section', 'tool-pipeline'], presets: [], builtinTemplates: [] },
  moduleFacts: { sourceMode: 'explicit', declaredModules: ['subagent-tool-policy', 'anchor-turn'], effectiveModules: ['subagent-tool-policy', 'anchor-turn'], rowIds: [], editable: true },
  api: { sessionModel: { subscribe: () => noop, snapshot: () => session }, sessionPreset: { snapshot: () => undefined, subscribe: () => noop } },
  modelCatalog: [], modelReasoning: {}, templatePreStepCount: 0,
  templateVariables: {}, templateVariablesEnabled: true,
  setTemplateVariables: noop, setTemplateVariablesEnabled: noop, saveTemplateVariables: noop,
  persistConfigs: async () => true, persistParamOverrides: async () => {},
  load: async () => {}, showNotice: (...notice) => window.notices.push(notice),
}
window.requests = []
window.notices = []
window.errors = []
window.scrolls = []
window.previewPlan = []
window.addEventListener('error', event => window.errors.push(String(event.message)))
window.addEventListener('unhandledrejection', event => window.errors.push(String(event.reason)))
const scroll = Element.prototype.scrollIntoView
Element.prototype.scrollIntoView = function (options) {
  window.scrolls.push(this.getAttribute('data-config-id') ?? this.getAttribute('data-module-card-id'))
  scroll.call(this, options)
}
window.fetch = async (url, init) => {
  const endpoint = String(url).split('/').at(-1)
  const body = JSON.parse(init?.body ?? '{}')
  window.requests.push({ endpoint, body })
  let value = {}
  if (endpoint === 'characters-list') value = { characters: [] }
  else if (endpoint === 'custom-tools') value = { tools: [] }
  else if (endpoint === 'templates') value = { templates: [{ file: 'created.yml', spec: { id: 'created-new', name: 'created-new', layer: 'pre-step', strategy: 'static', text: 'NEW' } }], toolTemplates: [] }
  else if (endpoint === 'import-preset-package' || endpoint === 'characters-import') {
    if (body.preview === true) {
      const plan = window.previewPlan.shift() ?? {}
      if (plan.hold) await new Promise(resolve => { window.releasePreview = resolve })
      value = { preview: true, state: 'ready', sourceDigest: 'digest', previewRevision: 'revision', report: {
        converter: 'st-to-preset/3', sourceName: body.files[0].path,
        orderGroups: [{ characterId: '1', selected: true, entries: 1 }, { characterId: '2', selected: false, entries: 2 }],
        entries: [], diagnostics: [], summary: { inputs: body.files.length, converted: 1, disabled: 0, excluded: 0, unsupported: 0, degraded: 0, needsReview: 0 },
      } }
    } else value = { id: 'package', name: 'character' }
  }
  return new Response(JSON.stringify({ ok: true, value }))
}
let root
function App({ mode }) {
  useSyncExternalStore(store.subscribeFields, () => version)
  return React.createElement(mode === 'presets' ? PresetSwitcher : mode === 'characters' ? CharactersPage : SubagentPage, { store: { ...store }, t })
}
window.mount = (mode, editable = true) => {
  root?.unmount()
  window.requests = []; window.notices = []; window.scrolls = []; window.previewPlan = []
  fields = { ...EMPTY_FIELDS, promptConfigs: [
    { id: 'pre-config', layer: 'pre-step', audience: 'subagent', strategy: 'static', text: 'PRE' },
    { id: 'system-config', layer: 'system-section', audience: 'subagent', strategy: 'static', text: 'SYSTEM' },
    { id: 'tool-config', layer: 'tool-pipeline', audience: 'subagent', strategy: 'static', text: '', params: { toolNames: 'bash', preDecision: 'allow', postAction: 'accept' } },
  ] }
  store.moduleFacts = { ...store.moduleFacts, editable }
  root = createRoot(document.getElementById('root'))
  root.render(React.createElement(App, { mode }))
}
window.unmount = () => { root?.unmount(); root = undefined }
window.mount('presets')
