// 真实 feature / DOM / File；只替换宿主接口，不触碰用户安装。
import React from 'react'
import { createRoot } from 'react-dom/client'
import { CharactersPage } from '../../src/client/features/characters/CharactersPage.tsx'
import { PresetSwitcher } from '../../src/client/features/presets/PresetSwitcher.tsx'
import { PROMPT_TOOL_DICTS } from '../../src/client/locales.ts'
import { createWorkspaceDrafts } from '../../src/client/data/workspace-drafts.ts'

const t = (key, params = {}) => Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), PROMPT_TOOL_DICTS.zh[key] ?? key)
const json = (value) => new Response(JSON.stringify(value))
let root
let fields = { presetTemplate: 'current', promptConfigs: [] }
let sources = new Map()
const report = () => ({ converter: 'st-to-preset/3', sourceName: 'source', orderGroups: [{ characterId: '1', selected: true, entries: 1 }, { characterId: '2', selected: false, entries: 2 }], entries: [], diagnostics: [], summary: { inputs: 1, converted: 1, disabled: 0, excluded: 0, unsupported: 0, degraded: 0, needsReview: 0 } })
window.errors = []
window.addEventListener('error', (event) => window.errors.push(event.message))
window.addEventListener('unhandledrejection', (event) => window.errors.push(String(event.reason)))
window.fetch = async (url, init) => {
  const endpoint = String(url).split('/').at(-1)
  if (endpoint === 'asset-upload') {
    const name = decodeURIComponent(init.headers['x-file-name'])
    window.requests.push({ endpoint, name, bytes: Array.from(new Uint8Array(await init.body.arrayBuffer())) })
    if (window.uploadError) throw new Error(window.uploadError)
    if (window.holdUpload) await new Promise((resolve) => { window.releaseUpload = resolve })
    const sourceId = `source-${sources.size + 1}`
    sources.set(sourceId, name)
    return json({ ok: true, value: { sourceId, name, bytes: init.body.size } })
  }
  const body = JSON.parse(init?.body ?? '{}')
  window.requests.push({ endpoint, body })
  if (endpoint === 'asset-release') return json({ ok: true, value: { released: true } })
  if (endpoint === 'characters-list') return window.refreshError ? json({ ok: false, message: 'refresh failed' }) : json({ ok: true, value: { characters: [{ id: 'existing', name: 'Existing', hasAvatar: false, imported: false }] } })
  if (endpoint === 'characters-import' || endpoint === 'import-preset-package') {
    if (!body.preview) {
      if (window.holdSubmit) await new Promise((resolve) => { window.releaseSubmit = resolve })
      return json(window.submitPlan.shift() ?? { ok: true, value: { id: 'imported', name: 'Imported' } })
    }
    const step = window.previewPlan.shift() ?? {}
    if (step.hold) await new Promise((resolve) => { window.releasePreview = resolve })
    const sourceName = sources.get(body.sourceId) ?? body.files?.[0]?.path ?? 'source'
    const summary = { sourceName, kind: 'native-preset', targetId: body.targetId ?? 'imported', targetName: body.targetName ?? 'Imported', exists: body.overwrite === true, files: [{ path: 'preset.yml', bytes: 32 }, { path: 'assets/avatar.png', bytes: 8 }], configCount: 1, warnings: [] }
    return json(step.ok === false ? step : { ok: true, value: { state: 'ready', sourceDigest: 'digest', previewRevision: `rev-${window.requests.length}`, summary, report: report(), ...step.value } })
  }
  if (endpoint === 'export-preset') {
    const step = window.exportPlan.shift()
    return json(step ?? { ok: true, value: { id: body.id, name: 'Current', revision: 'export-rev', content: body.preview ? '' : body.mode === 'zip' ? 'UEs=' : 'id: current\n', encoding: body.mode === 'zip' ? 'base64' : 'utf8', filename: body.mode === 'zip' ? 'current.zip' : 'current.preset.yml', files: [{ path: 'preset.yml', bytes: 12 }], blockers: [], warnings: [], memoryConflicts: [], excludedMemoryCount: 2 } })
  }
  return json({ ok: true, value: {} })
}
window.store = {
  get fields() { return fields },
  getFields: () => fields,
  subscribeFields: () => () => {},
  editorDrafts: createWorkspaceDrafts(),
  savedConfigs: [],
  meta: { presets: [{ id: 'current', name: 'Current' }, { id: 'existing', name: 'Existing' }], builtinTemplates: [] },
  load: async () => { if (window.refreshError) throw new Error('refresh failed'); window.loads += 1 },
  setPresetTemplate: (id) => { window.switched = id },
  persistConfigs: async (_configs, options) => { window.saved += 1; window.saveOptions = options; window.store.savedConfigs = fields.promptConfigs.slice(); window.store.dirtyConfigs = false; return true },
  showNotice: (kind, message) => window.notices.push({ kind, message }),
}
const click = HTMLAnchorElement.prototype.click
HTMLAnchorElement.prototype.click = function () { window.downloads.push(this.download); if (!this.download) click.call(this) }
window.mount = (mode = 'presets') => {
  root?.unmount()
  sources = new Map()
  fields = { presetTemplate: 'current', promptConfigs: [] }
  Object.assign(window, { requests: [], notices: [], previewPlan: [], submitPlan: [], exportPlan: [], downloads: [], loads: 0, saved: 0, switched: '', refreshError: false, uploadError: '', holdUpload: false, holdSubmit: false, releasePreview: undefined, releaseUpload: undefined, releaseSubmit: undefined })
  Object.assign(window.store, { dirtyConfigs: false, dirtySwitches: false, savedConfigs: [], editorDrafts: createWorkspaceDrafts() })
  root = createRoot(document.getElementById('root'))
  root.render(React.createElement(mode === 'characters' ? CharactersPage : PresetSwitcher, { store: window.store, t }))
}
window.unmount = () => { root?.unmount(); root = undefined }
window.mount()
