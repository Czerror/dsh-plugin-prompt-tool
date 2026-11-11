/**
 * assembly —— 改装配结果的 sections / contexts；工具说明由原步骤视图投影。
 *
 * 工具可见面（目录、SDK 正文、执行闸）已收进 `tool-visibility`：同一个意图不再分散到
 * 多个动作。`target.tools` 在这里显式拒绝，避免旧声明「编译通过但静默不生效」。
 *
 * 语义保持原样：同层 sections 的 keep 与 remove 互斥；contexts 的 clear 与 add/remove 互斥；
 * 异常一律返回未改动的装配（装配失败不得让会话失去系统段或上下文）。
 */

import { NAME_LIST, requireString } from './shared.mjs'
import { interpolateVariables } from '../interpolate.mjs'
import { toolStepFor } from '../tool-scope.mjs'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 仅投影说明；原registry、执行器和schema约束仍由官方集合拥有。 */
export function applyToolDescriptions(view, plans = [], observe) {
  let result = view
  const applied = new Set()
  for (const plan of plans) for (const entry of plan.entries) {
    const { plugin, warnOnce } = plan
    const key = JSON.stringify([entry.name, entry.parameter, entry.match, entry.text])
    if (applied.has(key)) continue
    const definition = result.get(entry.name)
    const node = entry.parameter === undefined ? definition : definition?.parameters?.properties?.[entry.parameter]
    const label = `${entry.name}${entry.parameter === undefined ? '' : `.${entry.parameter}`}`
    const text = node?.description
    const at = typeof text === 'string' ? text.indexOf(entry.match) : -1
    if (at < 0 || text.indexOf(entry.match, at + 1) >= 0) {
      const reason = `${plugin}: assembly.toolDescriptions ${JSON.stringify(label)} target or match missing or ambiguous; skipped`
      warnOnce(reason)
      observe?.(plan, reason)
      continue
    }
    applied.add(key)
    const description = text.slice(0, at) + entry.text + text.slice(at + entry.match.length)
    if (description === text) continue
    const next = entry.parameter === undefined ? { ...definition, description } : { ...definition,
      parameters: { ...definition.parameters, properties: { ...definition.parameters.properties,
        [entry.parameter]: { ...node, description } } } }
    if (result === view) result = new Map(view)
    result.set(entry.name, next)
  }
  return result
}

function replaceEntries(list, entries, target, plugin, warnOnce, evidence = new WeakMap()) {
  if (!Array.isArray(list) || entries === undefined) return list
  let result = list
  for (const entry of entries) {
    const candidates = entry.match === undefined ? undefined : Array.isArray(entry.match) ? entry.match : [entry.match]
    const key = JSON.stringify([entry.name, candidates?.toSorted(), entry.text])
    const targets = result.filter(value => value?.name === entry.name)
    const previous = targets.length === 1 ? evidence.get(targets[0]) : undefined
    if (previous?.key === key && previous.text === targets[0].text) continue
    const index = result.findIndex(value => value?.name === entry.name && typeof value.text === 'string' && value.text.trim().length > 0)
    if (entry.match !== undefined && (index < 0 || result.filter(value => value?.name === entry.name).length !== 1)) {
      warnOnce(`${plugin}: assembly.${target}.replace target ${JSON.stringify(entry.name)} missing or ambiguous; skipped`)
      continue
    }
    if (index < 0) continue
    const current = result[index]
    let text = entry.text
    if (entry.match !== undefined) {
      const hits = candidates.map(match => ({ match, at: current.text.indexOf(match) })).filter(hit => hit.at >= 0)
      if (hits.length !== 1 || current.text.indexOf(hits[0].match, hits[0].at + 1) >= 0) {
        warnOnce(`${plugin}: assembly.${target}.replace match in ${JSON.stringify(entry.name)} missing or ambiguous; skipped`)
        continue
      }
      const { match, at } = hits[0]
      text = current.text.slice(0, at) + entry.text + current.text.slice(at + match.length)
    }
    if (current.text === text) continue
    if (result === list) result = [...list]
    result[index] = { ...current, text }
    evidence.set(result[index], { key, text })
  }
  return result
}

/** 官方刷新仍读取原provider，只重用该步骤已接受的文本配置。 */
export function applyAcceptedContextReplacements(assembly, step) {
  let contexts = assembly.contexts
  const evidence = new WeakMap()
  for (const plan of step?.contextReplacements ?? []) contexts = replaceEntries(contexts, plan.entries, 'contexts', plan.plugin, plan.warnOnce, evidence)
  return contexts === assembly.contexts ? assembly : { ...assembly, contexts }
}

