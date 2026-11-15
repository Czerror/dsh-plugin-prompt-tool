import { agentHostControls, hostControlDescriptor } from './host-control-catalog.mjs'

/** 来源寿命由运行时的 record 拥有；不保存另一份 Agent 或步骤状态。 */
export function createHostControlAgent(records, onOutcome, agent, ctx, eventFrame) {
  const controls = agentHostControls()
  const entries = key => [...records()].flatMap(record => record.hostControls.get(key) ?? [])
  const owners = new Map(controls.filter(control => control.create !== undefined).map(control => {
    const owner = agent === undefined && !control.contextOwner ? undefined : control.create(agent, ctx, onOutcome, () => entries(control.key), eventFrame)
    if (control.contextOwner && typeof ctx?.effect === 'function') ctx.effect(() => () => owner?.dispose())
    return [control.key, owner]
  }))
  return {
    source() { return new Map(controls.map(({ key }) => [key, []])) },
    collect(record, entry) {
      const descriptor = hostControlDescriptor(entry.action)?.agent
      if (descriptor === undefined) return false
      record.hostControls.get(descriptor.key).push(entry)
      return true
    },
    has(record) { return controls.some(control => control.needsAssembly && record.hostControls.get(control.key).length > 0) },
    bind(rule, moduleId) {
      for (const descriptor of [...controls].sort((a, b) => a.dependencyOrder - b.dependencyOrder)) descriptor.bind?.(rule, moduleId, () => entries(descriptor.key), onOutcome, owners.get(descriptor.key))
    },
    preflight(frame, position) {
      for (const control of controls) if (control.preflight === position) {
        control.prepare(entries(control.key), frame(), true, owners.get(control.key))
      }
    },
    prepare(frame, step, context) {
      const policyFrame = frame()
      for (const { key, prepare, requiresStep, sharedFrame } of controls.filter(control => control.prepareOrder !== undefined).sort((a, b) => a.prepareOrder - b.prepareOrder)) {
        if (requiresStep && step == null) continue
        const plan = prepare(entries(key), sharedFrame ? policyFrame : frame(), false, owners.get(key), context)
        if (plan === undefined) continue
        if (step != null) { step[key] = plan.values; step[`${key}Observations`] = plan.observations }
      }
    },
    observe(step) {
      for (const { key } of controls) for (const observation of step?.[`${key}Observations`] ?? []) {
        try { onOutcome?.(observation) } catch { /* 只读诊断不改变已接受装配 */ }
      }
    },
    reset() { for (const owner of owners.values()) owner?.reset?.() },
    dispose() { for (const owner of owners.values()) owner?.dispose() },
  }
}
