/** 操作期间只固定引用验证元数据，原始会话由每次消费者自行释放。 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { LoadRetrievalSession, RetrievalSession } from './module-retrieval.ts'
import { createRetrievalEventProjection, retrievalEventRevision } from './module-retrieval.ts'

export interface EvidenceSelection { key: string; histories: readonly { sessionId: string; seqs: readonly number[] }[] }
interface Reference { version: string; public: boolean }
interface Operation { active: boolean; keys: Set<string>; references: Map<string, Map<number, Reference>>; selected: Map<string, Set<number>>; signal: AbortSignal; parent?: Operation }

export function createSoulEvidence(loadSession?: LoadRetrievalSession) {
  const storage = new AsyncLocalStorage<Operation>()
  const lifetime = new AbortController()
  const operations = new Set<Operation>()
  const current = () => {
    lifetime.signal.throwIfAborted()
    const operation = storage.getStore()
    if (!operation) throw new Error('当前操作证据未准备或已释放')
    for (let scope: Operation | undefined = operation; scope; scope = scope.parent) {
      if (!scope.active) throw new Error('当前操作证据未准备或已释放')
      scope.signal.throwIfAborted()
    }
    return operation
  }
  const wait = async <T>(work: Promise<T>, signal: AbortSignal): Promise<T> => {
    signal.throwIfAborted()
    let abort!: () => void
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })])
    } finally { signal.removeEventListener('abort', abort) }
  }
  const capture = (operation: Operation, id: string, session: RetrievalSession | undefined) => {
    current()
    if (!session || session.id !== id) throw new Error('授权会话证据暂不可用')
    const seqs = operation.selected.get(id)
    if (!seqs) throw new Error('嵌套读取需要额外材料，请结束当前证据操作后重试')
    const events = session.snapshotEvents(), projection = createRetrievalEventProjection()(events)
    const references = new Map<number, Reference>()
    for (const event of events) if (seqs.has(event.seq)) references.set(event.seq, { version: retrievalEventRevision(event), public: projection.contents.has(event.seq) })
    if (references.size !== seqs.size) throw new Error('授权原始事件缺失，本次证据暂不可用')
    operation.references.set(id, references)
  }
  return {
    async loadRaw(id: string, signal?: AbortSignal): Promise<RetrievalSession | undefined> {
      const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
      return wait(Promise.resolve().then(() => loadSession?.(id, combined)), combined)
    },
    assert(key: string) {
      if (!current().keys.has(key)) throw new Error('当前操作未准备该会话作用域')
    },
    reference(id: string, seq: number): Reference | undefined { return current().references.get(id)?.get(seq) },
    includes(id: string, seq: number): boolean { return current().selected.get(id)?.has(seq) ?? false },
    async verify(): Promise<void> {
      const operation = current()
      for (const [id, seqs] of operation.selected) {
        if (!seqs.size) continue
        const expected = operation.references.get(id)
        const session = await wait(Promise.resolve().then(() => loadSession?.(id, operation.signal)), operation.signal)
        capture(operation, id, session)
        const actual = operation.references.get(id)!
        if ([...seqs].some(seq => expected?.get(seq)?.version !== actual.get(seq)?.version || expected?.get(seq)?.public !== actual.get(seq)?.public)) throw new Error('原始证据已变化，请重新准备')
      }
      current()
    },
    async load(id: string, signal?: AbortSignal): Promise<RetrievalSession | undefined> {
      const operation = current()
      const combined = signal ? AbortSignal.any([signal, operation.signal]) : operation.signal
      if (!operation.selected.has(id)) throw new Error('嵌套读取需要额外材料，请结束当前证据操作后重试')
      const session = await wait(Promise.resolve().then(() => loadSession?.(id, combined)), combined)
      capture(operation, id, session)
      return session
    },
    async run<T>(selections: readonly EvidenceSelection[], signal: AbortSignal | undefined, callback: () => T | Promise<T>): Promise<T> {
      lifetime.signal.throwIfAborted(); signal?.throwIfAborted()
      const parent = storage.getStore()
      const selected = new Map<string, Set<number>>()
      for (const selection of selections) for (const history of selection.histories) {
        let seqs = selected.get(history.sessionId)
        if (!seqs) { seqs = new Set(); selected.set(history.sessionId, seqs) }
        for (const seq of history.seqs) seqs.add(seq)
      }
      if (parent) {
        current()
        if (selections.some(selection => !parent.keys.has(selection.key)) || [...selected].some(([id, seqs]) => !parent.selected.has(id) || [...seqs].some(seq => !parent.selected.get(id)!.has(seq)))) throw new Error('嵌套读取需要额外材料，请结束当前证据操作后重试')
        const nested: Operation = { ...parent, parent, active: true, signal: signal ? AbortSignal.any([parent.signal, signal]) : parent.signal }
        return storage.run(nested, async () => {
          try { return await wait(Promise.resolve().then(() => { current(); return callback() }), nested.signal) }
          finally { nested.active = false }
        })
      }
      const operation: Operation = { active: true, keys: new Set(selections.map(selection => selection.key)), selected, references: new Map(), signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal }
      operations.add(operation)
      return storage.run(operation, async () => {
        try {
          for (const [id, seqs] of selected) {
            if (!seqs.size) continue
            const session = await wait(Promise.resolve().then(() => loadSession?.(id, operation.signal)), operation.signal)
            capture(operation, id, session)
          }
          return await wait(Promise.resolve().then(callback), operation.signal)
        } finally {
          operation.active = false; operation.references.clear(); operation.selected.clear(); operation.keys.clear(); operations.delete(operation)
        }
      })
    },
    dispose() {
      lifetime.abort(new Error('知识库证据已释放'))
      for (const operation of operations) {
        operation.active = false; operation.references.clear(); operation.selected.clear(); operation.keys.clear()
      }
      operations.clear()
    },
  }
}
