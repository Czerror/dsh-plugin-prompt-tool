import type { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import { visibleRewindEntries } from '../../../engine/rewind-marker.mjs'

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
        || registryOwner(registries.eventDefinitions) !== registryOwner(service.events)
        || registryOwner(registries.viewDefinitions) !== registryOwner(service.views)
        || registryOwner(registries.groupDefinitions) !== registryOwner(service.groups)) {
        return result
      }
      owners.add(view)
      const replace = owner.replaceWindow, append = owner.append, prepend = owner.prepend
      let window = session.eventSource.getSnapshot()
      let entries = new Map<number, Entry>(window.entries.map((entry: Entry) => [entry.event.seq, entry]))
      let hasMore = window.hasMore
      const replay = (): unknown => replace.call(owner, visibleRewindEntries([...entries.values()]), hasMore)
      const replaceWindow: Owner['replaceWindow'] = (next, more) => {
        if (!active) return replace.call(owner, next, more)
        entries = new Map(next.map(entry => [entry.event.seq, entry])); hasMore = more
        return replay()
      }
      const appendEntry: Owner['append'] = entry => {
        if (!active) return append.call(owner, entry)
        entries.set(entry.event.seq, entry)
        return replay()
      }
      const prependEntries: Owner['prepend'] = (next, more) => {
        if (!active) return prepend.call(owner, next, more)
        for (const entry of next) entries.set(entry.event.seq, entry)
        hasMore = more
        return replay()
      }
      owner.replaceWindow = replaceWindow; owner.append = appendEntry; owner.prepend = prependEntries
      releases.push(() => {
        if (owner.replaceWindow === replaceWindow) owner.replaceWindow = replace
        if (owner.append === appendEntry) owner.append = append
        if (owner.prepend === prependEntries) owner.prepend = prepend
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
