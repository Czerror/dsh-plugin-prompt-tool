import { NAME_LIST, labelOf, createMask, requireString } from './shared.mjs'

export function prepareAssembly(action, plugin) {
  const target = action.target
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    throw new TypeError(`${plugin}: assembly requires a target object — { tools } / { sections } / { contexts }`)
  }
  const tools = target.tools === undefined ? undefined : createMask(target.tools, 'assembly.tools', plugin)
  const sectionsAdd = target.sections?.add
  const sectionsRemove = NAME_LIST.parse(target.sections?.remove, plugin, 'assembly.sections.remove')
  // 白名单（2026-09-22 用户拍板「扩动作库」）：`personaSectionsOnly` 一类的语义是
  // `filter(白名单)`，而 remove 是黑名单——未列名的第三方/晚到段不会被它删掉。
  // 两种语义**互斥**：同时声明即挂载期 fail loud，而不是静默二选一。
  const sectionsKeep = NAME_LIST.parse(target.sections?.keep, plugin, 'assembly.sections.keep')
  if (sectionsKeep !== undefined && sectionsRemove !== undefined) {
    throw new TypeError(`${plugin}: assembly target.sections cannot combine keep with remove — 一种是白名单、一种是黑名单，同时声明语义不明`)
  }
  const contextsAdd = target.contexts?.add
  const contextsRemove = NAME_LIST.parse(target.contexts?.remove, plugin, 'assembly.contexts.remove')
  const contextsClear = target.contexts?.clear === true
  for (const [key, list] of [['sections.add', sectionsAdd], ['contexts.add', contextsAdd]]) {
    if (list === undefined) continue
    if (!Array.isArray(list)) throw new TypeError(`${plugin}: assembly.${key} must be an array of { name, text }`)
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') throw new TypeError(`${plugin}: assembly.${key} entries must be objects`)
      requireString(entry.name, `assembly.${key}[].name`, plugin)
      requireString(entry.text, `assembly.${key}[].text`, plugin)
    }
  }
  return (_ctx, { warnOnce, on, collect, take }) => collect(on('system-prompt/assemble', async (assembly, context, next) => {
    // Downstream errors propagate untouched; only this action's own logic is guarded.
    const assembled = await next()
    try {
      if (typeof action.match === 'function' && action.match(context, assembled) !== true) return assembled
      let result = assembled
      if (tools !== undefined && Array.isArray(result.tools)) {
        // keep 名单兜底（2026-09-22 用户拍板，**可选**）：判据与原 `tool-bootstrap` 逐条对齐——
        // 原模块是 `missing = required.filter(t => !available.has(t))`
        // 且 `missing.length > 0` 即放弃裁剪，也就是「**任意一个** 名单工具缺失」而不是
        // 「一个都不存在」（对拍实测：目录 `[bash,read]` + 名单 `[bash,str_replace_editor]` 时
        // 原模块给完整目录，只判"全缺"会裁成 `[bash]`）。
        // 声明写 `requireMatch: true` 才启用；**不写就照名单裁**（与 `tool-filter.mjs` 一致）。
        const available = new Set(result.tools.map((tool) => tool?.name).filter((name) => typeof name === 'string'))
        const missingRequired = tools.requireMatch && tools.allow !== undefined
          && [...tools.allow].some((name) => !available.has(name))
        if (missingRequired) {
          warnOnce(`${plugin}: assembly action ${labelOf(action)}: a requireMatch tool is absent — exposing the full tool set (fail-open)`)
        } else {
          const kept = result.tools.filter((tool) => !tools.blocks(tool?.name))
          if (kept.length !== result.tools.length) result = { ...result, tools: kept }
        }
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
      return result !== assembled && take(context) ? result : assembled
    } catch (error) {
      warnOnce(`${plugin}: assembly action ${labelOf(action)} failed, exposing the full assembly: ${String(error?.message ?? error)}`)
      return assembled
    }
  }))
}
