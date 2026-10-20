/** `discovery.mjs` 的手写声明：只声明 `src/` 消费的导出。 */

export const DISCOVERY_ADAPTER_ROWS: Readonly<Record<string, string>>
export const UNLOCKABLE_DISCOVERY_KINDS: ReadonlySet<string>

export interface DiscoveryUnlock {
  tool: string
  key: string
}

export interface DiscoveryAdapterMetadata {
  kind: string
  tool: string
  unlock?: DiscoveryUnlock
}

export interface DiscoveryRegistry {
  register(agent: unknown, kind: string, adapter: DiscoveryAdapterMetadata): () => void
  get(agent: unknown, kind: string): DiscoveryAdapterMetadata | undefined
}

export function createDiscoveryRegistry(): DiscoveryRegistry
export function assertDiscoveryRows(rules: readonly unknown[], moduleIds: readonly string[] | undefined, moduleId: string): void
export function queryTokens(query: unknown): string[]
export function scoreRows(items: readonly unknown[], tokens: readonly string[], options?: {
  nameOf?: (item: unknown) => unknown
  haystackOf?: (item: unknown) => unknown
}): Array<{ item: unknown; name: string; score: number; exact: boolean }>
export function rankRows<T extends { exact: boolean; score: number; name: string }>(rows: readonly T[], admit?: (row: T) => boolean): T[]
export function renderRows(rows: readonly unknown[], options?: {
  query?: string
  limit?: number
  noun?: string
  lineOf?: (row: unknown) => string
  emptyText?: string
  footer?: string
  warnings?: readonly string[]
}): string[]
