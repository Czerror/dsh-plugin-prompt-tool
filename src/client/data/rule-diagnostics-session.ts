import type { RuleDiagnosticRecord, ContextActivationDiagnosticRecord } from '../../shared/bridge-contract.ts'
import { bridgeCall } from './bridge-client.ts'
import { countEnabledConfigs } from '../../shared/module-config-order.ts'

export interface RuleDiagnosticsSnapshot {
  busy: boolean
  status: 'idle' | 'running' | 'ready' | 'stale' | 'error'
  unavailableCount: number
  dropped: number
  configs: { enabled: number; total: number } | undefined
  records: RuleDiagnosticRecord[]
  diagnosedAt?: number
  error?: string
  context?: { sessionId: string; records: ContextActivationDiagnosticRecord[]; truncated: boolean; diagnosedAt?: number; error?: string }
}

export interface RuleDiagnosticsSession {
  subscribe(listener: () => void): () => void
  getSnapshot(): RuleDiagnosticsSnapshot
  run(sessionId?: string): Promise<boolean>
  invalidate(): void
  dispose(): void
}

const initial = (): RuleDiagnosticsSnapshot => ({
  busy: false, status: 'idle', unavailableCount: 0, dropped: 0, configs: undefined, records: [],
})

export function createRuleDiagnosticsSession(): RuleDiagnosticsSession {
  let snapshot = initial()
  let generation = 0
  let busy: Promise<boolean> | undefined
  const listeners = new Set<() => void>()
  let disposed = false
  const publish = (next: RuleDiagnosticsSnapshot): void => {
    snapshot = next
    listeners.forEach(listener => listener())
  }
  const run = (sessionId?: string): Promise<boolean> => {
    if (disposed) return Promise.resolve(false)
    if (busy !== undefined) return busy
    const requestGeneration = generation
    publish({ ...snapshot, busy: true, status: 'running', error: undefined })
    const ruleRead = bridgeCall('ruleDiagnostics')
    const contextRead = sessionId === undefined ? Promise.resolve(undefined) : bridgeCall('contextActivationDiagnostics', { sessionId })
    busy = Promise.all([ruleRead, contextRead]).then(([result, contextResult]) => {
      if (disposed || requestGeneration !== generation) return false
      if (sessionId !== undefined && contextResult !== undefined) {
        const previous = snapshot.context?.sessionId === sessionId ? snapshot.context : undefined
        publish({ ...snapshot, context: contextResult.ok
          ? { sessionId, records: Array.isArray(contextResult.value.records) ? contextResult.value.records : [], truncated: contextResult.value.truncated === true, diagnosedAt: Date.now() }
          : { sessionId, records: previous?.records ?? [], truncated: previous?.truncated ?? false, diagnosedAt: previous?.diagnosedAt, error: contextResult.message ?? '诊断失败' } })
      }
      if (!result.ok) {
        publish({ ...snapshot, status: 'error', error: result.message ?? '诊断失败' })
        return false
      }
      const records = result.value.records
      publish({
        busy: true,
        status: 'ready',
        unavailableCount: records.filter(record => record.unavailable > 0).length,
        dropped: result.value.dropped ?? 0,
        configs: result.value.configs === undefined ? undefined : countEnabledConfigs(result.value.configs.entries),
        records,
        diagnosedAt: Date.now(),
        context: snapshot.context,
      })
      return contextResult === undefined || contextResult.ok
    }).catch(error => {
      if (!disposed && requestGeneration === generation) publish({ ...snapshot, status: 'error', error: error instanceof Error ? error.message : String(error) })
      return false
    }).finally(() => { busy = undefined; if (!disposed) publish({ ...snapshot, busy: false }) })
    return busy
  }
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot() { return snapshot },
    run,
    invalidate() { if (!disposed) { generation += 1; if (snapshot.status !== 'idle') publish({ ...snapshot, status: 'stale' }) } },
    dispose() { disposed = true; generation += 1; listeners.clear() },
  }
}
