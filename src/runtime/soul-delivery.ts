/** SELF 可见投递协议；不拥有业务授权或贡献裁剪。 */
import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SoulSelfParts } from '../host/soul-self.ts'
import { SOUL_CONTEXT_RESET, soulContributionTag } from '../host/soul-self.ts'
import { eventMessage } from '../../engine/delivery.mjs'

interface SoulDeliverySource {
  kind: string
  moduleId: string
  sessionId: string
  actionId: string
  soulDelivery: { version: 1; sessionId: string; audience: string; form: 'baseline' | 'update'; digest: string; previous?: string; parts: Record<string, string>; textDigest: string }
}
export function deliverySource(value: unknown): SoulDeliverySource | undefined {
  if (!value || typeof value !== 'object') return
  const source = value as Record<string, unknown>, delivery = source.soulDelivery
  if (!delivery || typeof delivery !== 'object') return
  const stamp = delivery as Record<string, unknown>
  if (typeof source.kind === 'string' && source.kind.startsWith('plugin:') && source.kind === `plugin:${source.plugin}` && typeof source.moduleId === 'string'
    && typeof source.sessionId === 'string' && typeof source.actionId === 'string' && stamp.version === 1
    && stamp.sessionId === source.sessionId && typeof stamp.audience === 'string'
    && (stamp.form === 'baseline' || stamp.form === 'update') && typeof stamp.digest === 'string' && /^[a-f0-9]{64}$/.test(stamp.digest)
    && typeof stamp.textDigest === 'string' && /^[a-f0-9]{64}$/.test(stamp.textDigest)
    && stamp.parts !== null && typeof stamp.parts === 'object' && !Array.isArray(stamp.parts)
    && Object.values(stamp.parts).every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
    && (stamp.form === 'baseline' || typeof stamp.previous === 'string')) return value as SoulDeliverySource
}
export function messageText(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return
  const content = (value as { content?: unknown }).content
  if (!Array.isArray(content) || content.some(part => !part || part.type !== 'text' || typeof part.text !== 'string')) return
  return content.map(part => part.text).join('')
}

export const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const summarize = (mapping: Record<string, string>) => digest(JSON.stringify(Object.entries(mapping).sort(([a], [b]) => a.localeCompare(b))))

export function createSoulDelivery() {
  const deliveryIndexes = new WeakMap<Agent['session'], { surface: unknown; replace: unknown; content: unknown; length: Agent['session']['seq'] | undefined; nodes: number; chains: Map<string, SoulDeliverySource['soulDelivery']> }>()
  return (agent: Agent, id: string, audience: string) => {
    const session = agent.session, surface = session.surface
    const reliable = Number.isSafeInteger(surface?.replaceGeneration) && Number.isSafeInteger(surface?.contentGeneration)
    let index = deliveryIndexes.get(session)
    if (!reliable || !index || index.surface !== surface || index.replace !== surface.replaceGeneration
      || index.content !== surface.contentGeneration || (index.length !== undefined && index.length > session.seq) || index.nodes > surface.nodes.length) {
      index = { surface, replace: surface?.replaceGeneration, content: surface?.contentGeneration, length: undefined, nodes: 0, chains: new Map() }
      deliveryIndexes.set(session, index)
    }
    const events = index.length === session.seq ? [] : session.snapshotEvents(index.length)
    const visible = new Set(surface?.nodes.slice(index.nodes))
    for (const event of events) {
      if (event.type !== 'user/message' || event.seq < (session.inheritedEventCount ?? 0) || (surface && !visible.has(event.seq))) continue
      const raw = deliverySource(eventMessage(event)?.source)
      if (!raw || raw.sessionId !== session.id) continue
      const message = session.deriveEventMessage(event)
      const source = deliverySource(message?.source)
      if (!source || source.sessionId !== session.id || source.kind !== raw.kind || source.moduleId !== raw.moduleId
        || source.actionId !== raw.actionId || source.soulDelivery.audience !== raw.soulDelivery.audience) continue
      const stamp = source.soulDelivery, key = JSON.stringify([source.moduleId, stamp.audience])
      const body = messageText(message)
      const summary = summarize(stamp.parts)
      if (body === undefined || digest(body) !== stamp.textDigest || summary !== stamp.digest) { index.chains.delete(key); continue }
      if (stamp.form === 'baseline' || index.chains.get(key)?.digest === stamp.previous) index.chains.set(key, stamp)
      else index.chains.delete(key)
    }
    index.length = session.seq
    index.nodes = surface?.nodes.length ?? 0
    return index.chains.get(JSON.stringify([id, audience]))
  }
}

export function proposeSoulDelivery(parts: SoulSelfParts, previous: SoulDeliverySource['soulDelivery'] | undefined, sessionId: string, audience: string, budget: number, waterKnown: boolean) {
  const entries = [['identity', parts.identity], ...parts.learning.map(row => [row.id, row.text]), ...parts.facts.map(row => [row.id, row.text])] as Array<[string, string]>
  const current = Object.fromEntries(entries.map(([key, text]) => [key, digest(text)]))
  // 未知不是恢复正常；仅保留已送达警告的摘要，不缓存其正文。
  if (!waterKnown && previous?.parts['pressure:warning']) current['pressure:warning'] = previous.parts['pressure:warning']
  let summary = summarize(current)
  if (previous?.digest === summary) return null
  let form: 'baseline' | 'update' = previous ? 'update' : 'baseline'
  if (previous && ('omission:budget' in previous.parts || 'omission:budget' in current)) form = 'baseline'
  const changes = entries.filter(([key]) => previous?.parts[key] !== current[key]).map(([, text]) => text)
  for (const key of Object.keys(previous?.parts ?? {})) if (!(key in current)) changes.push(key === 'pressure:warning'
    ? '此前水位警告解除。' : `[贡献 ${soulContributionTag(key)}] 已失效，不再依据。`)
  let text = form === 'baseline' ? [SOUL_CONTEXT_RESET, ...entries.map(([, text]) => text)].filter(Boolean).join('\n') : changes.join('\n')
  if (Buffer.byteLength(text) > budget) {
    form = 'baseline'
    text = [SOUL_CONTEXT_RESET, ...entries.map(([, text]) => text)].filter(Boolean).join('\n')
  }
  if (form === 'baseline' && !waterKnown) {
    delete current['pressure:warning']
    summary = summarize(current)
  }
  return { text, source: { soulDelivery: { version: 1 as const, sessionId, audience, form, digest: summary, parts: current, textDigest: digest(text), ...(form === 'update' ? { previous: previous!.digest } : {}) } } }
}
