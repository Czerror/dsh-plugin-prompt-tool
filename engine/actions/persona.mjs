import { renderTemplate } from '../template-frame.mjs'

export const PERSONA_PREFIX = 'deployment:persona-prefix'
const PERSONA_SUFFIX = 'deployment:persona-suffix'

export function validatePersonaAction(action) {
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
  for (const { action } of entries) for (const field of ['complete', 'includeRuntimeContext']) {
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
  return { sections, suppressRuntimeContext: flags.includeRuntimeContext === false }
}
