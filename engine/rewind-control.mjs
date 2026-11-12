const owners = new WeakMap()

export const isRewindAction = action => action?.kind === 'host-control' && ['session-rewind', 'session-rewind-todos'].includes(action.capability)
export function validateRewindAction(action) {
  if (action.value !== true || action.maxPerTurn !== undefined) throw new TypeError(`${action.capability} requires value: true and no maxPerTurn`)
}
export function registerRewindControl(agent, enabled) {
  const owner = { enabled }
  owners.set(agent, owner)
  return () => { if (owners.get(agent) === owner) owners.delete(agent) }
}
export function rewindEnabled(agent, capability = 'session-rewind') { return owners.get(agent)?.enabled(capability) === true }
