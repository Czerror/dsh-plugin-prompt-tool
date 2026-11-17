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
  const materials = new Map<string, { bytes: number; users: number; value?: Reference }>()
  let bytes = 1, referenceCount = 0
  const admissions: Array<() => boolean> = []
  const advance = () => { while (admissions[0]?.()) admissions.shift() }
  const identity = (id: string, seq: number) => JSON.stringify(['r', id, seq])
  // 固定长度摘要与0/1公开标记使完整JSON元组在读取前即可精确计量。
  const weight = (id: string, seq: number) => Buffer.byteLength(JSON.stringify(['r', id, seq, '0'.repeat(64), 0])) + 1
  const reserve = (selected: Map<string, Set<number>>, keys: Set<string>, signal: AbortSignal): Promise<() => void> => {
    const rows = [...selected].flatMap(([id, seqs]) => [...seqs].map(seq => ({ key: identity(id, seq), bytes: weight(id, seq), reference: true })))
    const count = rows.length
    for (const key of keys) rows.push({ key: JSON.stringify(['s', key]), bytes: Buffer.byteLength(JSON.stringify(['s', key])) + 1, reference: false })
    for (const id of selected.keys()) rows.push({ key: JSON.stringify(['h', id]), bytes: Buffer.byteLength(JSON.stringify(['h', id])) + 1, reference: false })
    if (count > 100000 || 1 + rows.reduce((sum, row) => sum + row.bytes, 0) > 8 * 1024 * 1024) return Promise.reject(new Error('本次证据工作集超出预算，请缩小范围后重试'))
    return new Promise((resolve, reject) => {
      let finished = false
      const abort = () => {
        if (finished) return
        finished = true; signal.removeEventListener('abort', abort)
        const index = admissions.indexOf(admit)
        if (index >= 0) admissions.splice(index, 1)
        reject(signal.reason); advance()
      }
      const admit = () => {
        if (signal.aborted) { abort(); return false }
        const missing = rows.filter(row => !materials.has(row.key))
        if (referenceCount + missing.filter(row => row.reference).length > 100000 || bytes + missing.reduce((sum, row) => sum + row.bytes, 0) > 8 * 1024 * 1024) return false
        finished = true; signal.removeEventListener('abort', abort)
        for (const row of rows) {
          const material = materials.get(row.key)
          if (material) material.users++
          else { materials.set(row.key, { bytes: row.bytes, users: 1 }); bytes += row.bytes; if (row.reference) referenceCount++ }
        }
        let released = false
        resolve(() => {
          if (released) return
          released = true
          for (const row of rows) {
            const material = materials.get(row.key)!
            if (--material.users === 0) { materials.delete(row.key); bytes -= material.bytes; if (row.reference) referenceCount-- }
          }
          advance()
        })
        return true
      }
      admissions.push(admit); signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort(); else advance()
    })
  }
  type Loading = { controller: AbortController; users: number; started: boolean; promise: Promise<RetrievalSession | undefined>; start: () => void }
  const loading = new Map<string, Loading>()
  const pendingLoads: Loading[] = []
  let runningLoads = 0
  const startLoads = () => {
    while (runningLoads < 2 && pendingLoads.length) {
      const task = pendingLoads.shift()!
      if (!task.controller.signal.aborted) { task.started = true; runningLoads++; task.start() }
    }
  }
  const read = async (id: string, signal: AbortSignal) => {
    signal.throwIfAborted(); lifetime.signal.throwIfAborted()
    let task = loading.get(id)
    if (!task) {
      const controller = new AbortController()
      let start!: () => void
      const promise = new Promise<RetrievalSession | undefined>((resolve, reject) => {
        start = () => {
          void Promise.resolve().then(() => loadSession?.(id, controller.signal)).then(session => {
            controller.signal.throwIfAborted()
            if (loading.get(id) === created) loading.delete(id)
            // live Session也只向本次共享消费者提供同一不可变快照。
            const events = session?.snapshotEvents()
            return session && events ? { id: session.id, snapshotEvents: () => events } : undefined
          }).then(resolve, reject).finally(() => {
            if (loading.get(id) === created) loading.delete(id)
            runningLoads--; startLoads()
          })
        }
        controller.signal.addEventListener('abort', () => { if (!created.started) reject(controller.signal.reason) }, { once: true })
      })
      const created: Loading = { controller, users: 0, started: false, promise, start }
      task = created; loading.set(id, task); pendingLoads.push(task)
    }
    task.users++; startLoads()
    try { return await wait(task.promise, signal) }
    finally {
      if (--task.users === 0) {
        if (loading.get(id) === task) loading.delete(id)
        task.controller.abort(new Error('历史装载已无消费者'))
        const index = pendingLoads.indexOf(task)
        if (index >= 0) pendingLoads.splice(index, 1)
      }
    }
  }
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
    for (const event of events) if (seqs.has(event.seq)) {
      const value = { version: retrievalEventRevision(event), public: projection.contents.has(event.seq) }
      const material = materials.get(identity(id, event.seq))!
      if (material.value && (material.value.version !== value.version || material.value.public !== value.public)) throw new Error('原始证据已变化，请释放当前操作后重新准备')
      material.value ??= Object.freeze(value)
      references.set(event.seq, material.value)
    }
    if (references.size !== seqs.size) throw new Error('授权原始事件缺失，本次证据暂不可用')
    operation.references.set(id, references)
  }
  return {
    async loadRaw(id: string, signal?: AbortSignal): Promise<RetrievalSession | undefined> {
      const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
      return read(id, combined)
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
        const session = await read(id, operation.signal)
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
      const session = await read(id, combined)
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
        let release: (() => void) | undefined
        try {
          release = await reserve(selected, operation.keys, operation.signal)
          for (const [id, seqs] of selected) {
            if (!seqs.size) continue
            const session = await read(id, operation.signal)
            capture(operation, id, session)
          }
          return await wait(Promise.resolve().then(callback), operation.signal)
        } finally {
          release?.()
          operation.active = false; operation.references.clear(); operation.selected.clear(); operation.keys.clear(); operations.delete(operation)
        }
      })
    },
    dispose() {
      lifetime.abort(new Error('知识库证据已释放'))
      for (const task of loading.values()) task.controller.abort(lifetime.signal.reason)
      for (const operation of operations) {
        operation.active = false; operation.references.clear(); operation.selected.clear(); operation.keys.clear()
      }
      operations.clear()
    },
  }
}
