import { UNAVAILABLE } from './availability.mjs'
import { agentOf } from './subject.mjs'

export function createSoulPredicate(options = {}, context = {}) {
  if (Object.keys(options).some(key => key !== 'pending') || options.pending !== true) throw new TypeError('predicates: soul requires pending: true')
  const predicate = payload => {
    predicate.soulReminders = []
    if (typeof context.soulReminder?.read !== 'function' || !context.moduleId) return UNAVAILABLE
    const fact = context.soulReminder.read(context.moduleId, agentOf(payload))
    if (fact?.due === true) predicate.soulReminders = [{ ...fact, predicate, moduleId: context.moduleId }]
    return typeof fact?.due === 'boolean' ? fact.due : UNAVAILABLE
  }
  predicate.kind = 'soul'
  return predicate
}
