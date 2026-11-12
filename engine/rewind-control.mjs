const owners = new WeakMap()

export const isRewindAction = action => action?.kind === 'host-control' && action.capability === 'session-rewind'
export function validateRewindAction(action) {
  if (action.value !== true || action.maxPerTurn !== undefined) throw new TypeError('session-rewind requires value: true and no maxPerTurn')
}
export function registerRewindControl(agent, enabled) {
  const owner = { enabled }
  owners.set(agent, owner)
  return () => { if (owners.get(agent) === owner) owners.delete(agent) }
}
export function rewindEnabled(agent) { return owners.get(agent)?.enabled() === true }
