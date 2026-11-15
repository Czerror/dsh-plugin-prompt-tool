import { actionMatches } from './conditions/evaluation.mjs'

const owners = new WeakMap()

export function validateRewindAction(action) {
  if (action.value !== true || action.maxPerTurn !== undefined) throw new TypeError(`${action.capability} requires value: true and no maxPerTurn`)
}
export function registerRewindControl(agent, enabled) {
  const owner = { enabled }
  owners.set(agent, owner)
  return () => { if (owners.get(agent) === owner) owners.delete(agent) }
}
export function registerRewindAgent(agent, _ctx, _onOutcome, entries, eventFrame) {
  const dispose = registerRewindControl(agent, capability => entries().some(entry => entry.action.capability === capability
    && actionMatches(entry, eventFrame('system-prompt/assemble', [{}, { agent }]))))
  return { dispose }
}
export function rewindEnabled(agent, capability = 'session-rewind') { return owners.get(agent)?.enabled(capability) === true }
