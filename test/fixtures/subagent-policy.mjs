// 真实策略编辑器；只替换 HTTP，应答可延迟以验证草稿、请求与预设身份。
import React from 'react'
import { createRoot } from 'react-dom/client'
import { SubagentToolPolicyCard } from '../../src/client/features/subagents/SubagentToolPolicyCard.tsx'
import { SUBAGENT_TOOL_POLICY_SKELETON } from '../../src/shared/engine-capabilities.ts'
import { PROMPT_TOOL_DICTS } from '../../src/client/locales.ts'

const t = (key, params = {}) => Object.entries(params).reduce(
  (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), PROMPT_TOOL_DICTS.zh[key] ?? key)
const onNotice = (kind, message) => window.notices.push({ kind, message })
const policyFor = (id) => {
  const policy = structuredClone(SUBAGENT_TOOL_POLICY_SKELETON)
  policy.profiles[0].name = `original-${id}`
  return policy
}
let root
window.errors = []
window.addEventListener('error', (event) => window.errors.push(event.message))
window.addEventListener('unhandledrejection', (event) => window.errors.push(String(event.reason)))
window.selectPreset = (presetId) => root.render(React.createElement(SubagentToolPolicyCard, { presetId, t, onNotice }))
window.unmount = () => { root?.unmount(); root = undefined }
window.reset = (plans = {}) => {
  window.unmount()
  window.writes = []
  window.reads = []
  window.notices = []
  window.writePlan = plans.writes ?? []
  window.readPlan = plans.reads ?? []
  window.pendingWrites = []
  window.pendingReads = []
  window.saved = { a: policyFor('a'), b: policyFor('b') }
  root = createRoot(document.getElementById('root'))
  window.selectPreset('a')
}
window.fetch = async (url, init) => {
  const endpoint = String(url).split('/').at(-1)
  const body = JSON.parse(init?.body ?? '{}')
  if (endpoint === 'characters-list') return new Response(JSON.stringify({ ok: true, value: { characters: [] } }))
  if (endpoint !== 'subagent-tool-policy') return new Response(JSON.stringify({ ok: true, value: {} }))
  const writing = Object.hasOwn(body, 'policy')
  const plan = (writing ? window.writePlan : window.readPlan).shift() ?? {}
  const policy = structuredClone(writing ? body.policy : window.saved[body.expectedPresetId])
  ;(writing ? window.writes : window.reads).push(body)
  if (plan.defer) await new Promise((resolve) => (writing ? window.pendingWrites : window.pendingReads).push(resolve))
  if (plan.ok === false) return new Response(JSON.stringify({ ok: false, message: 'save rejected' }))
  if (writing) window.saved[body.expectedPresetId] = policy
  return new Response(JSON.stringify({ ok: true, value: { policy } }))
}
window.reset()
