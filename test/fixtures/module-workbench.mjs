// 真实 React 工作台，只有宿主 HTTP/会话依赖替换为内存数据；不访问用户 DSH。
import React, { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { MainSessionPage } from '../../src/client/app/workspace/pages/MainSessionPage.tsx'
import { usePromptToolStore } from '../../src/client/data/use-prompt-tool-store.ts'
import { PROMPT_TOOL_DICTS } from '../../src/client/locales.ts'
const fixture = window.fixture
const session = {}
const api = { sessionModel: { snapshot: () => session, subscribe: () => () => {} }, currentSessionId: () => undefined }
const settings = { scope: { getSnapshot: () => ({ status: 'ready', revision: 1 }) }, ensure: async () => {}, mutate: async () => {} }
const t = (key, params = {}) => Object.entries(params).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), PROMPT_TOOL_DICTS.zh[key] ?? key)
let configs = [], variables = {}, tools = []
const modules = new Set()
window.requests = []
window.fetch = async (url, init) => {
  const endpoint = String(url).split('/').at(-1), body = JSON.parse(init?.body ?? '{}')
  window.requests.push({ endpoint, body })
  let value = {}
  if (endpoint === 'bootstrap') return new Response(JSON.stringify({ ok: true,
    value: { value: { presetTemplate: 'test', writePreset: true }, base: {}, revision: 1 },
    meta: { meta: fixture.meta }, overrides: { overrides: {} }, variables: { variables, enabled: true },
    promptConfigs: { promptConfigs: window.staleGenerated ? [] : configs },
    moduleFacts: { sourceMode: 'explicit', editable: true, effectiveModules: [...modules], declaredModules: [...modules], rowIds: [] },
  }))
  if (endpoint === 'instructions-policy') value = { policy: { enabled: false, files: {}, defaults: { order: 30, position: 'after-user', promotion: 'none', audience: null, modelScope: 'all' } }, revision: null, exists: false }
  if (endpoint === 'templates') value = fixture.templates
  if (endpoint === 'param-overrides') { if (body.promptConfigs) configs = body.promptConfigs; value = body }
  if (endpoint === 'custom-tools') {
    if (body.customTools && window.rejectToolSave) return new Response(JSON.stringify({ ok: false, message: 'test: incomplete tool' }))
    if (body.customTools) tools = body.customTools
    value = { customTools: tools }
  }
  if (endpoint === 'engine-capability') { modules.add(body.capabilityId); value = { changed: true } }
  if (endpoint === 'preset-variables') { if (body.variables) variables = body.variables; value = { variables } }
  if (endpoint === 'configs-validate') value = { valid: true, errors: [] }
  if (endpoint === 'persona') value = { persona: null }
  return new Response(JSON.stringify({ ok: true, value }))
}
function App() {
  const store = usePromptToolStore(api, settings)
  window.store = store
  useEffect(() => { void store.load() }, [store.load])
  return React.createElement(React.Fragment, null, React.createElement(MainSessionPage, { store, t }), React.createElement('p', { role: 'status' }, store.notice))
}
createRoot(document.getElementById('root')).render(React.createElement(App))
