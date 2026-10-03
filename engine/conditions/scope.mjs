import { isDelegated, matchesModel } from '../shared.mjs'
import { agentOf } from './subject.mjs'

export function createScopePredicate(options = {}) {
  if (options.audience !== undefined && !['main', 'subagent'].includes(options.audience)) throw new TypeError('scope.audience must be main or subagent')
  if (options.modelScope !== undefined && !['all', 'pro', 'flash'].includes(options.modelScope)) throw new TypeError('scope.modelScope must be all, pro or flash')
  const predicate = payload => {
    const agent = agentOf(payload)
    const session = payload?.session ?? agent?.session
    if (options.audience !== undefined) {
      if (session === undefined) return false
      if ((options.audience === 'subagent') !== isDelegated(session)) return false
    }
    return matchesModel(options.modelScope ?? 'all', payload?.model ?? agent?.options?.model)
  }
  predicate.kind = 'scope'
  return predicate
}
