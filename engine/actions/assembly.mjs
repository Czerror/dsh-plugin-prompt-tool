import { NAME_LIST, createMask, labelOf, requireString } from './shared.mjs'
import { sessionEvents } from '../shared.mjs'

/**
 * 动态白名单：从**本会话已持久化的** `tool/call` 事件里回收解锁名单，填入 `into`。
 *
 * 语义对齐原 `tool-bootstrap.mjs` 的 `unlockedFor(session)`：某个发现工具（如
 * `dev_tool_search`）上一次调用时把要解锁的工具名写进了自己的调用参数，本函数把它读回来
 * 填入 allow，于是**解锁能跨请求保留**——没有它，解锁是一次性的（当次请求用完即被裁掉）。
 *
 * 判据刻意保守，坏数据只影响该条、绝不上抛：
 *  - 只认 `event.type === 'tool/call'` 且 `event.data.name` **精确等于**声明里的 `tool`；
 *  - `arguments` 是模型产出的任意字符串，`JSON.parse` 必须 try/catch；解析出的必须是对象；
 *  - 只取 `key` 指向的**字符串数组**里的字符串项，非字符串项逐项丢弃，不展开对象、不 eval；
 *  - 任一步不成立就跳过该条事件，其余事件照常累积；全程无异常（读事件本身除外，由调用方兜）。
 *
 * `tool` / `key` **按参数传入**而不是向外层读取——这个模块会被多个 assembly 动作各挂一次，
 * 任何模块级可变状态都会让它们互相覆盖。
 */
function fillUnlocked(into, session, tool, key, warnOnce, plugin, label) {
  into.clear()
  let events
  try {
    events = sessionEvents(session)
  } catch (error) {
    warnOnce(`${plugin}: assembly action ${label}: reading session events for allowFrom failed: ${String(error?.message ?? error)}`)
    return
  }
  for (const event of events) {
    if (event?.type !== 'tool/call' || event?.data?.name !== tool) continue
    const raw = event.data.arguments
    const parsed = typeof raw === 'string' ? safeParse(raw) : raw
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const value = parsed[key]
    if (!Array.isArray(value)) continue
    for (const item of value) if (typeof item === 'string' && item.length > 0) into.add(item)
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function prepareAssembly(action, plugin) {
  const target = action.target
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    throw new TypeError(`${plugin}: assembly requires a target object — { tools } / { sections } / { contexts }`)
  }
  const toolsSource = target.tools
  const allowFrom = toolsSource?.allowFrom
  let allowExtra
  if (allowFrom !== undefined) {
    if (allowFrom === null || typeof allowFrom !== 'object' || Array.isArray(allowFrom)) {
      throw new TypeError(`${plugin}: assembly.tools.allowFrom must be an object — { tool, key }`)
    }
    requireString(allowFrom.tool, 'assembly.tools.allowFrom.tool', plugin)
    requireString(allowFrom.key, 'assembly.tools.allowFrom.key', plugin)
    // deny 是黑名单、动态项只做加法，同声明的语义不可解释（且 allowFrom 已经覆盖不了 deny
    // 的名字到底该不该出现），挂载期直接拒，而不是运行期猜。
    if (Array.isArray(toolsSource.deny) && toolsSource.deny.length > 0) {
      throw new TypeError(`${plugin}: assembly.tools cannot combine deny with allowFrom — 动态项只做加法，与黑名单语义冲突`)
    }
    allowExtra = new Set()
  }
  const tools = toolsSource === undefined ? undefined : createMask(toolsSource, 'assembly.tools', plugin, allowExtra)
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
  // clear 与 add/remove 并存时旧实现静默丢掉 add/remove（零告警）；这与 sections 的
  // keep+remove 是同一类不可解释组合，同为挂载期 fail loud。非布尔 clear 也一并拒：
  // 旧判据 `=== true` 会把 `'true'` / `1` 静默当 false，clear 整体失效。
  if (target.contexts?.clear !== undefined && typeof target.contexts.clear !== 'boolean') {
    throw new TypeError(`${plugin}: assembly.contexts.clear must be boolean`)
  }
  const contextsClear = target.contexts?.clear === true
  if (contextsClear && (contextsAdd !== undefined || contextsRemove !== undefined)) {
    throw new TypeError(`${plugin}: assembly target.contexts cannot combine clear with add or remove — clear 已清空全部条目，同时声明语义不明`)
  }
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
        // 每轮重算解锁名单：本轮装配要反映**本会话至今**的全部解锁调用。
        if (allowExtra !== undefined) {
          fillUnlocked(allowExtra, context?.session ?? context?.agent?.session, allowFrom.tool, allowFrom.key, warnOnce, plugin, labelOf(action))
        }
        // keep 名单兜底（2026-09-22 用户拍板，**可选**）：判据与原 `tool-bootstrap` 逐条对齐——
        // 原模块是 `missing = required.filter(t => !available.has(t))`
        // 且 `missing.length > 0` 即放弃裁剪，也就是「**任意一个** 名单工具缺失」而不是
        // 「一个都不存在」（对拍实测：目录 `[bash,read]` + 名单 `[bash,str_replace_editor]` 时
        // 原模块给完整目录，只判"全缺"会裁成 `[bash]`）。
        // 声明写 `requireMatch: true` 才启用；**不写就照名单裁**（与 `tool-filter.mjs` 一致）。
        const available = new Set(result.tools.map((tool) => tool?.name).filter((name) => typeof name === 'string'))
        // 必需名单 = 静态 allow ∪ 本轮解锁项：解锁项同样是「本该存在」的工具，缺了就 fail-open。
        const required = tools.allow === undefined && allowExtra === undefined
          ? undefined
          : new Set([...(tools.allow ?? []), ...(allowExtra ?? [])])
        const missingRequired = tools.requireMatch && required !== undefined
          && [...required].some((name) => !available.has(name))
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
