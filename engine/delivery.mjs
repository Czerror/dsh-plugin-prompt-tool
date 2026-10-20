import { historyEvents, viewRestricted } from './history.mjs'

export function eventMessage(event) {
  const data = event?.data
  if (data === null || typeof data !== 'object') return undefined
  const message = data.message !== null && typeof data.message === 'object' ? data.message : data
  return message?.source !== null && typeof message?.source === 'object' ? message : undefined
}

export function moduleIdOf(value, field) {
  const id = value?.[field]
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

export const moduleOf = source => moduleIdOf(source, 'moduleId')
export const identityOf = config => config.mergeMode === 'merged' ? `merged:${config.position}` : config.identity.value

export function pluginIdentityOf(source) {
  if (typeof source?.plugin === 'string' && source.plugin.length > 0) return source.plugin
  return typeof source?.kind === 'string' && source.kind.startsWith('plugin:') ? source.kind.slice(7) : undefined
}

export function identityStampOf(config) {
  const plugin = identityOf(config)
  const moduleId = moduleIdOf(config, 'sourceModuleId')
  return {
    kind: typeof config.sourceKind === 'string' && config.sourceKind.length > 0 ? config.sourceKind : `plugin:${plugin}`,
    plugin,
    ...(moduleId === undefined ? {} : { moduleId }),
  }
}

export function identityHit(source, config, value) {
  if (source?.kind !== config.sourceKind && pluginIdentityOf(source) !== value) return false
  const moduleId = moduleOf(source)
  return moduleId === undefined || moduleId === moduleIdOf(config, 'sourceModuleId')
}

/** 投递关联与去重读取相同的可见内容，投影删除的消息不能再充当事实。 */
export function visibleMessages(session) {
  const events = historyEvents(session)
  const visible = viewRestricted(session, events) ? session.surface.nodes.map(seq => events[seq]) : events
  const seen = new Set()
  const out = []
  for (const event of visible) {
    const seq = Number.isSafeInteger(event.seq) ? event.seq : events.indexOf(event)
    if (seq < 0 || seen.has(seq)) continue
    seen.add(seq)
    const message = typeof session?.surface?.deriveEventMessage === 'function'
      ? session.surface.deriveEventMessage(event) : eventMessage(event)
    if (message != null) out.push({ event, seq, message })
  }
  return out
}

export function injectedMessage(config, session) {
  const value = identityOf(config)
  return visibleMessages(session).find(({ message, seq }) => identityHit(message.source, config, value)
    && (!config.linkedDelivery || message.source.sessionId === session.id && seq >= (session.inheritedEventCount ?? 0)))?.message
}

export function actionStamp(config, session) {
  return config.ruleId === undefined || config.ruleActionId === undefined || session?.id === undefined ? {} : {
    ruleId: config.ruleId, actionId: config.ruleActionId, sessionId: session?.id,
  }
}

/** 官方同 order 按 name 排序，注册和投递查询共用这一份名字。 */
export function textRegistrationName(config, field) {
  const explicit = config.params?.[field]
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  if (config.sourceModuleId === undefined) return config.id
  return `prompt-tool:${String(config.sequence).padStart(16, '0')}:${config.sourceModuleId}:${config.id}`
}

/** after 需要动作的严格证据；去重的宽松身份命中不能代替这份关联。 */
export function findActionDelivery(session, config, messages = visibleMessages(session)) {
  if (config === undefined || session?.id === undefined) return undefined
  let found
  for (const entry of messages) {
    if (entry.seq < (session?.inheritedEventCount ?? 0)) continue
    const source = entry.message.source
    const matches = config.layer === 'runtime-context'
      ? source?.kind === 'runtime-context' && source.form === 'snapshot'
        && source.sections?.some(section => section.name === textRegistrationName(config, 'contextName') && typeof section.text === 'string' && section.text.length > 0)
      : (source?.moduleId ?? '') === (config.sourceModuleId ?? '')
        && source?.ruleId === config.ruleId && source?.actionId === config.ruleActionId
        && source?.sessionId === session?.id
    if (matches && (found === undefined || entry.seq > found.seq)) found = entry
  }
  return found
}
