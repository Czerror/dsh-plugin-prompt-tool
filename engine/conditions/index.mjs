import { createTextPredicate } from './text.mjs'
import { createPhasePredicate } from './phase.mjs'
import { createSourcePredicate } from './source.mjs'
import { createCountPredicate } from './count.mjs'
import { createNameListPredicate } from './names.mjs'
import { createSessionStatePredicate } from './session.mjs'
import { createPresetPredicate } from './preset.mjs'
import { createScopePredicate } from './scope.mjs'
import { createAnchorPredicate } from './anchor.mjs'
import { withAvailableInput } from './availability.mjs'
import { composite } from './composite.mjs'
export * from './text.mjs'
export * from './phase.mjs'
export * from './source.mjs'
export * from './count.mjs'
export * from './names.mjs'
export * from './session.mjs'
export * from './preset.mjs'
export * from './scope.mjs'
export * from './anchor.mjs'
export { subjectOf } from './subject.mjs'
export { composite } from './composite.mjs'
export const PREDICATE_FACTORIES = Object.freeze({
  text: createTextPredicate,
  phase: createPhasePredicate,
  source: createSourcePredicate,
  count: createCountPredicate,
  names: createNameListPredicate,
  session: createSessionStatePredicate,
  preset: createPresetPredicate,
  scope: createScopePredicate,
  anchor: createAnchorPredicate,
})
export const COMPOSITE_OPERATORS = Object.freeze(['any', 'all', 'not', 'notAny'])

const objectOrUndefined = (value, label) => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`trigger-spec: ${label} must be an object`)
  }
  return value
}

export function compileWhen(node, context = {}) {
  if (node === undefined || node === null) return undefined
  if (typeof node !== 'object' || Array.isArray(node)) {
    throw new TypeError('trigger-spec: when must be an object (a composite node or a predicate node)')
  }
  const keys = Object.keys(node)
  if (keys.length === 0) {
    throw new TypeError('trigger-spec: when must not be an empty object — 空节点是「恒真」还是「写漏了」无法区分')
  }
  if (keys.length > 1) {
    throw new TypeError(
      `trigger-spec: when must declare exactly one key — got ${keys.sort().join(', ')}`
      + `（allowed: ${[...COMPOSITE_OPERATORS, ...Object.keys(PREDICATE_FACTORIES)].sort().join(', ')}）`,
    )
  }
  const [key] = keys
  const value = node[key]

  if (COMPOSITE_OPERATORS.includes(key)) {
    if (key === 'not') {
      return composite({ not: compileWhen(value, context) })
    }
    if (!Array.isArray(value) || value.length === 0) {
      throw new TypeError(`trigger-spec: when.${key} must be a non-empty array of nodes`)
    }
    return composite({ [key]: value.map((child) => compileWhen(child, context)) })
  }

  const factory = PREDICATE_FACTORIES[key]
  if (factory === undefined) {
    throw new TypeError(
      `trigger-spec: unknown predicate ${JSON.stringify(key)}`
      + ` — known predicates: ${Object.keys(PREDICATE_FACTORIES).join(', ')}; composite: ${COMPOSITE_OPERATORS.join(', ')}`,
    )
  }
  const options = objectOrUndefined(value, `when.${key}`) ?? {}
  // `preset` 原语的取法需要挂载期注入（见 predicates.mjs 的三条硬约束），其余原语只用选项。
  if (key === 'preset') {
    return withAvailableInput(key, options, createPresetPredicate({ ...options, ctx: context.ctx, standingMountFor: context.standingMountFor }))
  }
  return withAvailableInput(key, options, factory(options))
}
