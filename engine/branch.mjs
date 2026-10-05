/**
 * 分支语法的唯一展开器：只认 `if`/`then`/`else`，旧名 `when`/`do` 由各入口显式拒绝。
 *
 * 规则（`rule-spec.mjs`）与触发器声明（`trigger-spec.mjs`）共用这一份实现——
 * 两套入口必须是同一套语义，否则同一个模块换个入口就换行为。
 */

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 分支节点：占动作位、没有 `kind`，但带 `if`/`then`/`else` 之一。 */
export const isBranchNode = node => record(node) && node.kind === undefined
  && (node.if !== undefined || node.then !== undefined || node.else !== undefined)

/** 多个条件按声明序合取；空数组 = 无条件（`compileWhen(undefined)` 直接返回 undefined）。 */
export function conjunction(conditions) {
  if (conditions.length === 0) return undefined
  return conditions.length === 1 ? conditions[0] : { all: [...conditions] }
}

/**
 * 把一份动作声明展开为扁平的「动作 + 自身分支条件」列表。
 *
 * - 普通动作原样带出，分支条件 = `outer` 的合取（空 = 无条件）；
 * - 分支节点的 `then` 追加本层 `if`、`else` 追加 `not(if)`——互斥由结构保证，不由作者手写；
 * - 返回顺序即声明序（then 在前、else 在后）；
 * - `bypass` 标记该动作来自**声明级** `else`：它的条件已含 `not(if)`，不能再叠加声明级判定。
 */
export function expandActions(list, options = {}, label) {
  if (!Array.isArray(list)) throw new TypeError(`${label} must be an array`)
  const { outer = [], bypass = false } = options
  const out = []
  for (const [index, node] of list.entries()) {
    const at = `${label}[${index}]`
    if (isBranchNode(node)) {
      if (node.if === undefined) throw new TypeError(`${at}: a branch needs if`)
      if (node.then === undefined) throw new TypeError(`${at}: a branch needs then`)
      out.push(...expandActions(node.then, { outer: [...outer, node.if], bypass }, `${at}.then`))
      if (node.else !== undefined) out.push(...expandActions(node.else, { outer: [...outer, { not: node.if }], bypass }, `${at}.else`))
      continue
    }
    out.push({ node, conditions: outer, bypass })
  }
  return out
}
