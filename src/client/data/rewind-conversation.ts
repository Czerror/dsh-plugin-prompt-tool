import type { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import { isRewindMarker, visibleRewindEntries } from '../../../engine/rewind-marker.mjs'

type Entry = ReturnType<SessionBinding['eventSource']['getSnapshot']>['entries'][number]
const ready = new WeakSet<object>()
const originalRegistry = Symbol.for('cordis.original')
// Cordis gives tracked registries a fresh proxy on each read; compare their single underlying owner.
const registryOwner = (value: unknown): unknown => value && typeof value === 'object'
  ? (value as Record<symbol, unknown>)[originalRegistry] ?? value : value

export function requireRewindConversation(service: UiConversation, id: string): void {
  const binding = service.binding(id as Parameters<UiConversation['binding']>[0])
  if (!ready.has(binding.snapshot.getSnapshot().views)) throw new Error('当前 Conversation owner 不支持安全回退投影')
}
interface Owner {
  replaceWindow(entries: readonly Entry[], hasMore: boolean): unknown
  append(entry: Entry): unknown
  prepend(entries: readonly Entry[], hasMore: boolean): unknown
  settleAssistant(attemptId: string, entry?: Entry): unknown
  flush(): boolean
}

/** Adapt only the assembler reached through this service's public binding snapshot. */
export function installRewindConversation(service: UiConversation, resolve: (id: string) => SessionBinding | undefined): () => void {
  const originalBinding = service.binding
  let active = true
  const owners = new WeakSet<object>(), releases: (() => void)[] = []
  const binding: typeof originalBinding = function (this: UiConversation, source) {
    const result = originalBinding.call(this, source)
    if (!active) return result
    const session: SessionBinding | undefined = typeof source === 'string' ? resolve(source) : source
    if (!session || resolve(session.sessionId) !== session) return result
    const view = result.snapshot.getSnapshot().views
    if (!owners.has(view)) {
      const owner = view as unknown as Owner
      const prototype = Object.getPrototypeOf(owner) as Record<string, unknown> | null
      const registries = owner as unknown as Record<string, unknown>
      if (!prototype || prototype.constructor?.name !== 'ConversationNodeAssembler' || !Object.isExtensible(owner)
        || !['replaceWindow', 'append', 'prepend'].every(key => typeof prototype[key] === 'function' && !Object.hasOwn(owner, key))
        || owner.replaceWindow.length !== 2 || owner.append.length !== 1 || owner.prepend.length !== 2
        || typeof owner.flush !== 'function'
        || typeof owner.settleAssistant !== 'function' || Object.hasOwn(owner, 'settleAssistant')
        || registryOwner(registries.eventDefinitions) !== registryOwner(service.events)
        || registryOwner(registries.viewDefinitions) !== registryOwner(service.views)
        || registryOwner(registries.groupDefinitions) !== registryOwner(service.groups)) {
        return result
      }
      owners.add(view)
      const replace = owner.replaceWindow, append = owner.append, prepend = owner.prepend, settle = owner.settleAssistant
      let window = session.eventSource.getSnapshot()
      let entries = new Map<number, Entry>(window.entries.map((entry: Entry) => [entry.event.seq, entry]))
      let hasMore = window.hasMore
      let lastSeq = -Infinity, replayTail = false
      const refreshTail = (): void => {
        lastSeq = -Infinity
        let markerSeq = -Infinity, turnSeq = -Infinity
        for (const { event } of entries.values()) {
          lastSeq = Math.max(lastSeq, event.seq)
          if (isRewindMarker(event)) markerSeq = Math.max(markerSeq, event.seq)
          if (event.type === 'turn/start') turnSeq = Math.max(turnSeq, event.seq)
        }
        replayTail = markerSeq !== -Infinity && markerSeq > turnSeq
      }
      const replay = (): unknown => {
        refreshTail()
        return replace.call(owner, visibleRewindEntries([...entries.values()]), hasMore)
      }
      const replaceWindow: Owner['replaceWindow'] = (next, more) => {
        if (!active) return replace.call(owner, next, more)
        entries = new Map(next.map(entry => [entry.event.seq, entry])); hasMore = more
        return replay()
      }
      const appendEntry: Owner['append'] = entry => {
        if (!active) return append.call(owner, entry)
        if (entries.has(entry.event.seq)) return 'none'
        const ordered = entry.event.seq > lastSeq
        entries.set(entry.event.seq, entry)
        if (!ordered || isRewindMarker(entry.event)) return replay()
        lastSeq = entry.event.seq
        // A same-turn continuation can restore boundaries hidden by the marker; a new Turn cannot.
        if (entry.event.type === 'turn/start') replayTail = false
        return replayTail ? replay() : append.call(owner, entry)
      }
      const prependEntries: Owner['prepend'] = (next, more) => {
        if (!active) return prepend.call(owner, next, more)
        for (const entry of next) entries.set(entry.event.seq, entry)
        hasMore = more
        return replay()
      }
      const settleAssistant: Owner['settleAssistant'] = (attemptId, entry) => {
        if (!active) return settle.call(owner, attemptId, entry)
        for (const [seq, candidate] of entries) {
          if (candidate.type === 'transient' && candidate.event.data.attemptId === attemptId) entries.delete(seq)
        }
        if (entry !== undefined) entries.set(entry.event.seq, entry)
        refreshTail()
        return replayTail ? replay() : settle.call(owner, attemptId, entry)
      }
      owner.replaceWindow = replaceWindow; owner.append = appendEntry; owner.prepend = prependEntries; owner.settleAssistant = settleAssistant
      releases.push(() => {
        if (owner.replaceWindow === replaceWindow) Reflect.deleteProperty(owner, 'replaceWindow')
        if (owner.append === appendEntry) Reflect.deleteProperty(owner, 'append')
        if (owner.prepend === prependEntries) Reflect.deleteProperty(owner, 'prepend')
        if (owner.settleAssistant === settleAssistant) Reflect.deleteProperty(owner, 'settleAssistant')
      })
      window = session.eventSource.getSnapshot()
      replaceWindow(window.entries, window.hasMore)
      owner.flush()
      ready.add(view)
      releases.push(() => { ready.delete(view) })
    }
    return result
  }
  service.binding = binding
  return () => {
    active = false
    if (service.binding === binding) service.binding = originalBinding
    for (const release of releases.reverse()) release()
  }
}
