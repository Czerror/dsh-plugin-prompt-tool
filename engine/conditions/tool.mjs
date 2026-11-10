import { UNAVAILABLE } from './availability.mjs'
import { agentOf } from './subject.mjs'
import { toolStepFor } from '../tool-scope.mjs'
import { toolDependenciesReady } from '../tool-definition.mjs'

export function createToolPredicate(options = {}, context = {}) {
  if (Object.keys(options).some(key => key !== 'name') || typeof options.name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(options.name)) throw new TypeError('predicates: tool needs a valid name')
  const predicate = payload => {
    const agent = agentOf(payload)
    const tools = context.ctx?.get?.('tools')
    const input = payload?.channel === 'system-prompt/assemble' ? payload.args?.[1] : payload?.args?.[0] ?? payload
    const step = toolStepFor(input, agent)
    if (agent === undefined || typeof tools?.executable !== 'function' || step == null || step.status === 'closed') return UNAVAILABLE
    const definition = tools.executable(options.name, agent, step.toolSet)
    return definition === undefined || !toolDependenciesReady(tools, definition, agent, step.toolSet) ? UNAVAILABLE : true
  }
  predicate.kind = 'tool'
  return predicate
}
