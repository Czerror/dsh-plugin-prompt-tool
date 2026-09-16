// 真实导入 UI（角色卡页 + 预设切换器）挂载：只把宿主 HTTP 依赖换成内存控制面，不访问用户 DSH。
// 测试通过 window.previewPlan / window.submitPlan 控制每次端点应答，用真实 File 输入驱动。
import React from 'react'
import { createRoot } from 'react-dom/client'
import { CharactersPage } from '../../src/client/features/characters/CharactersPage.tsx'
import { PresetSwitcher } from '../../src/client/features/presets/PresetSwitcher.tsx'
import { PROMPT_TOOL_DICTS } from '../../src/client/locales.ts'

const t = (key, params = {}) => Object.entries(params)
  .reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), PROMPT_TOOL_DICTS.zh[key] ?? key)

const emptyReport = () => ({
  converter: 'st-to-preset/3',
  sourceName: 'card',
  orderGroups: [],
  entries: [],
  diagnostics: [],
  summary: { inputs: 1, converted: 1, disabled: 0, excluded: 0, unsupported: 0, degraded: 0, needsReview: 0 },
})

const json = (value) => new Response(JSON.stringify(value))
const container = document.getElementById('root')
let root

window.requests = []
window.notices = []
window.errors = []
window.targetPreset = 'test'
window.characters = []
window.previewPlan = []
window.submitPlan = []
window.previewCounter = 0
window.addEventListener('error', (event) => window.errors.push(String(event.message)))
window.addEventListener('unhandledrejection', (event) => window.errors.push(`rejection: ${String(event.reason)}`))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

window.fetch = async (url, init) => {
  const endpoint = String(url).split('/').at(-1)
  const body = JSON.parse(init?.body ?? '{}')
  window.requests.push({ endpoint, body })
  if (endpoint === 'characters-list') return json({ ok: true, value: { characters: window.characters } })
  if (endpoint === 'characters-import' || endpoint === 'import-preset-package') {
    if (body.preview === true) {
      window.previewCounter += 1
      const revision = `rev-${window.previewCounter}`
      const step = window.previewPlan.shift() ?? {
        ok: true,
        value: {
          preview: true,
          state: 'ready',
          sourceDigest: 'digest-1',
          previewRevision: revision,
          ...(endpoint === 'characters-import' ? { name: 'Ada' } : {}),
          report: emptyReport(),
        },
      }
      if (step.delay !== undefined) await sleep(step.delay)
      const value = typeof step.value === 'function' ? step.value(body) : step.value
      return json(step.ok === false ? { ok: false, code: step.code, message: step.message } : { ok: true, value })
    }
    return json(window.submitPlan.shift() ?? { ok: true, value: { name: 'Ada', id: 'demo' } })
  }
  return json({ ok: true, value: {} })
}

// fields 快照必须引用稳定（useSyncExternalStore 契约），只有目标预设变化时才换引用。
let fieldsCache = { presetTemplate: window.targetPreset, promptConfigs: [] }
const getFields = () => {
  if (fieldsCache.presetTemplate !== window.targetPreset) {
    fieldsCache = { ...fieldsCache, presetTemplate: window.targetPreset }
  }
  return fieldsCache
}

const store = {
  getFields,
  subscribeFields: () => () => {},
  meta: { presets: [], builtinTemplates: [] },
  load: async () => {},
  setPresetTemplate: (id) => { window.targetPreset = id },
  showNotice: (kind, message) => {
    window.notices.push({ kind, message })
    document.getElementById('notice').textContent = `${kind}:${message}`
  },
}

function App() {
  return React.createElement(React.Fragment, null,
    React.createElement(PresetSwitcher, { store, t }),
    React.createElement(CharactersPage, { store, t }),
    React.createElement('p', { id: 'notice' }))
}

window.mount = () => {
  // React 18 的 root 在 unmount 后不可复用：重新挂载用新 root。
  if (root !== undefined) root.unmount()
  root = createRoot(container)
  root.render(React.createElement(App))
}
window.unmount = () => {
  root?.unmount()
  root = undefined
}
window.mount()
