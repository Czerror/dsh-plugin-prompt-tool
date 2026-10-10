/** 执行凭据独立于规则 mount；变量真值始终归显式宿主 adapter。 */
import { historyEvents } from './history.mjs'
import { evaluateTemplate } from './template-evaluation.mjs'
import { interpolateVariables, stripUnresolvedRefs } from './interpolate.mjs'

const frames = new WeakMap()
const MAX_CARDS = 4096

/** 官方循环先 assemble、再 pre-step、最后打开 step/start；两出口共享已提交边界。 */
export function templateExecutionKey(agent, signal) {
  if (agent?.status !== 'running' || !signal || signal.aborted) return undefined
  const events = historyEvents(agent.session)
  const turn = events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
  if (turn?.type !== 'turn/start' || !Number.isSafeInteger(turn.seq)) return undefined
  const step = events.findLast(event => event.type === 'step/start' || event.type === 'step/end')
  if (step?.type === 'step/start' && step.seq > turn.seq) return undefined
  return `${turn.seq}:${step?.seq ?? -1}`
}

export function renderTemplate(config, context = {}, { variableStore = config.variableStore, enabled = true, warn = () => {} } = {}) {
  const text = config.texts.join('\n\n'), agent = context.agent, signal = context.signal
  signal?.throwIfAborted()
  if (!enabled) return stripUnresolvedRefs(interpolateVariables(text, {}, agent?.session, undefined, config.id)).text
  const execution = templateExecutionKey(agent, signal)
  let frame
  if (execution !== undefined) {
    frame = frames.get(agent)
    if (frame?.execution !== execution) { frame = { execution, cards: new Map() }; frames.set(agent, frame) }
  }
  const identity = JSON.stringify([config.sourceModuleId, config.ruleId, config.id])
  const previous = frame?.cards.get(identity)
  const publish = entry => {
    if (!entry.pending) return
    try {
      if (!variableStore?.publish) throw new Error('Variable publication adapter unavailable')
      variableStore.publish(config.sourceModuleId)
      entry.pending = false
    } catch (error) { warn(`Template ${config.id}: variables saved; publication pending: ${String(error?.message ?? error)}`) }
  }
  if (previous) { publish(previous); return previous.text }
  if (frame?.cards.size >= MAX_CARDS) throw new RangeError('Template execution card limit exceeded')
  const samples = new Map()
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = variableStore?.read(config.sourceModuleId) ?? { module: config.variables ?? {}, global: {} }
    if (snapshot.enabled === false) return stripUnresolvedRefs(interpolateVariables(text, {}, agent?.session, undefined, config.id)).text
    const result = evaluateTemplate(text, { module: snapshot.module, global: snapshot.global, session: agent?.session,
      sourceId: `${config.sourceModuleId ?? ''}:${config.id}`, readOnly: execution === undefined, samples })
    const entry = { text: stripUnresolvedRefs(result.text).text, pending: false }
    if (result.changes) {
      if (!variableStore?.commit) throw new Error('Persistent template writes require a variable adapter')
      signal?.throwIfAborted()
      const domains = new Set([...result.reads, result.changes.scope])
      const expectedRevisions = Object.fromEntries([...domains].map(domain => [domain, snapshot.revisions[domain]]))
      if (snapshot.revisions.settings !== undefined) expectedRevisions.settings = snapshot.revisions.settings
      try {
        const saved = variableStore.commit(config.sourceModuleId, { scope: result.changes.scope, changes: result.changes.values, expectedRevisions })
        entry.pending = saved.publicationPending === true
      } catch (error) {
        if (error?.persisted === true) entry.pending = true
        else if (error?.status === 409 && attempt < 2) continue
        else throw error
      }
    }
    frame?.cards.set(identity, entry)
    if (entry.pending) warn(`Template ${config.id}: variables saved; publication pending`)
    return entry.text
  }
  throw new Error('Template variable commit conflict')
}
