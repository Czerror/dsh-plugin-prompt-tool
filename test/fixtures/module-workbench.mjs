// 真实 React 工作台，只有宿主 HTTP/会话依赖替换为内存数据；不访问用户 DSH。
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MainSessionPage } from '../../src/client/app/workspace/pages/MainSessionPage.tsx'
import { SubagentPage } from '../../src/client/app/workspace/pages/SubagentPage.tsx'
import { usePromptToolStore } from '../../src/client/data/use-prompt-tool-store.ts'
import { PROMPT_TOOL_DICTS } from '../../src/client/locales.ts'
import { engineCapability, engineRecipe } from '../../src/shared/engine-capabilities.ts'
const fixture = window.fixture
const session = { sessionId: 'test-session', selectable: true }
const api = { sessionModel: { snapshot: () => session, subscribe: () => () => {}, select: async (selection) => { window.sessionSelection = selection } }, currentSessionId: () => undefined, subscribeSessionChange: () => () => {} }
const settings = { scope: { getSnapshot: () => ({ status: 'ready', revision: 1 }) }, ensure: async () => {}, mutate: async () => {} }
const t = (key, params = {}) => Object.entries(params).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), PROMPT_TOOL_DICTS.zh[key] ?? key)
// 两条指令文件（全局 + 项目）：与真实探测结果同形，用于验证它们复用标准配置卡渲染。
const instructionFiles = [
  { fileId: 'f1', path: 'D:/home/.dsh/AGENTS.md', displayPath: '~/.dsh/AGENTS.md', scope: 'global', status: 'ready', text: '全局指令正文', revision: 'r1' },
  { fileId: 'f2', path: 'D:/repo/AGENTS.md', displayPath: 'AGENTS.md', scope: 'project', status: 'ready', text: '项目指令正文', revision: 'r2' },
]
const instructionCard = (file) => ({
  id: `agents-file-${file.fileId}`,
  name: `AGENTS：${file.displayPath}`,
  enabled: true,
  strategy: 'placeholder',
  layer: 'pre-step',
  position: 'after-user',
  dedupe: 'session',
  promotion: 'include-subagents',
  sourceKind: 'instruction-file',
  form: 'instructions',
  fill: 'instruction-hint',
  order: 30 + instructionFiles.indexOf(file),
  origin: { kind: 'instruction-file', fileId: file.fileId },
  params: { scope: file.scope, file: file.path, displayPath: file.displayPath, fileId: file.fileId },
})
let configs = [], variables = {}, tools = [], overrides = {}
const modules = new Set()
window.requests = []
window.fetch = async (url, init) => {
  const endpoint = String(url).split('/').at(-1), body = JSON.parse(init?.body ?? '{}')
  window.requests.push({ endpoint, body })
  let value = {}
  if (endpoint === 'bootstrap') return new Response(JSON.stringify({ ok: true,
    value: { value: { presetTemplate: 'test', writePreset: window.writePreset !== false }, base: {}, revision: 1 },
    meta: { meta: fixture.meta }, overrides: { overrides }, variables: { variables, enabled: true },
    modelCatalog: { test: ['model-a', 'model-b'] }, hostDefaultModel: { provider: 'test', model: 'model-a' },
    // 生成快照可能暂时为空；指令文件卡始终由文件快照合并回来（与宿主 bridge 同形）。
    promptConfigs: { promptConfigs: [...(window.staleGenerated ? [] : configs), ...instructionFiles.map(instructionCard)] },
    instructions: {
      context: { contextId: 'ctx-1', cwd: 'D:/repo', source: 'session' },
      files: instructionFiles,
      owner: { officialInstructions: null },
    },
    moduleFacts: { sourceMode: 'explicit', editable: window.presetEditable !== false, effectiveModules: [...modules], declaredModules: [...modules], rowIds: [] },
  }))
  if (endpoint === 'instructions-policy') value = { policy: { enabled: true, files: {}, defaults: { order: 30, position: 'after-user', promotion: 'include-subagents', audience: null, modelScope: 'all' } }, revision: 'pol-1', exists: true }
  if (endpoint === 'templates') value = fixture.templates
  if (endpoint === 'param-overrides') { if (body.promptConfigs) configs = body.promptConfigs; if (body.overrides) overrides = body.overrides; value = body }
  if (endpoint === 'custom-tools') {
    if (body.customTools && window.rejectToolSave) return new Response(JSON.stringify({ ok: false, message: 'test: incomplete tool' }))
    if (body.customTools) tools = body.customTools
    value = { customTools: tools }
  }
  if (endpoint === 'engine-capability') {
    const ids = body.action === 'create-recipe' ? engineRecipe(body.recipeId)?.capabilities ?? [] : [body.capabilityId]
    for (const id of ids) for (const module of engineCapability(id)?.moduleKeys ?? []) modules.add(module)
    value = { changed: true }
  }
  if (endpoint === 'preset-variables') { if (body.variables) variables = body.variables; value = { variables } }
  if (endpoint === 'configs-validate') value = { valid: true, errors: [] }
  if (endpoint === 'persona') value = { persona: null }
  return new Response(JSON.stringify({ ok: true, value }))
}
function App() {
  const store = usePromptToolStore(api, settings)
  window.store = store
  useEffect(() => { void store.load() }, [store.load])
  const [page, setPage] = useState('main')
  window.selectPage = setPage
  return React.createElement(React.Fragment, null,
    page === 'away' ? null : React.createElement(page === 'subagent' ? SubagentPage : MainSessionPage, { store, t }),
    React.createElement('p', { role: 'status' }, store.notice))
}
createRoot(document.getElementById('root')).render(React.createElement(App))
