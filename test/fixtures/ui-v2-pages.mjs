import React from 'react'
import { createRoot } from 'react-dom/client'
import { PromptWorkspace } from '../../src/client/app/workspace/PromptWorkspace.tsx'
import { PROMPT_TOOL_DICTS } from '../../src/client/locales.ts'

const session = {}
const api = {
  sessionModel: { snapshot: () => session, subscribe: () => () => {} },
  currentSessionId: () => undefined,
  listAgentPresets: async () => { window.previewRequests++; return [{ id: 'test', name: 'Test' }] },
}
const settings = { scope: { getSnapshot: () => ({ status: 'ready', revision: 1 }) }, ensure: async () => {}, mutate: async () => {} }
const controllerState = { open: true }
const controller = { subscribe: () => () => {}, getSnapshot: () => controllerState }
const t = (key, params = {}) => Object.entries(params).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), PROMPT_TOOL_DICTS.zh[key] ?? key)
let configs = Array.from({ length: 36 }, (_, index) => ({ id: `config-${index}`, name: `配置 ${index}`, layer: 'pre-step', strategy: 'static', enabled: true, order: index, content: `正文 ${index}` }))
window.requests = []
window.previewRequests = 0
window.saveDelay = 0
window.rejectSave = false
window.characterDelay = 0
window.fetch = async (url, init) => {
  const endpoint = String(url).split('/').at(-1), body = JSON.parse(init?.body ?? '{}')
  window.requests.push({ endpoint, body })
  let value = {}
  if (endpoint === 'bootstrap') return new Response(JSON.stringify({ ok: true,
    value: { value: { presetTemplate: 'test', writePreset: true }, base: {}, revision: 1 },
    meta: { meta: window.fixture.meta }, overrides: { overrides: {} }, variables: { variables: {}, enabled: true },
    promptConfigs: { promptConfigs: configs },
    moduleFacts: { sourceMode: 'explicit', editable: true, effectiveModules: [], declaredModules: [], rowIds: [] },
  }))
  if (endpoint === 'instructions-policy') value = { policy: { enabled: false, files: {}, defaults: { order: 30, position: 'after-user', promotion: 'include-subagents', audience: null, modelScope: 'all' } }, revision: 'p1' }
  if (endpoint === 'templates') value = { templates: [], toolTemplates: [] }
  if (endpoint === 'custom-tools') value = { customTools: [] }
  if (endpoint === 'persona') value = { persona: null }
  if (endpoint === 'configs-validate') value = { valid: true, errors: [] }
  if (endpoint === 'param-overrides') {
    if (window.saveDelay) await new Promise((resolve) => setTimeout(resolve, window.saveDelay))
    if (window.rejectSave) return new Response(JSON.stringify({ ok: false, message: 'fixture save failed' }))
    if (body.promptConfigs) configs = body.promptConfigs
    value = body
  }
  if (endpoint === 'characters-list') {
    await new Promise((resolve) => setTimeout(resolve, window.characterDelay))
    value = { characters: Array.from({ length: 20 }, (_, index) => ({ id: `character-${index}`, name: `Character ${index}`, description: 'Long character list', hasAvatar: false, imported: false })) }
  }
  return new Response(JSON.stringify({ ok: true, value }))
}
createRoot(document.getElementById('root')).render(React.createElement(PromptWorkspace, { api, settings, controller, t, onClose: () => {} }))
