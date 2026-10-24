/**
 * 分支语法的唯一展开器：只认 `if`/`then`/`else`，旧名 `when`/`do` 由各入口显式拒绝。
 *
 * 严格版服务规则编译（`rule-spec.mjs`）；宽松版 `expandActionsLenient` 只服务展示投影
 * （`rule-facts.mjs`），两者共用 `isBranchNode` / `conjunction` 的分支语义。
 */

import { record } from './record.mjs'

/** 分支节点：占动作位、没有 `kind`，但带 `if`/`then`/`else` 之一。 */
export const isBranchNode = node => record(node) && node.kind === undefined
  && (node.if !== undefined || node.then !== undefined || node.else !== undefined)

/** 多个条件按声明序合取；空数组 = 无条件（`compileWhen(undefined)` 直接返回 undefined）。 */
export function conjunction(conditions) {
  if (conditions.length === 0) return undefined
  return conditions.length === 1 ? conditions[0] : { all: [...conditions] }
}

/** 分支两支的 outer 条件：then 追加 if，else 追加 not(if)；缺 if 时保留父条件。 */
const branchOuters = (node, outer) => ({
  then: node.if === undefined ? outer : [...outer, node.if],
  else: node.if === undefined ? outer : [...outer, { not: node.if }],
})

function walkActions(list, { outer = [], bypass = false, lenient = false, label } = {}) {
  if (!Array.isArray(list)) {
    if (!lenient) throw new TypeError(`${label} must be an array`)
    return []
  }
  const out = []
  for (const [index, node] of list.entries()) {
    const at = `${label}[${index}]`
    if (isBranchNode(node)) {
      if (!lenient) {
        if (node.if === undefined) throw new TypeError(`${at}: a branch needs if`)
        if (node.then === undefined) throw new TypeError(`${at}: a branch needs then`)
      }
      const { then: thenOuter, else: elseOuter } = branchOuters(node, outer)
      if (lenient ? Array.isArray(node.then) : true) {
        out.push(...walkActions(node.then, {
          outer: thenOuter, bypass, lenient,
          ...(lenient ? {} : { label: `${at}.then` }),
        }))
      }
      if (lenient ? Array.isArray(node.else) : node.else !== undefined) {
        out.push(...walkActions(node.else, {
          outer: elseOuter, bypass, lenient,
          ...(lenient ? {} : { label: `${at}.else` }),
        }))
      }
      continue
    }
    if (lenient) {
      if (record(node) && typeof node.kind === 'string') out.push({ node, conditions: outer, bypass })
    } else {
      out.push({ node, conditions: outer, bypass })
    }
  }
  return out
}

/**
 * 把一份动作声明展开为扁平的「动作 + 自身分支条件」列表。
 *
 * - 普通动作原样带出，分支条件 = `outer` 的合取（空 = 无条件）；
 * - 分支节点的 `then` 追加本层 `if`、`else` 追加 `not(if)`——互斥由结构保证，不由作者手写；
 *   有状态谓词（phase / count）还须同时收到 `session/event` 观察（`trigger.mjs` 的
 *   `wireTriggerObservers`）才成立，否则状态停在冷扫那一刻、互斥也就名存实亡；
 * - 返回顺序即声明序（then 在前、else 在后）；
 * - `bypass` 标记该动作来自**声明级** `else`：它的条件已含 `not(if)`，不能再叠加声明级判定。
 */
export function expandActions(list, options = {}, label) {
  return walkActions(list, { ...options, lenient: false, label })
}

/**
 * 宽松展开：只服务展示投影（`rule-facts.mjs`）。
 *
 * 与 `expandActions` 共享同一条 then/else 遍历，但遇到未完成的分支（缺 `if`/`then`）不抛错：
 * 有 `then`/`else` 数组就继续下钻；缺 `if` 时两支都按父条件展开（保守，不伪造否定）。
 */
export function expandActionsLenient(list, options = {}) {
  return walkActions(list, { ...options, lenient: true })
}
