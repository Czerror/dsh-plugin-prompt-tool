/**
 * assembly —— 只改装配结果的 sections / contexts。
 *
 * 工具可见面（目录、SDK 正文、执行闸）已收进 `tool-visibility`：同一个意图不再分散到
 * 多个动作。`target.tools` 在这里显式拒绝，避免旧声明「编译通过但静默不生效」。
 *
 * 语义保持原样：同层 sections 的 keep 与 remove 互斥；contexts 的 clear 与 add/remove 互斥；
 * 异常一律返回未改动的装配（装配失败不得让会话失去系统段或上下文）。
 */

import { NAME_LIST, requireString } from './shared.mjs'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function prepareAssembly(action, plugin) {
  const target = action.target
  if (!record(target)) {
    throw new TypeError(`${plugin}: assembly requires a target object — { sections } / { contexts }`)
  }
  if (target.tools !== undefined) {
    throw new TypeError(`${plugin}: assembly.target.tools 已移除 — 工具可见面改用 tool-visibility 动作（allow/deny/discovery/notice）`)
  }
  const sectionsAdd = target.sections?.add
  const sectionsRemove = NAME_LIST.parse(target.sections?.remove, plugin, 'assembly.sections.remove')
  const sectionsKeep = NAME_LIST.parse(target.sections?.keep, plugin, 'assembly.sections.keep')
  const contextsAdd = target.contexts?.add
  const contextsRemove = NAME_LIST.parse(target.contexts?.remove, plugin, 'assembly.contexts.remove')
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
  if (contextsClear && (contextsAdd !== undefined || contextsRemove !== undefined)) {
    throw new TypeError(`${plugin}: assembly.contexts.clear cannot combine with add or remove — clear 已清空全部条目，同时声明语义不明`)
  }
  if (sectionsKeep !== undefined && sectionsRemove !== undefined) {
    throw new TypeError(`${plugin}: assembly.sections cannot combine keep with remove — 一种是白名单、一种是黑名单，同时声明语义不明`)
  }
  return (_ctx, { warnOnce, on, collect, take }) => collect(on('system-prompt/assemble', async (assembly, _context, next) => {
    const assembled = await next()
    try {
      let result = assembled
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
      return result !== assembled ? result : assembled
    } catch (error) {
      warnOnce(`${plugin}: assembly action failed, keeping the assembled sections/contexts: ${String(error?.message ?? error)}`)
      return assembled
    }
  }))
}
