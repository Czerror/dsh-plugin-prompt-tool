/** 声明编辑目录：类别、支持面和执行点来自实际编译器，示例仅提供可编辑的起点。 */
import { ACTION_KINDS, actionExecutionPoint, actionSupportsWhen } from './actions.mjs'
import { COMPOSITE_OPERATORS, PREDICATE_FACTORIES, compileDeclaration, compileWhen } from './trigger-spec.mjs'
import { WATERFALL_POSITIONS } from './trigger.mjs'

import { PREDICATE_EXAMPLES } from './conditions/examples.mjs'
import { ACTION_EXAMPLES } from './actions/examples.mjs'

/** 每次返回独立的纯数据；调用方编辑草稿不会污染后续请求或引擎目录。 */
export function getTriggerEditorMeta() {
  const predicates = Object.keys(PREDICATE_FACTORIES).map((kind) => {
    if (!Object.hasOwn(PREDICATE_EXAMPLES, kind)) throw new TypeError(`trigger-editor-meta: missing ${kind} predicate example`)
    return { kind, example: { [kind]: structuredClone(PREDICATE_EXAMPLES[kind]) } }
  })
  for (const kind of COMPOSITE_OPERATORS) {
    const child = { phase: { promoted: false } }
    predicates.push({ kind, example: { [kind]: kind === 'not' ? child : [child] } })
  }
  for (const { example } of predicates) compileWhen(example)

  const actions = Object.keys(ACTION_KINDS).map((kind) => {
    if (!Object.hasOwn(ACTION_EXAMPLES, kind)) throw new TypeError(`trigger-editor-meta: missing ${kind} action example`)
    const example = { kind, ...structuredClone(ACTION_EXAMPLES[kind]) }
    const { channel, phase } = actionExecutionPoint(example)
    compileDeclaration({ id: kind, channel, phase, do: example })
    return { kind, example, channel, phase, supportsWhen: actionSupportsWhen(kind) }
  })
  return { predicates, actions, composites: [...COMPOSITE_OPERATORS], waterfallPositions: [...WATERFALL_POSITIONS] }
}
