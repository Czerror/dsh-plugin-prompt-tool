/** 未结提醒的确认态来自真实会话事件；候选求值不产生状态。 */
import { eventMessage } from '../../engine/delivery.mjs'
import { isSuccessfulCompactionEnd } from '../../engine/compaction-epoch.mjs'
import type { RuleSoulReminder, SoulReminderFact } from '../../engine/rule-runtime.mjs'

interface ReminderAgent { session?: { id?: string; header?: { delegationDepth?: number }; snapshotEvents?: () => readonly unknown[] } }
interface Projection { open: number; pendingReview: number; pendingVersion: string }

export function createSoulReminder(readProjection: (moduleId: string, agent: ReminderAgent) => Projection): RuleSoulReminder {
  return { read(moduleId: string, value: unknown): SoulReminderFact | undefined {
    const agent = value as ReminderAgent, session = agent?.session
    if (!session?.id || typeof session.snapshotEvents !== 'function') return undefined
    try {
      const projection = readProjection(moduleId, agent), count = projection.open + projection.pendingReview
      if (!Number.isSafeInteger(count) || count < 0 || !projection.pendingVersion) return undefined
      let epoch = -1
      let confirmed: { pendingVersion: string; epoch: number } | undefined
      const events = session.snapshotEvents()
      for (let index = 0; index < events.length; index++) {
        const event = events[index] as { seq?: number; type?: string; data?: unknown }
        if (isSuccessfulCompactionEnd(event)) epoch = event.seq ?? index
        const source = eventMessage(event)?.source
        let mark = source?.moduleId === moduleId && source?.sessionId === session.id
          && String(source.kind).startsWith('plugin:') ? source.soulReminder : undefined
        if (source?.kind === 'runtime-context' && source.form === 'snapshot' && Array.isArray(source.sections)) {
          for (const section of source.sections) {
            if (typeof section?.text !== 'string') continue
            for (const match of section.text.matchAll(/<!-- soul-reminder:([A-Za-z0-9+/=]+) -->/g)) {
              let candidate
              try { candidate = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) } catch { continue }
              if (candidate.moduleId === moduleId && candidate.sessionId === session.id) mark = candidate
            }
          }
        }
        if (typeof mark === 'object' && mark !== null && 'pendingVersion' in mark && 'epoch' in mark
          && typeof mark.pendingVersion === 'string' && typeof mark.epoch === 'number' && Number.isSafeInteger(mark.epoch)) confirmed = { pendingVersion: mark.pendingVersion, epoch: mark.epoch }
      }
      return { count, pendingVersion: projection.pendingVersion, epoch, due: count > 0
        && (session.header?.delegationDepth ?? 0) === 0
        && (confirmed?.pendingVersion !== projection.pendingVersion || confirmed.epoch !== epoch) }
    } catch { return undefined }
  } }
}
