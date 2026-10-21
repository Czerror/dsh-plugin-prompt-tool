import { stringList } from '../fields.mjs'
export const RUN_CODE = 'run_code'

export const NAME_LIST = stringList({ as: 'set', dedupe: true, allowEmpty: true })

/** 动作标签（错误消息与 source.plugin 命名空间）。 */
export const labelOf = (action) => (typeof action?.id === 'string' && action.id.length > 0 ? action.id : String(action?.kind ?? 'action'))

/**
 * 名单判据的唯一实现：presentation 过滤与执行 guard 共用（呈现与执行不得两套口径）。
 *
 * 第四个参数 `allowExtra` 是**可选的活集合**（`assembly.tools.allowFrom` 的动态白名单）：
 * 调用方持有它，在每个请求解析完历史工具调用后 `clear()` + 填充。它**只做加法**——多一个
 * 名字就多一个工具通过，永远不能剔除任何工具。这不是巧合，而是判据方向决定的：`blocks()`
 * 的语义是「**在** allow 里就放行」，所以任何动态集合都只可能解锁。
 *
 * 未声明静态 `allow`、只声明 `allowFrom` 时，allow 视为空集（`blocks` 仍会裁掉没被解锁的）。
 */
export function createMask(source, label, plugin, allowExtra) {
  const allow = NAME_LIST.parse(source?.allow, plugin, `${label}.allow`)
  const deny = NAME_LIST.parse(source?.deny, plugin, `${label}.deny`)
  // allow 与 deny 可以同时给：官方 ToolRestriction 就是 and/or，判据是「先按 allow 保留，
  // 再按 deny 剔除」（deepseek-harness packages/core/tools/src/index.ts:701-706、759-765）。
  if (allow === undefined && deny === undefined && allowExtra === undefined) {
    throw new TypeError(`${plugin}: ${label} needs allow and/or deny — 空名单无法表达「剔哪些工具」`)
  }
  // `run_code` 是 PTC 呈现**唯一**的可调用入口（见本文件顶部）。把它写进 **deny** 名单会让
  // 整个 PTC 面失效，一律挂载期拒绝。allow 名单不必点名它：它是保留传输，不属于可裁剪的
  // 工具面；旧模块、tool-surface 这类 native 收窄声明因此可以直接与 PTC 共存。
  if (deny?.has(RUN_CODE)) {
    throw new TypeError(`${plugin}: ${label}.deny must not name the reserved ${RUN_CODE} transport — it is the only callable entry of the PTC presentation`)
  }
  return {
    /** 静态 allow（原样保留；动态项不并入，免得调用方误以为它是静态声明）。 */
    allow,
    deny,
    /** 动态白名单的落点（活集合，由调用方每轮重填）；未声明 allowFrom 时不存在。 */
    allowExtra,
    /**
     * fail-open 兜底开关（**可选**，缺省 false）：原 `tool-bootstrap` 的语义是
     * 「keep 名单里的工具在本次装配目录里一个都不存在 → 放弃裁剪、暴露完整目录」，而原
     * `tool-filter` 的同名场景是**照名单裁成空目录**。两种语义都真实存在，所以这里
     * **不设默认**——要兜底的声明自己写 `requireMatch: true`。把某一个模块的特有语义当成
     * 通用默认，会让另一个声明路径的行为被悄悄改掉（这正是对拍抓出来的）。
     */
    requireMatch: source?.requireMatch === true,
    /** 与 tool-filter 的名单判据 / Layer.admits 同一判据（tool-filter 模块已删除，判据保留）。 */
    blocks: (toolName) => {
      if (typeof toolName !== 'string' || toolName.length === 0) return false
      // 保留传输不参与任何名单：allow 没点名也必须留下，deny 已在挂载期拒绝。
      if (toolName === RUN_CODE) return false
      if (deny !== undefined && deny.has(toolName)) return true
      if (allowExtra?.has(toolName) === true) return false
      // 声明了 allow、或声明了 allowFrom（= 白名单模式，静态名单视为空集），未点名即裁掉。
      return (allow !== undefined || allowExtra !== undefined) && allow?.has(toolName) !== true
    },
  }
}

export function requireString(value, label, plugin) {
  if (typeof value !== 'string') throw new TypeError(`${plugin}: ${label} must be a string`)
  return value
}
