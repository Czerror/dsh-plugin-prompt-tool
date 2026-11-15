import { hostControlDescriptor, processHostControls } from './host-control-catalog.mjs'

/** Process contributions outlive individual Agents; the caller owns the publication boundary. */
export function createProcessHostControls(ctx, record) {
  const sources = new Map()
  const installations = new Map()
  const disposers = new Map()
  return {
    async publish(id, item, isActive) {
      const rules = item?.rules.filter(rule => rule.executionScope === 'process' && rule.enabled !== false) ?? []
      const actions = rules.flatMap(rule => rule.actions)
      for (const owner of processHostControls()) {
        if (!owner.install || !actions.some(action => hostControlDescriptor(action)?.process === owner)) continue
        if (!installations.has(owner)) {
          installations.set(owner, (async () => {
            try { disposers.set(owner, await owner.install(ctx)) }
            catch { installations.delete(owner) } // Optional owner resolution is retried on the next publication.
          })())
        }
        await installations.get(owner)
      }
      if (!isActive()) return
      const releases = item === null ? [] : processHostControls().map(owner => owner.state.replace(id,
        actions.filter(action => hostControlDescriptor(action)?.process === owner).map(({ capability, value }) => ({ capability, value }))))
      sources.get(id)?.()
      if (item === null) sources.delete(id)
      else sources.set(id, () => { for (const release of releases) release() })
      for (const rule of rules) for (const action of rule.actions) {
        const owner = hostControlDescriptor(action).process
        const status = owner.state.status(action.capability)
        record({ moduleId: id, ruleId: rule.id, actionId: action.id, channel: owner.channel,
          definitionRevision: rule.definitionRevision, outcome: status.available ? 'hit' : 'unavailable',
          identityOutcome: status.available ? 'matched' : 'condition-unavailable', reason: status.reason })
      }
    },
    retain(ids) {
      for (const [id, release] of sources) if (!ids.includes(id)) { release(); sources.delete(id) }
    },
    withdraw() {
      for (const release of sources.values()) release()
      sources.clear()
    },
    async dispose() { for (const dispose of disposers.values()) await dispose() },
  }
}
