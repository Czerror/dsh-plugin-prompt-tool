import { renderTemplate } from '../template-frame.mjs'

export const PERSONA_PREFIX = 'deployment:persona-prefix'
const PERSONA_SUFFIX = 'deployment:persona-suffix'
const HARNESS_IDENTITY = 'harness:identity'
const DEFAULT_PRESET_IDENTITIES = ['You are a coding agent powered by the {{model}} model.', 'You are a helpful software engineer assistant.']
const DEFAULT_HARNESS_IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'

export function validatePersonaAction(action) {
  if (action.instructionMaxBytes !== undefined && (!Number.isSafeInteger(action.instructionMaxBytes) || action.instructionMaxBytes <= 0)) throw new TypeError('persona.instructionMaxBytes must be a positive safe integer')
  if (action.stripDefaultIdentity !== undefined && !['preset', 'harness'].includes(action.stripDefaultIdentity)) throw new TypeError('persona.stripDefaultIdentity must be preset or harness')
  if (action.audience !== undefined && !['main', 'subagent'].includes(action.audience)) throw new TypeError('persona.audience must be main or subagent')
  for (const field of ['prefix', 'suffix']) {
    if (action[field] === undefined) continue
    if (typeof action[field] !== 'string') throw new TypeError(`persona.${field} must be string`)
    if (new TextEncoder().encode(action[field]).byteLength > 1024 * 1024) throw new RangeError(`persona.${field} exceeds 1 MiB`)
  }
  for (const field of ['complete', 'includeRuntimeContext']) {
    if (action[field] !== undefined && typeof action[field] !== 'boolean') throw new TypeError(`persona.${field} must be boolean`)
  }
  if (action.waterfallPosition !== undefined && action.waterfallPosition !== 'default') throw new TypeError('persona is prepared before assemble; waterfallPosition is not supported')
}

/** 已获准动作的完整候选；所有校验和正文求值都早于撤销旧注册。 */
export function planPersonaActions(entries, context, prompt, adapter, variableStore, warn, preview = false) {
  const flags = {}
  for (const { action } of entries) for (const field of ['complete', 'includeRuntimeContext', 'instructionMaxBytes']) {
    const value = action[field]
    if (value === undefined) continue
    if (flags[field] !== undefined && flags[field] !== value) throw new TypeError(`persona ${field} conflict`)
    flags[field] = value
  }
  const sections = []
  for (const [name, field, position] of [[PERSONA_PREFIX, 'prefix', 'DEPLOYMENT_PERSONA_PREFIX'], [PERSONA_SUFFIX, 'suffix', 'DEPLOYMENT_PERSONA_SUFFIX']]) {
    const declared = entries.filter(entry => entry.action[field] !== undefined)
    const complete = field === 'prefix' ? flags.complete : undefined
    if (declared.length === 0 && complete === undefined) continue
    const base = adapter?.inherited?.(name)
    let text
    try {
      text = declared.length === 0 ? base?.text ?? '' : declared.map(entry => renderTemplate({
        sourceModuleId: entry.sourceModuleId, ruleId: entry.rule.id, id: `${entry.id}:${field}`,
        texts: [entry.action[field]], variables: entry.rule.variables,
      }, context, { variableStore, enabled: entry.rule.variablesEnabled !== false, warn, preview })).filter(text => text.length > 0).join('\n\n')
    } catch (error) {
      if (error.code === 'template-fact-unavailable') return { sections: [], suppressRuntimeContext: false }
      throw error
    }
    sections.push({ name, order: base?.order ?? prompt.getSectionOrder(position), text,
      ...(complete ?? base?.complete) === true ? { complete: true } : {},
      ...base?.interpolate === undefined ? {} : { interpolate: base.interpolate },
    })
  }
  return { sections, suppressRuntimeContext: flags.includeRuntimeContext === false, instructionMaxBytes: flags.instructionMaxBytes,
    customPrefix: entries.some(entry => entry.action.prefix !== undefined),
    identityEntries: entries.filter(entry => entry.action.stripDefaultIdentity !== undefined) }
}

/** 只处理官方装配已解析的具名段；每次请求独立变换，不遮蔽或重建任何 owner。 */
export function stripPersonaIdentity(assembly, entries, report, customPrefix = false) {
  let sections = assembly.sections
  for (const entry of entries) {
    const preset = entry.action.stripDefaultIdentity === 'preset'
    const name = preset ? PERSONA_PREFIX : HARNESS_IDENTITY
    const target = assembly.sections.find(section => section.name === name)
    const identity = preset ? DEFAULT_PRESET_IDENTITIES.find(text => typeof target?.text === 'string'
      && target.text.startsWith(text) && /^(?:\s|$)/.test(target.text.slice(text.length))) : DEFAULT_HARNESS_IDENTITY
    const matched = !(preset && customPrefix) && typeof target?.text === 'string' && (preset
      ? identity !== undefined
      : target.text === identity)
    try { report?.({ moduleId: entry.sourceModuleId, ruleId: entry.rule.id, channel: `persona:identity:${entry.action.stripDefaultIdentity}`, outcome: 'hit',
      identityOutcome: matched ? 'matched' : 'target-mismatch', definitionRevision: entry.rule.definitionRevision }) } catch { /* 只读诊断不能改变装配 */ }
    if (matched) sections = sections.map(section => section.name !== name ? section : { ...section, text: target.text.slice(identity.length) })
  }
  return sections === assembly.sections ? assembly : { ...assembly, sections }
}
