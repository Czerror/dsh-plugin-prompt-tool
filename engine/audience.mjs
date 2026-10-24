/**
 * 条件树 → 受众事实：规则级与动作级受众判据的唯一实现。
 *
 * 纯函数，只依赖纯算子清单；不 import `conditions/index.mjs`（那会经 preset 拉入宿主包）。
 * 返回值 undefined = 无法静态收窄，由调用方按保守方向处理。
 */
import { COMPOSITE_OPERATORS } from './conditions/operators.mjs'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 全部受众；只在本模块内部使用，避免把常量扩成第二个公共接口。 */
const AUDIENCE_ALL = Object.freeze(['main', 'subagent'])

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
    if (audience === 'main' || audience === 'subagent') {
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
          audiences = new Set([...audiences].filter((audience) => childInfo.audiences.has(audience)))
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
        return { audiences: new Set(AUDIENCE_ALL.filter((audience) => !childInfo.audiences.has(audience))), exact: true }
      }
      case 'notAny': {
        const childInfo = audienceInfo({ any: value })
        if (childInfo === undefined || !childInfo.exact) return undefined
        return { audiences: new Set(AUDIENCE_ALL.filter((audience) => !childInfo.audiences.has(audience))), exact: true }
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
