import { validateReadLimits, bindReadLimitsDependencies, prepareReadLimits } from './read-limits.mjs'
import { validateDelegationLimits, bindDelegationLimitsDependencies, prepareDelegationLimits } from './delegation-limits.mjs'
import { validateCommandConfine, commandConfineState, installCommandConfine } from './command-confine.mjs'
import { validateRepeatCompactionAction, bindRepeatCompactionDependencies, registerRepeatCompaction } from './repeat-compaction-policy.mjs'
import { validateMessageShapeGuardsAction, bindMessageShapeGuardsDependencies, registerMessageShapeGuards, prepareMessageShapeGuards } from './message-shape-guards.mjs'

// 身份与归属只有这一份；具体值和实际可用性仍由能力实现拥有。
const command = { key: 'command', state: commandConfineState, install: installCommandConfine, channel: 'host:command-confine' }
const repeatCompaction = { key: 'repeatCompaction', prepareOrder: 3, sharedFrame: true, contextOwner: true, needsAssembly: true,
  create: registerRepeatCompaction, dependencyOrder: 9,
  bind: (rule, moduleId, _entries, onOutcome, owner) => bindRepeatCompactionDependencies(rule, moduleId, (action, agent) => owner.status(action, agent), onOutcome),
  prepare: (entries, frame, _preview, owner, context) => { owner.prepare(entries, frame, context) } }
const catalog = new Map([
  ['command-confine-passthrough', { scope: 'process', validate: validateCommandConfine, process: command }],
  ['file-read-limits', { scope: 'agent', validate: validateReadLimits,
    agent: { key: 'readLimits', prepareOrder: 7, needsAssembly: true, preflight: 'before', bind: bindReadLimitsDependencies, prepare: prepareReadLimits, dependencyOrder: 8 } }],
  ['delegation-limits', { scope: 'agent', validate: validateDelegationLimits,
    agent: { key: 'delegationLimits', prepareOrder: 8, needsAssembly: true, preflight: 'before', bind: bindDelegationLimitsDependencies, prepare: prepareDelegationLimits, dependencyOrder: 7 } }],
  ...['repeat-tool-reminder', 'compaction-tool-result-pruner'].map(id => [id, { scope: 'agent', validate: validateRepeatCompactionAction, agent: repeatCompaction }]),
  ['message-shape-guards', { scope: 'agent', validate: validateMessageShapeGuardsAction,
    agent: { key: 'messageShapeGuards', prepareOrder: 1, sharedFrame: true, needsAssembly: true, dependencyOrder: 1,
      create: registerMessageShapeGuards, prepare: prepareMessageShapeGuards,
      bind: (rule, moduleId, _entries, onOutcome) => bindMessageShapeGuardsDependencies(rule, moduleId, onOutcome) } }],
])

export const hostControlDescriptor = action => action?.kind === 'host-control' ? catalog.get(action.capability) : undefined
export const agentHostControls = () => [...new Set([...catalog.values()].flatMap(descriptor => descriptor.agent === undefined ? [] : [descriptor.agent]))]
export const processHostControls = () => [...new Set([...catalog.values()].flatMap(descriptor => descriptor.process === undefined ? [] : [descriptor.process]))]

export function validateHostControl(action) {
  const descriptor = hostControlDescriptor(action)
  if (descriptor === undefined) throw new TypeError('host-control.capability is unsupported')
  descriptor.validate(action)
}