export function prepareAssembly(action, plugin) {
  const target = action.target
  if (!record(target)) {
    throw new TypeError(`${plugin}: assembly requires a target object — { sections } / { contexts } / { toolDescriptions }`)
  }
  if (target.tools !== undefined) {
    throw new TypeError(`${plugin}: assembly.target.tools 已移除 — 工具可见面改用 tool-visibility 动作（allow/deny/discovery）`)
  }
  if (target.toolDescriptions !== undefined) {
    if (!Array.isArray(target.toolDescriptions)) throw new TypeError(`${plugin}: assembly.toolDescriptions must be an array`)
    for (const entry of target.toolDescriptions) {
      if (!record(entry) || Object.keys(entry).some(key => !['name', 'parameter', 'match', 'text'].includes(key))) throw new TypeError(`${plugin}: assembly.toolDescriptions entries must be { name, parameter?, match, text }`)
      for (const key of ['name', 'match']) if (typeof entry[key] !== 'string' || entry[key].trim().length === 0) throw new TypeError(`${plugin}: assembly.toolDescriptions[].${key} must be a non-empty string`)
      if (entry.parameter !== undefined && (typeof entry.parameter !== 'string' || entry.parameter.trim().length === 0)) throw new TypeError(`${plugin}: assembly.toolDescriptions[].parameter must be a non-empty string`)
      if (typeof entry.text !== 'string') throw new TypeError(`${plugin}: assembly.toolDescriptions[].text must be a string`)
    }
  }
  const sectionsAdd = target.sections?.add
  const sectionsRemove = NAME_LIST.parse(target.sections?.remove, plugin, 'assembly.sections.remove')
  const sectionsKeep = NAME_LIST.parse(target.sections?.keep, plugin, 'assembly.sections.keep')
  const sectionsAppend = target.sections?.append
  const sectionsReplace = target.sections?.replace
  const contextsReplace = target.contexts?.replace
  const contextsRemove = NAME_LIST.parse(target.contexts?.remove, plugin, 'assembly.contexts.remove')
  for (const [key, entries] of [['sections', sectionsReplace], ['contexts', contextsReplace]]) {
    if (entries === undefined) continue
    if (!Array.isArray(entries)) throw new TypeError(`${plugin}: assembly.${key}.replace must be an array of { name, text, match? }`)
    for (const entry of entries) {
      if (!record(entry) || Object.keys(entry).some(key => !['name', 'text', 'match'].includes(key))) throw new TypeError(`${plugin}: assembly.${key}.replace entries must be { name, text, match? }`)
      requireString(entry.name, `assembly.${key}.replace[].name`, plugin)
      requireString(entry.text, `assembly.${key}.replace[].text`, plugin)
      if (entry.match !== undefined) {
        const matches = Array.isArray(entry.match) ? entry.match : [entry.match]
        if (matches.length === 0 || matches.some(value => typeof value !== 'string' || value.length === 0) || new Set(matches).size !== matches.length) {
          throw new TypeError(`${plugin}: assembly.${key}.replace[].match must be a non-empty string or an array of distinct non-empty strings`)
        }
      }
      if (key === 'sections' && (sectionsRemove?.has(entry.name) || sectionsKeep !== undefined && !sectionsKeep.has(entry.name))
        || key === 'contexts' && contextsRemove?.has(entry.name)) throw new TypeError(`${plugin}: assembly.${key}.replace target cannot also be removed`)
    }
  }
  if (sectionsAppend !== undefined) {
    if (!Array.isArray(sectionsAppend)) throw new TypeError(`${plugin}: assembly.sections.append must be an array of { name, text, once? }`)
    for (const entry of sectionsAppend) {
      if (!record(entry)) throw new TypeError(`${plugin}: assembly.sections.append entries must be objects`)
      for (const key of Object.keys(entry)) {
        if (!['name', 'text', 'once'].includes(key)) throw new TypeError(`${plugin}: assembly.sections.append[] unknown field ${JSON.stringify(key)}`)
      }
      requireString(entry.name, 'assembly.sections.append[].name', plugin)
      requireString(entry.text, 'assembly.sections.append[].text', plugin)
      if (entry.once !== undefined && typeof entry.once !== 'boolean') throw new TypeError(`${plugin}: assembly.sections.append[].once must be boolean`)
      if (sectionsRemove?.has(entry.name)) throw new TypeError(`${plugin}: assembly.sections.append target ${JSON.stringify(entry.name)} cannot also be removed`)
    }
  }
  const contextsAdd = target.contexts?.add
  if (target.contexts?.clear !== undefined && typeof target.contexts.clear !== 'boolean') {
    throw new TypeError(`${plugin}: assembly.contexts.clear must be boolean`)
  }
  const contextsClear = target.contexts?.clear === true
  for (const [key, list] of [['sections.add', sectionsAdd], ['contexts.add', contextsAdd]]) {
    if (list === undefined) continue
    if (!Array.isArray(list)) throw new TypeError(`${plugin}: assembly.${key} must be an array of { name, text }`)
    for (const entry of list) {
      if (!record(entry)) throw new TypeError(`${plugin}: assembly.${key} entries must be objects`)
      requireString(entry.name, `assembly.${key}[].name`, plugin)
      requireString(entry.text, `assembly.${key}[].text`, plugin)
    }
  }
  if (contextsClear && (contextsAdd !== undefined || contextsRemove !== undefined || contextsReplace !== undefined)) {
    throw new TypeError(`${plugin}: assembly.contexts.clear cannot combine with add or remove or replace — clear 已清空全部条目，同时声明语义不明`)
  }
  if (sectionsKeep !== undefined && sectionsRemove !== undefined) {
    throw new TypeError(`${plugin}: assembly.sections cannot combine keep with remove — 一种是白名单、一种是黑名单，同时声明语义不明`)
  }
  return (_ctx, { warnOnce, on, collect, take }) => collect(on('system-prompt/assemble', async (assembly, context, next, _frame, replacementFrame) => {
    const assembled = await next()
    try {
      let result = assembled
      let contextPlan
      const replacedSections = replaceEntries(result.sections, sectionsReplace, 'sections', plugin, warnOnce, replacementFrame?.sections)
      if (replacedSections !== result.sections) result = { ...result, sections: replacedSections }
      if (contextsReplace?.length > 0) {
        contextPlan = Object.freeze({ entries: Object.freeze(contextsReplace.map(entry => Object.freeze({ ...entry,
          ...(Array.isArray(entry.match) ? { match: Object.freeze([...entry.match]) } : {}),
        }))), plugin, warnOnce })
        const contexts = replaceEntries(result.contexts, contextPlan.entries, 'contexts', plugin, warnOnce, replacementFrame?.contexts)
        if (contexts !== result.contexts) result = { ...result, contexts }
      }
      if (Array.isArray(result.sections) && (sectionsAdd !== undefined || sectionsRemove !== undefined || sectionsKeep !== undefined)) {
        const kept = sectionsKeep !== undefined
          ? result.sections.filter((section) => sectionsKeep.has(section?.name))
          : sectionsRemove === undefined
            ? result.sections
            : result.sections.filter((section) => !sectionsRemove.has(section?.name))
        if (kept.length !== result.sections.length || sectionsAdd?.length > 0) {
          result = { ...result, sections: sectionsAdd === undefined ? kept : [...kept, ...sectionsAdd] }
        }
      }
      if (Array.isArray(result.sections) && sectionsAppend !== undefined && sectionsAppend.length > 0) {
        const seen = new Set()
        let nextSections = result.sections
        for (const entry of sectionsAppend) {
          const index = nextSections.findIndex((section) => section?.name === entry.name)
          if (index < 0) {
            warnOnce(`${plugin}: assembly.sections.append target ${JSON.stringify(entry.name)} not found; skipped`)
            continue
          }
          const section = nextSections[index]
          if (typeof section?.text !== 'string') {
            warnOnce(`${plugin}: assembly.sections.append target ${JSON.stringify(entry.name)} has no text; skipped`)
            continue
          }
          const rendered = interpolateVariables(entry.text, {}, context?.agent?.session)
          if (rendered.trim().length === 0 || /\{\{[^}]+\}\}/.test(rendered)) {
            warnOnce(`${plugin}: assembly.sections.append target ${JSON.stringify(entry.name)} rendered empty; skipped`)
            continue
          }
          if (entry.once !== false) {
            const key = `${entry.name}\u0000${rendered}`
            // once 覆盖同一装配内的重复动作/条目；已有贡献者追加过同一段正文时也不重复。
            if (seen.has(key) || section.text.includes(rendered)) continue
            seen.add(key)
          }
          const text = section.text.length === 0 ? rendered : `${section.text}\n${rendered}`
          if (text === section.text) continue
          if (nextSections === result.sections) nextSections = [...result.sections]
          nextSections[index] = { ...section, text }
        }
        if (nextSections !== result.sections) result = { ...result, sections: nextSections }
      }
      if (Array.isArray(result.contexts)) {
        if (contextsClear) {
          if (result.contexts.length > 0) result = { ...result, contexts: [] }
        } else if (contextsAdd !== undefined || contextsRemove !== undefined) {
          const kept = contextsRemove === undefined
            ? result.contexts
            : result.contexts.filter((entry) => !contextsRemove.has(entry?.name))
          if (kept.length !== result.contexts.length || contextsAdd?.length > 0) {
            result = { ...result, contexts: contextsAdd === undefined ? kept : [...kept, ...contextsAdd] }
          }
        }
      }
      const step = toolStepFor(context)
      if (contextPlan !== undefined && step?.status === 'pending') (step.contextReplacements ??= []).push(contextPlan)
      return result !== assembled ? result : assembled
    } catch (error) {
      warnOnce(`${plugin}: assembly action failed, keeping the assembled sections/contexts: ${String(error?.message ?? error)}`)
      return assembled
    }
  }))
}
