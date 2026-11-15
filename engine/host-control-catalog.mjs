import { validateReadLimits, bindReadLimitsDependencies, prepareReadLimits } from './read-limits.mjs'
import { validateDelegationLimits, bindDelegationLimitsDependencies, prepareDelegationLimits } from './delegation-limits.mjs'
import { validateFilesystemPolicy, bindFilesystemPolicyDependencies, prepareFilesystemPolicy } from './filesystem-policy.mjs'
import { validateApprovalDecisions, bindApprovalDecisionsDependencies, prepareApprovalDecisions } from './approval-decisions.mjs'
import { validateEscalationDecision, bindEscalationDecisionDependencies, prepareEscalationDecisions } from './escalation-decisions.mjs'
import { validateProcessDefault, processDefaultsState } from './process-defaults.mjs'
import { validateCommandConfine, commandConfineState, installCommandConfine } from './command-confine.mjs'
import { validateProviderHookDecisions, bindProviderHookDependencies, prepareProviderHookDecisions, registerProviderHookDecisions } from './provider-hook-decisions.mjs'
import { validateRepeatCompactionAction, bindRepeatCompactionDependencies, registerRepeatCompaction } from './repeat-compaction-policy.mjs'
import { validateCurrentSystemSnapshotAction, bindCurrentSystemSnapshotDependencies, registerCurrentSystemSnapshot, prepareCurrentSystemSnapshot } from './current-system-snapshot.mjs'
import { validateRewindAction, registerRewindAgent } from './rewind-control.mjs'
import { validateMessageShapeGuardsAction, bindMessageShapeGuardsDependencies, registerMessageShapeGuards, prepareMessageShapeGuards } from './message-shape-guards.mjs'
import { validateProviderSystemRolesAction, bindProviderSystemRolesDependencies, registerProviderSystemRoles } from './provider-system-roles.mjs'

// 身份与归属只有这一份；具体值和实际可用性仍由能力实现拥有。
const defaults = { key: 'defaults', state: processDefaultsState, channel: 'host:process-defaults' }
const command = { key: 'command', state: commandConfineState, install: installCommandConfine, channel: 'host:command-confine' }
const provider = { key: 'providerSystemRoles', prepareOrder: 2, sharedFrame: true, needsAssembly: true, dependencyOrder: 0,
  create: registerProviderSystemRoles,
  bind: (rule, moduleId, _entries, onOutcome) => bindProviderSystemRolesDependencies(rule, moduleId, onOutcome),
  prepare: (entries, frame, _preview, owner, context) => { owner?.prepare(entries, frame, context) } }
const escalation = { key: 'escalationDecisions', prepareOrder: 4, needsAssembly: true, requiresStep: true,
  bind: (rule, moduleId, _entries, onOutcome) => bindEscalationDecisionDependencies(rule, moduleId, onOutcome),
  prepare: (entries, frame, _preview, _owner, context) => ({ values: prepareEscalationDecisions(entries, frame, context) }), dependencyOrder: 4 }
const filesystem = { key: 'filesystemPolicy', prepareOrder: 6, needsAssembly: true,
  bind: (rule, moduleId, _entries, onOutcome) => bindFilesystemPolicyDependencies(rule, moduleId, onOutcome),
  prepare: prepareFilesystemPolicy, dependencyOrder: 6 }
const repeatCompaction = { key: 'repeatCompaction', prepareOrder: 3, sharedFrame: true, contextOwner: true,
  create: registerRepeatCompaction, dependencyOrder: 9,
  bind: (rule, moduleId, _entries, onOutcome, owner) => bindRepeatCompactionDependencies(rule, moduleId, (action, agent) => owner.status(action, agent), onOutcome),
  prepare: (entries, frame, _preview, owner, context) => { owner.prepare(entries, frame, context) } }
