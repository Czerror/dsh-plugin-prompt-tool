import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CustomToolsCard } from '../../src/client/features/tools/CustomToolsCard.tsx'
import { PresetPersonaCard } from '../../src/client/features/persona/PresetPersonaCard.tsx'
import { SkillsPage } from '../../src/client/features/skills/SkillsPage.tsx'
import { PresetSwitcher } from '../../src/client/features/presets/PresetSwitcher.tsx'
import { PromptConfigList } from '../../src/client/features/prompts/PromptConfigList.tsx'
import { SubagentToolPolicyCard } from '../../src/client/features/subagents/SubagentToolPolicyCard.tsx'
import { SUBAGENT_TOOL_POLICY_SKELETON } from '../../src/shared/engine-capabilities.ts'
import { usePromptToolStore } from '../../src/client/data/use-prompt-tool-store.ts'
import { hasWorkspaceDrafts } from '../../src/client/data/workspace-drafts.ts'
import { PROMPT_TOOL_DICTS } from '../../src/client/locales.ts'

const session = {}
const api = { sessionModel: { snapshot: () => session, subscribe: () => () => {} }, sessionPreset: { snapshot: () => undefined, subscribe: () => () => {} }, currentSessionId: () => window.currentSessionId, subscribeSessionChange: () => () => {}, pickDirectory: async () => null }
const settings = { scope: { getSnapshot: () => ({ status: 'ready', revision: 1 }) }, ensure: async () => {}, mutate: async () => {} }
const t = (key, params = {}) => Object.entries(params).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), PROMPT_TOOL_DICTS.zh[key] ?? key)
window.t = t
window.requests = []
window.delay = 0
window.rejectDelete = false
window.rejectSkillDelete = false
window.rejectSkillsFolders = false
window.failedSkill = ''
window.skillImportConflicts = []
window.skillsComplete = true
window.skillsListDelay = 0
window.policyServer = structuredClone(SUBAGENT_TOOL_POLICY_SKELETON)
window.policyInFlight = 0
window.policyMaxInFlight = 0
let tools = [{ id: 'tool-one', name: 'demo', description: 'baseline', timeoutMs: 500, parameters: {}, output: { schema: { type: 'object' } }, execute: { kind: 'shell', command: 'echo test' } }]
let persona = { prefix: 'original persona' }
let presets = [{ id: 'test', name: 'Current' }, { id: 'other', name: 'Other' }]
const skillsRoot = 'D:/isolated/skills'
// 文件层调用策略的技能事实：实体留在各自来源根，条目只带 frontmatter 的两个调用策略事实与可写的标记文件路径。
let skills = [
  { id: 'project-dsh:D:/workspace:.dsh:beta', folder: 'beta', name: 'beta', description: 'beta description', dir: 'D:/workspace/.dsh/skills', source: 'project-dsh', rank: 100, valid: true, modelInvocable: true, userInvocable: true, path: 'D:/workspace/.dsh/skills/beta/SKILL.md' },
  { id: `user-dsh:${skillsRoot}:alpha`, folder: 'alpha', name: 'alpha', description: 'alpha description', dir: skillsRoot, source: 'user-dsh', rank: 400, valid: true, modelInvocable: true, userInvocable: true, path: `${skillsRoot}/alpha/SKILL.md` },
].map((skill) => ({ ...skill, availability: 'active', canSetPolicy: true, canDelete: skill.source === 'user-dsh' }))
window.getSkills = () => structuredClone(skills)
window.setSkills = (next) => { skills = structuredClone(next) }
let skillFolders = []
window.fetch = async (url, init) => {
  const endpoint = String(url).split('/').at(-1), body = JSON.parse(init?.body ?? '{}')
  window.requests.push({ endpoint, body })
  let value = {}
  if (endpoint === 'bootstrap') return new Response(JSON.stringify({ ok: true,
    value: { value: { presetTemplate: 'test', writePreset: true }, base: {}, revision: 1 },
    meta: { meta: { ...window.fixture.meta, presets } }, overrides: { overrides: {} }, variables: { variables: {}, enabled: true },
    promptConfigs: { promptConfigs: [] }, skillCatalog: skills, skillFolders, skillsComplete: window.skillsComplete,
    activeSkillsDirs: [skillsRoot],
    moduleFacts: { sourceMode: 'explicit', editable: true, effectiveModules: [], declaredModules: [], rowIds: [] },
  }))
  if (endpoint === 'instructions-policy') value = { policy: { enabled: false, files: {}, defaults: {} }, revision: 'p1' }
  if (endpoint === 'skills-list') {
    value = { skills: structuredClone(skills), folders: [...skillFolders], roots: [skillsRoot], complete: window.skillsComplete }
    await new Promise((resolve) => setTimeout(resolve, window.skillsListDelay))
  }
  if (endpoint === 'custom-tools') {
    if (body.customTools) { await new Promise((resolve) => setTimeout(resolve, window.delay)); tools = body.customTools }
    value = { customTools: tools }
  }
  if (endpoint === 'persona') {
    if ('persona' in body) { await new Promise((resolve) => setTimeout(resolve, window.delay)); persona = body.persona }
    value = { persona }
  }
  if (endpoint === 'subagent-tool-policy') {
    if ('policy' in body) {
      window.policyInFlight++
      window.policyMaxInFlight = Math.max(window.policyMaxInFlight, window.policyInFlight)
      await new Promise((resolve) => setTimeout(resolve, window.delay))
      window.policyServer = body.policy
      window.policyInFlight--
    }
    value = { policy: window.policyServer }
  }
  if (endpoint === 'characters-list') value = { characters: [] }
  if (endpoint === 'skill-policy') {
    await new Promise((resolve) => setTimeout(resolve, window.delay))
    if (body.name === window.failedSkill) return new Response(JSON.stringify({ ok: false, message: `failed ${body.name}` }))
    // 身份校验与服务端同形：name + path 必须指向清单里的同一条目（写错目标比写失败更危险）。
    const target = skills.find((skill) => skill.name === body.name && skill.path === body.path)
    if (target === undefined) return new Response(JSON.stringify({ ok: false, message: `unknown skill target: ${body.name}` }))
    if (!['model', 'user'].includes(body.side) || typeof body.enabled !== 'boolean') return new Response(JSON.stringify({ ok: false, message: 'single-side policy required' }))
    skills = skills.map((skill) => (skill === target ? { ...skill, [body.side === 'model' ? 'modelInvocable' : 'userInvocable']: body.enabled } : skill))
    value = { skills, complete: window.skillsComplete }
  }
  if (endpoint === 'skills-folders') {
    await new Promise((resolve) => setTimeout(resolve, window.delay))
    if (window.rejectSkillsFolders) return new Response(JSON.stringify({ ok: false, message: 'skills folders rejected' }))
    skillFolders = [...body.folders]
    value = { skills, complete: window.skillsComplete, folders: skillFolders }
  }
  if (endpoint === 'skill-delete') {
    await new Promise((resolve) => setTimeout(resolve, window.delay))
    if (window.rejectSkillDelete) return new Response(JSON.stringify({ ok: false, message: 'delete rejected' }))
    const target = skills.find((skill) => skill.name === body.name && skill.path === body.path && skill.canDelete)
    if (!target) return new Response(JSON.stringify({ ok: false, message: 'delete identity rejected' }))
    skills = skills.filter((skill) => skill !== target)
    value = { id: target.folder, path: `${target.dir}/.system/prompt-tool/.trash/skill-${target.folder}` }
  }
  if (endpoint === 'skill-create') {
    skills = [...skills, { id: `user-dsh:${skillsRoot}:${body.name}`, folder: body.name, name: body.name, description: body.description, dir: skillsRoot, source: 'user-dsh', rank: 400, valid: true, modelInvocable: true, userInvocable: true, path: `${skillsRoot}/${body.name}/SKILL.md`, availability: 'active', canSetPolicy: true, canDelete: true }]
    value = { id: body.name, path: `${skillsRoot}/${body.name}` }
  }
  if (endpoint === 'skills-import') {
    const conflicts = window.skillImportConflicts.filter((name) => !body.overwrite?.includes(name))
    if (conflicts.length > 0) return new Response(JSON.stringify({ ok: false, code: 'skills-overwrite-required', conflicts }), { status: 409 })
    value = { path: skillsRoot, count: 1, overwritten: body.overwrite?.length ?? 0, warning: window.skillImportWarning }
  }
  if (endpoint === 'skills-import-directory') {
    const conflicts = window.skillImportConflicts.filter((name) => !body.overwrite?.includes(name))
    if (conflicts.length > 0) return new Response(JSON.stringify({ ok: false, code: 'skills-overwrite-required', conflicts }), { status: 409 })
    value = { path: skillsRoot, count: 2, overwritten: body.overwrite?.length ?? 0, warning: window.skillImportWarning }
  }
  if (endpoint === 'preset-delete') {
    await new Promise((resolve) => setTimeout(resolve, window.delay))
    if (window.rejectDelete) return new Response(JSON.stringify({ ok: false, message: 'delete rejected' }))
    presets = presets.filter((preset) => preset.id !== body.id)
    value = { deleted: true }
  }
  return new Response(JSON.stringify({ ok: true, value }))
}

