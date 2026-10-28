/**
 * manifest 谓词：规则读取来源模块 `assets/manifest.yml` 的 checks 事实。
 *
 * 读取器由宿主装配经 options 在挂载期绑定，结果缓存 1000ms，清单戳变化提前失效；
 * 读取器缺失、清单缺失/损坏都判 UNAVAILABLE——不能经 not 反转，也不能当「检查失败」。
 */
import { UNAVAILABLE } from './availability.mjs'

/**
 * @param {{ ok?: boolean }} options
 * @param {{ manifestCheck?: { read: (moduleId: string) => boolean | undefined }, moduleId?: string }} [context]
 */
export function createManifestPredicate(options = {}, context = {}) {
  const unknown = Object.keys(options).filter((key) => key !== 'ok')
  if (unknown.length > 0) throw new TypeError(`predicates: manifest does not take ${unknown.join(', ')}`)
  if (typeof options.ok !== 'boolean') throw new TypeError('predicates: manifest ok must be a boolean')
  const expected = options.ok
  const reader = context.manifestCheck
  const moduleId = context.moduleId
  const predicate = () => {
    if (reader === undefined || typeof reader.read !== 'function') return UNAVAILABLE
    if (typeof moduleId !== 'string' || moduleId.length === 0) return UNAVAILABLE
    const observed = reader.read(moduleId)
    return typeof observed === 'boolean' ? observed === expected : UNAVAILABLE
  }
  predicate.kind = 'manifest'
  return predicate
}