const rewind = { key: 'rewind', create: registerRewindAgent }
const catalog = new Map([
  ...['sandbox-soft-default', 'approval-composition-default', 'approval-config-default'].map(id => [id, { scope: 'process', validate: validateProcessDefault, process: defaults }]),
  ['command-confine-passthrough', { scope: 'process', validate: validateCommandConfine, process: command }],
  ['file-read-limits', { scope: 'agent', validate: validateReadLimits,
    agent: { key: 'readLimits', prepareOrder: 7, needsAssembly: true, preflight: 'before', bind: bindReadLimitsDependencies, prepare: prepareReadLimits, dependencyOrder: 8 } }],
  ['delegation-limits', { scope: 'agent', validate: validateDelegationLimits,
    agent: { key: 'delegationLimits', prepareOrder: 8, needsAssembly: true, preflight: 'before', bind: bindDelegationLimitsDependencies, prepare: prepareDelegationLimits, dependencyOrder: 7 } }],
  ...['escalation-criteria', 'escalation-grant', 'escalation-outcome'].map(id => [id, { scope: 'agent', validate: validateEscalationDecision, agent: escalation }]),
  ['approval-decisions', { scope: 'agent', validate: validateApprovalDecisions,
    agent: { key: 'approvalDecisions', prepareOrder: 5, needsAssembly: true, preflight: 'before', requiresStep: true,
      bind: (rule, moduleId, _entries, onOutcome) => bindApprovalDecisionsDependencies(rule, moduleId, onOutcome),
      prepare: (entries, frame) => ({ values: prepareApprovalDecisions(entries, frame) }), dependencyOrder: 5 } }],
  ['provider-hook-decisions', { scope: 'agent', validate: validateProviderHookDecisions,
    agent: { key: 'providerHookDecisions', preflight: 'after', dependencyOrder: 3,
      create: registerProviderHookDecisions,
      bind: (rule, moduleId, _entries, onOutcome) => bindProviderHookDependencies(rule, moduleId, onOutcome),
      prepare: (entries, frame) => { prepareProviderHookDecisions(entries, frame) } } }],
  ...['sandbox-file-write', 'filesystem-fence', 'filesystem-observation'].map(id => [id, { scope: 'agent', validate: validateFilesystemPolicy, agent: filesystem }]),
  ...['repeat-tool-reminder', 'compaction-tool-result-pruner'].map(id => [id, { scope: 'agent', validate: validateRepeatCompactionAction, agent: repeatCompaction }]),
  ['current-system-snapshot', { scope: 'agent', validate: validateCurrentSystemSnapshotAction,
    agent: { key: 'currentSystemSnapshot', prepareOrder: 0, sharedFrame: true, needsAssembly: true, dependencyOrder: 2,
      create: registerCurrentSystemSnapshot, prepare: prepareCurrentSystemSnapshot,
      bind: (rule, moduleId, _entries, onOutcome) => bindCurrentSystemSnapshotDependencies(rule, moduleId, onOutcome) } }],
  ['message-shape-guards', { scope: 'agent', validate: validateMessageShapeGuardsAction,
    agent: { key: 'messageShapeGuards', prepareOrder: 1, sharedFrame: true, needsAssembly: true, dependencyOrder: 1,
      create: registerMessageShapeGuards, prepare: prepareMessageShapeGuards,
      bind: (rule, moduleId, _entries, onOutcome) => bindMessageShapeGuardsDependencies(rule, moduleId, onOutcome) } }],
  ...['oauth-identity-prefix', 'provider-system-role', 'messages-current-system'].map(id => [id, { scope: 'agent', validate: validateProviderSystemRolesAction, agent: provider }]),
  ...['session-rewind', 'session-rewind-todos'].map(id => [id, { scope: 'agent', validate: validateRewindAction, agent: rewind }]),
])

export const hostControlDescriptor = action => action?.kind === 'host-control' ? catalog.get(action.capability) : undefined
export const agentHostControls = () => [...new Set([...catalog.values()].flatMap(descriptor => descriptor.agent === undefined ? [] : [descriptor.agent]))]
export const processHostControls = () => [...new Set([...catalog.values()].flatMap(descriptor => descriptor.process === undefined ? [] : [descriptor.process]))]

export function validateHostControl(action) {
  const descriptor = hostControlDescriptor(action)
  if (descriptor === undefined) throw new TypeError('host-control.capability must be file-read-limits')
  descriptor.validate(action)
}