function App() {
  const store = usePromptToolStore(api, settings)
  const [page, setPage] = useState('tools')
  const [readOnly, setReadOnly] = useState(false)
  const [configs, setConfigs] = useState(['one', 'two'].map((id) => ({ id, layer: 'pre-step', strategy: 'static', order: 0 })))
  const browse = useRef({ query: '', status: 'all', selected: [] }).current
  window.store = store
  window.dirty = () => hasWorkspaceDrafts(store.editorDrafts, 'test')
  useEffect(() => { void store.load() }, [store.load])
  return React.createElement(React.Fragment, null,
    React.createElement('nav', null, ...['tools', 'persona', 'skills', 'presets', 'configs', 'policy'].map((id) => React.createElement('button', { key: id, 'data-page': id, onClick: () => setPage(id) }, id))),
    React.createElement('button', { 'data-readonly': true, onClick: () => setReadOnly((value) => !value) }, 'readonly'),
    page === 'tools' ? React.createElement(CustomToolsCard, { t, presetId: 'test', drafts: store.editorDrafts, onNotice: store.showNotice })
      : page === 'persona' ? React.createElement(PresetPersonaCard, { t, presetId: 'test', drafts: store.editorDrafts, onNotice: store.showNotice })
        : page === 'skills' ? React.createElement(SkillsPage, { t, store, api, browse })
          : page === 'presets' ? React.createElement(PresetSwitcher, { t, store })
            : page === 'policy' ? React.createElement(SubagentToolPolicyCard, { t, presetId: 'test', drafts: store.editorDrafts, disabled: readOnly, onNotice: store.showNotice })
              : React.createElement(PromptConfigList, { t, meta: window.fixture.meta, configs, fieldDrafts: store.editorDrafts.fields, draftScope: 'test', onPatchConfigs: setConfigs, onSaveConfigs: async () => true, onNotice: store.showNotice }),
    React.createElement('p', { 'data-notice': true }, store.notice))
}
createRoot(document.getElementById('root')).render(React.createElement(App))
