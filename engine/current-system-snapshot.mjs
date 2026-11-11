import { actionMatches } from './conditions/evaluation.mjs'

const owners = new WeakMap()

export const isCurrentSystemSnapshotAction = action => action?.kind === 'host-control' && action.capability === 'current-system-snapshot'

export function validateCurrentSystemSnapshotAction(action) {
  if (action.value !== true) throw new TypeError('current-system-snapshot.value must be true')
  if (action.maxPerTurn !== undefined) throw new TypeError('current-system-snapshot does not accept maxPerTurn')
  if (action.waterfallPosition !== undefined && action.waterfallPosition !== 'default') throw new TypeError('current-system-snapshot is prepared before assemble')
}

export function bindCurrentSystemSnapshotDependencies(rule, moduleId, onOutcome) {
  const controls = rule.actions.filter(isCurrentSystemSnapshotAction).map(action => ({ action,
    dependent: new Set(rule.actions.filter(candidate => action.branchPath.every((part, index) => candidate.branchPath[index] === part)).map(candidate => candidate.id)) }))
  rule.currentSystemSnapshotAvailable = (entry, frame) => {
    const applicable = controls.filter(({ dependent }) => dependent.has(entry.ruleActionId ?? entry.id))
    if (applicable.length === 0) return true
    const checking = { ...frame, ignoreCurrentSystemSnapshotDependency: true }
    if (!applicable.some(({ action }) => actionMatches({ rule, action, id: action.id, actionWhen: action.actionWhen, bypassRuleWhen: action.bypassRuleWhen }, checking))) return true
    const status = currentSystemSnapshotStatus(frame.subject?.agent)
    if (status.available) return true
    try { onOutcome?.({ moduleId, ruleId: rule.id, actionId: applicable[0].action.id, channel: 'host:current-system-snapshot',
      outcome: 'unavailable', identityOutcome: 'condition-unavailable', reason: status.reason, definitionRevision: rule.definitionRevision, agentId: frame.subject?.agent?.id }) } catch {}
    return false
  }
}

export function registerCurrentSystemSnapshot(agent) {
  if (agent === null || (typeof agent !== 'object' && typeof agent !== 'function')) throw new TypeError('agent is required')
  const owner = { enabled: false }
  owners.set(agent, owner)
  return { setEnabled(enabled) { if (owners.get(agent) === owner) owner.enabled = enabled === true }, dispose() { if (owners.get(agent) === owner) owners.delete(agent) } }
}

export function projectCurrentSystemMessages(agent, messages, renderedPrompt, position, signal) {
  const owner = owners.get(agent)
  if (owner?.enabled !== true || !currentSystemSnapshotStatus(agent).available) return messages
  signal?.throwIfAborted()
  if (typeof renderedPrompt !== 'string') return messages
  const first = messages.findIndex(message => message.role === 'system' && message.source?.kind === 'system-prompt')
  if (first < 0) return messages
  const replacement = { ...structuredClone(messages[first]), content: [{ type: 'text', text: renderedPrompt }] }
  const result = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message.role === 'system' && message.source?.kind === 'system-prompt') {
      if (index === first) result.push(replacement)
      continue
    }
    result.push(message)
  }
  return result
}

export function currentSystemSnapshotStatus(agent) {
  return owners.has(agent) && agent?.[Symbol.for('prompt-tool:current-system-snapshot-owner')] === true
    ? { available: true, enabled: owners.get(agent).enabled === true }
    : { available: false, reason: 'current-system early owner unavailable' }
}

function currentSystemPromptCommits(agent, renderedPrompt, input, createSystemMessage) {
  if (owners.get(agent)?.enabled !== true || !currentSystemSnapshotStatus(agent).available) return agent.systemPrompt.project(renderedPrompt, input)
  const events = agent.session.snapshotEvents()
  const nodes = agent.session.surface.nodes.map(seq => events[seq]).filter(event => event?.type === 'system/message' && event.data.message.source?.kind === 'system-prompt')
  const message = createSystemMessage
  if (nodes.length === 0) return [{ message: message(renderedPrompt), intent: { surfaceOp: 'append' } }]
  const updates = nodes.flatMap((event, index) => {
    const text = index === 0 ? renderedPrompt : ''
    const content = event.data.message.content
    if (text === '' ? content.length === 0 : content.length === 1 && content[0]?.type === 'text' && content[0].text === text) return []
    return [{ message: message(text), intent: { surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq] } }]
  })
  if (updates.length === 0) return []
  const head = nodes[0]
  return [...updates.filter(commit => commit.intent.sourceEventSeqs[0] !== head.seq), {
    message: message(renderedPrompt), intent: { surfaceOp: { op: 'replace', startSeq: head.seq, endSeq: head.seq }, sourceEventSeqs: [head.seq] },
  }]
}

globalThis[Symbol.for('prompt-tool:current-system-snapshot:project')] = projectCurrentSystemMessages
globalThis[Symbol.for('prompt-tool:current-system-snapshot:commits')] = currentSystemPromptCommits
