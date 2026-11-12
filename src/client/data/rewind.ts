import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { RewindMode, RewindRequest, RewindResult } from '../../shared/rewind.ts'

const restoredMarkers = new WeakMap<InputActions, Set<string>>()

export interface RewindRecovery { notice: string; text?: string; retry?: RewindRequest }

/** Slot-owned transient results survive input-view replacement until plugin disposal. */
export class RewindRecoveryOwner {
  readonly restored = new Set<string>()
  private readonly results = new Map<string, RewindRecovery>()
  private readonly listeners = new Set<() => void>()
  get = (sessionId: string): RewindRecovery | undefined => this.results.get(sessionId)
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  set(sessionId: string, result: RewindRecovery): void {
    this.results.set(sessionId, result)
    for (const listener of this.listeners) listener()
  }
  clear(): void { this.results.clear(); this.listeners.clear(); this.restored.clear() }
}

export class RewindSubmissionError extends Error {
  readonly request: RewindRequest
  constructor(message: string, request: RewindRequest) { super(message); this.request = request }
}

export async function rewindConversation(options: {
  sessionId: string; mode: RewindMode; credential: string; input: InputActions; canRestore: () => boolean; retry?: RewindRequest; restoredMarkers?: Set<string>
}, invoke: (request: RewindRequest) => Promise<{ ok: boolean; value?: RewindResult; message?: string; code?: string }>): Promise<{ result: RewindResult; text?: string; restored: boolean; restoreError?: string; retry?: RewindRequest }> {
  const span = options.input.captureInsertion()
  const request: RewindRequest = { phase: 'preview', sessionId: options.sessionId, mode: options.mode, credential: options.credential, requestId: crypto.randomUUID() }
  let submission = options.retry
  if (!submission) {
    const preview = await invoke(request)
    if (!preview.ok || !preview.value) throw new Error(preview.message ?? '回退预览失败')
    submission = { ...request, phase: 'commit', boundary: preview.value.boundary }
  }
  let committed: Awaited<ReturnType<typeof invoke>>
  try { committed = await invoke(submission) }
  catch (error) { throw new RewindSubmissionError(error instanceof Error ? error.message : String(error), submission) }
  if (!committed.ok || !committed.value) {
    if (!committed.code) throw new RewindSubmissionError(committed.message ?? '回退提交结果未确认', submission)
    throw new Error(committed.message ?? '回退提交失败')
  }
  const target = committed.value.targets.find(target => target.sessionId === options.sessionId && target.status === 'committed')
  const text = target?.text
  const identity = target?.markerId ?? `${options.sessionId}:${committed.value.boundary}`
  const restoredBefore = (options.restoredMarkers ?? restoredMarkers.get(options.input))?.has(identity) ?? false
  let restored = false, restoreError: string | undefined
  try {
    restored = restoredBefore || text !== undefined && options.canRestore() && options.input.insertText(text, span)
    if (restored && !restoredBefore) {
      const markers = options.restoredMarkers ?? restoredMarkers.get(options.input) ?? new Set<string>()
      markers.add(identity); restoredMarkers.set(options.input, markers)
      options.input.persistDraft()
    }
  } catch (error) { restored = false; restoreError = error instanceof Error ? error.message : String(error) }
  const retry = committed.value.targets.some(target => target.status === 'failed')
    ? { ...submission, phase: 'retry' as const, requestId: crypto.randomUUID() } : undefined
  return { result: committed.value, text, restored, restoreError, retry }
}
