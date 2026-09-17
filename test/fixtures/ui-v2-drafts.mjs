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
const api = { sessionModel: { snapshot: () => session, subscribe: () => () => {} }, currentSessionId: () => undefined, pickDirectory: async () => null }
const settings = { scope: { getSnapshot: () => ({ status: 'ready', revision: 1 }) }, ensure: async () => {}, mutate: async () => {} }
const t = (key, params = {}) => Object.entries(params).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), PROMPT_TOOL_DICTS.zh[key] ?? key)
window.t = t
window.requests = []
window.delay = 0
window.rejectDelete = false
window.rejectSkillDelete = false
window.rejectSkillsFolders = false
window.failedSkill = ''
window.policyServer = structuredClone(SUBAGENT_TOOL_POLICY_SKELETON)
window.policyInFlight = 0
window.policyMaxInFlight = 0
let tools = [{ id: 'tool-one', name: 'demo', description: 'baseline', timeoutMs: 500, parameters: {}, output: { schema: { type: 'object' } }, execute: { kind: 'shell', command: 'echo test' } }]
let persona = { prefix: 'original persona' }
let presets = [{ id: 'test', name: 'Current' }, { id: 'other', name: 'Other' }]
const skillsRoot = 'D:/isolated/skills'
// 注册层屏蔽模型的技能事实：实体留在各自来源根，插件只提供清单、屏蔽表与引用目录。
let skills = [
  { id: 'project-dsh:D:/workspace:.dsh:beta', folder: 'beta', name: 'beta', description: 'beta description', dir: 'D:/workspace/.dsh/skills', source: 'project-dsh', rank: 100, valid: true, blocked: false, blockedModel: false, blockedUser: false, modelInvocable: true, userInvocable: true },
  { id: `user-dsh:${skillsRoot}:alpha`, folder: 'alpha', name: 'alpha', description: 'alpha description', dir: skillsRoot, source: 'user-dsh', rank: 400, valid: true, blocked: false, blockedModel: false, blockedUser: false, modelInvocable: true, userInvocable: true },
]
let blockedSkills = []
let skillFolders = []
window.fetch = async (url, init) => {
  const endpoint = String(url).split('/').at(-1), body = JSON.parse(init?.body ?? '{}')
  window.requests.push({ endpoint, body })
  let value = {}
  if (endpoint === 'bootstrap') return new Response(JSON.stringify({ ok: true,
    // descriptor.value 里同时给出用户技能根：客户端当前只从 descriptor 值读 activeSkillsDirs
    // （顶层字段是服务端真实形状，两条路径都给，页面上的用户根与删除入口才可用）。
    value: { value: { presetTemplate: 'test', writePreset: true, activeSkillsDirs: [skillsRoot] }, base: {}, revision: 1 },
    meta: { meta: { ...window.fixture.meta, presets } }, overrides: { overrides: {} }, variables: { variables: {}, enabled: true },
    promptConfigs: { promptConfigs: [] }, skillCatalog: skills, skillFolders,
    activeSkillsDirs: [skillsRoot],
    moduleFacts: { sourceMode: 'explicit', editable: true, effectiveModules: [], declaredModules: [], rowIds: [] },
  }))
  if (endpoint === 'instructions-policy') value = { policy: { enabled: false, files: {}, defaults: {} }, revision: 'p1' }
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
  if (endpoint === 'skill-block') {
    await new Promise((resolve) => setTimeout(resolve, window.delay))
    if (body.name === window.failedSkill) return new Response(JSON.stringify({ ok: false, message: `failed ${body.name}` }))
    // 注册层屏蔽按范围生效：两端各自独立，'none' 表示恢复。
    const scope = body.scope
    skills = skills.map((skill) => skill.name === body.name ? {
      ...skill,
      blocked: scope !== 'none',
      blockedModel: scope === 'all' || scope === 'model',
      blockedUser: scope === 'all' || scope === 'user',
    } : skill)
    blockedSkills = skills.filter((skill) => skill.blocked).map((skill) => skill.name)
    value = { skills, blocked: blockedSkills }
  }
  if (endpoint === 'skills-folders') {
    await new Promise((resolve) => setTimeout(resolve, window.delay))
    if (window.rejectSkillsFolders) return new Response(JSON.stringify({ ok: false, message: 'skills folders rejected' }))
    skillFolders = [...body.folders]
    value = { skills, folders: skillFolders }
  }
  if (endpoint === 'skill-delete') {
    await new Promise((resolve) => setTimeout(resolve, window.delay))
    if (window.rejectSkillDelete) return new Response(JSON.stringify({ ok: false, message: 'delete rejected' }))
    skills = skills.filter((skill) => skill.folder !== body.folder)
    value = { id: body.folder, path: `${skillsRoot}/.system/prompt-tool/.trash/skill-${body.folder}` }
  }
  if (endpoint === 'skill-create') {
    skills = [...skills, { id: `user-dsh:${skillsRoot}:${body.name}`, folder: body.name, name: body.name, description: body.description, dir: skillsRoot, source: 'user-dsh', rank: 400, valid: true, blocked: false, modelInvocable: true, userInvocable: true }]
    value = { id: body.name, path: `${skillsRoot}/${body.name}` }
  }
  if (endpoint === 'skills-import') {
    value = { path: skillsRoot, count: 1 }
  }
  if (endpoint === 'skills-import-directory') {
    value = { path: skillsRoot, count: 2 }
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
