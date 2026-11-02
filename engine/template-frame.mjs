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

function* templateExecution(config, context = {}, { variableStore = config.variableStore, enabled = true, warn = () => {}, preview = false } = {}, asynchronous = false) {
  const text = config.texts.join('\n\n'), agent = context.agent, signal = context.signal
  signal?.throwIfAborted()
  const disabledText = () => stripUnresolvedRefs(interpolateVariables(text, {}, agent?.session, undefined, config.id)).text
  if (!enabled) return disabledText()
  // 挂载预检只在副本求值，不读取或消费真实执行的提交凭据。
  const execution = preview ? undefined : templateExecutionKey(agent, signal)
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
  if (previous?.inFlight || previous?.text !== undefined) {
    const entry = previous.inFlight ? yield previous.inFlight : previous
    signal?.throwIfAborted()
    if (variableStore?.read(config.sourceModuleId, context).enabled === false) return disabledText()
    entry.assertCurrent?.(context)
    publish(entry); return entry.text
  }
  if (!previous && frame?.cards.size >= MAX_CARDS) throw new RangeError('Template execution card limit exceeded')
  const samples = previous?.samples ?? new Map()
  if (!previous) frame?.cards.set(identity, { samples })
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = variableStore?.read(config.sourceModuleId, context) ?? { module: config.variables ?? {}, global: {} }
    if (snapshot.enabled === false) return disabledText()
    const result = evaluateTemplate(text, { module: snapshot.module, global: snapshot.global, sessionVariables: snapshot.session,
      readRuntime: key => variableStore?.readRuntime?.(config.sourceModuleId, key, context), session: agent?.session,
      sourceId: `${config.sourceModuleId ?? ''}:${config.id}`, readOnly: execution === undefined && !preview, samples })
    const entry = { text: stripUnresolvedRefs(result.text).text, pending: false, assertCurrent: snapshot.assertCurrent }
    if (result.changes?.scope === 'session' && (!asynchronous || preview)) throw new TypeError('Session template writes require an asynchronous rule or tool')
    if (result.changes && !preview) {
      if (!variableStore?.commit) throw new Error('Persistent template writes require a variable adapter')
      signal?.throwIfAborted()
      const domains = new Set([...result.reads, result.changes.scope])
      const expectedRevisions = Object.fromEntries([...domains].map(domain => [domain, snapshot.revisions[domain]]))
      if (snapshot.revisions.settings !== undefined) expectedRevisions.settings = snapshot.revisions.settings
      try {
        let saved = variableStore.commit(config.sourceModuleId, { scope: result.changes.scope, changes: result.changes.values, expectedRevisions }, context)
        if (saved && typeof saved.then === 'function') {
          if (!asynchronous) throw new TypeError('Synchronous template commit returned a Promise')
          saved = yield saved
        }
        entry.pending = saved.publicationPending === true
      } catch (error) {
        if (error?.persisted === true) entry.pending = true
        else if (error?.status === 409 && attempt < 2) continue
        else throw error
      }
    }
    if (result.changes) frame?.cards.set(identity, entry)
    if (entry.pending) warn(`Template ${config.id}: variables saved; publication pending`)
    signal?.throwIfAborted()
    if (variableStore?.read(config.sourceModuleId, context).enabled === false) return disabledText()
    entry.assertCurrent?.(context)
    return entry.text
  }
  throw new Error('Template variable commit conflict')
}

export function renderTemplate(config, context = {}, options = {}) {
  const execution = templateExecution(config, context, options)
  const result = execution.next()
  if (!result.done) throw new TypeError('Template execution is already awaiting an asynchronous commit')
  return result.value
}

export function renderTemplateAsync(config, context = {}, options = {}) {
  const key = templateExecutionKey(context.agent, context.signal)
  let frame = key === undefined ? undefined : frames.get(context.agent)
  if (key !== undefined && frame?.execution !== key) {
    frame = { execution: key, cards: new Map() }; frames.set(context.agent, frame)
  }
  const identity = JSON.stringify([config.sourceModuleId, config.ruleId, config.id])
  const execution = templateExecution(config, context, options, true)
  let result
  try { result = execution.next() } catch (error) { return Promise.reject(error) }
  if (result.done) return Promise.resolve(result.value)
  if (frame?.cards.get(identity)?.inFlight) return drive(result)
  const inFlight = drive(result).then(text => {
    const saved = frame?.cards.get(identity)
    return saved?.text === undefined ? { text, pending: false } : { ...saved, text }
  })
  const pending = { inFlight }
  frame?.cards.set(identity, pending)
  inFlight.catch(() => { if (frame?.cards.get(identity) === pending) frame.cards.delete(identity) })
  return inFlight.then(entry => entry.text)

  async function drive(step) {
    while (!step.done) {
      let value
      try { value = await step.value }
      catch (error) { step = execution.throw(error); continue }
      step = execution.next(value)
    }
    return step.value
  }
}
