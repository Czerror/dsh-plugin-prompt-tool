export function isProcessDefaultAction(action: Record<string, unknown>): boolean
export function validateProcessDefault(action: Record<string, unknown>): void
export interface ProcessDefaults {
  replaceRules(source: string, rules: readonly { executionScope?: unknown; enabled?: boolean; actions: readonly Record<string, unknown>[] }[]): () => void
  replace(source: string, actions: readonly { capability: unknown; value: unknown }[]): () => void
  rawConfig(fiber: unknown, original: unknown): unknown
}
export function createProcessDefaults(): ProcessDefaults
export const processDefaultsState: ProcessDefaults & { configAvailable: boolean; configReason: string; status(capability: unknown): { available: boolean; reason: string } }
