export interface ContextRuntime {
  compactNow(signal?: AbortSignal): Promise<unknown>
  compactRegion(start: number, end: number, signal?: AbortSignal): Promise<unknown>
  compactRecovery(signal?: AbortSignal): Promise<unknown>
  status(): { state: string; last: unknown }
}
export function contextRuntimeOf(agent: object): ContextRuntime | undefined
