/**
 * 条件树 → 受众事实：规则级与动作级受众判据的唯一实现。
 *
 * 纯函数，只依赖纯算子清单；不 import `conditions/index.mjs`（那会经 preset 拉入宿主包）。
 * 返回值 undefined = 无法静态收窄，由调用方按保守方向处理。
 */
import { COMPOSITE_OPERATORS } from './conditions/operators.mjs'
import { record } from './record.mjs'

/** 全部受众；rule-spec 的 action 回退与 audienceInfo 共用这一份。 */
export const AUDIENCE_ALL = Object.freeze(['main', 'subagent'])

/** 受众成员判据；与 AUDIENCE_ALL 同源，避免各处手写两个字符串比较。 */
export const isAudience = value => AUDIENCE_ALL.includes(value)

/** 两个受众集合求交；undefined = 无法收窄，取交集时让位于已知集合。 */
export function intersectAudiences(left, right) {
  if (left === undefined) return right
  if (right === undefined) return left
  return new Set([...left].filter(audience => right.has(audience)))
}

/** 精确受众集合的补集；只在 not/notAny 的精确子节点上使用。 */
const complementAudiences = audiences => new Set(AUDIENCE_ALL.filter(audience => !audiences.has(audience)))

/**
 * 条件树 → 受众上下界；`exact` 表示结果是否能安全取补。
 *
 * `all` 求交时跳过无法收窄的子条件：AND 只会更窄，结果仍是「可能命中」的上界，
 * 但不再精确——此时取补会错误排除受众，所以 `not` / `notAny` 遇非精确子节点返回未知。
 * `any` 任一分支不精确即整体未知（保守）。
 */
function audienceInfo(tree) {
  if (!record(tree)) return undefined
  if (record(tree.scope)) {
    const { audience, modelScope } = tree.scope
    // 同节点带 pro/flash 时结果还依赖模型，不能取补；缺省与 all 只按受众收窄。
    if (isAudience(audience)) {
      return { audiences: new Set([audience]), exact: modelScope === undefined || modelScope === 'all' }
    }
  }
  for (const operator of COMPOSITE_OPERATORS) {
    const value = tree[operator]
    if (value === undefined) continue
    // 非法形状（`all: null` 之类）不猜语义：按无法收窄处理，与重构前的宿主判据一致。
    if (operator !== 'not' && !Array.isArray(value)) return undefined
    switch (operator) {
      case 'all': {
        let audiences = new Set(AUDIENCE_ALL)
        let exact = true
        for (const child of value) {
          const childInfo = audienceInfo(child)
          if (childInfo === undefined) {
            exact = false
            continue
          }
          audiences = intersectAudiences(audiences, childInfo.audiences)
          if (!childInfo.exact) exact = false
        }
        return { audiences, exact }
      }
      case 'any': {
        const audiences = new Set()
        for (const child of value) {
          const childInfo = audienceInfo(child)
          if (childInfo === undefined || !childInfo.exact) return undefined
          for (const audience of childInfo.audiences) audiences.add(audience)
        }
        return { audiences, exact: true }
      }
      case 'not': {
        const childInfo = audienceInfo(value)
        if (childInfo === undefined || !childInfo.exact) return undefined
        return { audiences: complementAudiences(childInfo.audiences), exact: true }
      }
      case 'notAny': {
        const childInfo = audienceInfo({ any: value })
        if (childInfo === undefined || !childInfo.exact) return undefined
        return { audiences: complementAudiences(childInfo.audiences), exact: true }
      }
      default:
        // 新算子未声明受众语义：不收窄，交给调用方保守处理。
        return undefined
    }
  }
  return undefined
}

/**
 * 条件树 → 受众事实：这条规则可能作用于哪些受众。
 *
 * `undefined` = 无法静态收窄，由调用方按保守方向处理。语义与 AND/OR 一致：
 * - `all` 求交：AND 只会更窄，无法收窄的子条件不扩大结果（结果是上界，不可取补）；
 * - `any` 保守：任一分支无法收窄，整体就无法排除另一个受众；
 * - `not` / `notAny` 只对精确子节点取补；`scope.audience` 是唯一能精确收窄的谓词。
 *
 * 算子集合来自 `COMPOSITE_OPERATORS`（与 `compileWhen` / `composite` 同源）；
 * 新增算子若没补受众语义，`test/engine/rule-audiences.test.mjs` 的映射表先红。
 */
export function audienceOf(tree) {
  return audienceInfo(tree)?.audiences
}
