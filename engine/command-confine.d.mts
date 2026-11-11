import type { Context } from '@deepseek-ai/cordis'
export function isCommandConfineAction(action: Record<string, unknown>): boolean
export function validateCommandConfine(action: Record<string, unknown>): void
export interface CommandConfine {
  replace(source: string, actions: readonly { capability: unknown; value: unknown }[]): () => void
  status(): { available: boolean; reason: string }
  install(ctx: Context, Provider: { prototype: object }): Promise<() => Promise<void>>
}
export function createCommandConfine(): CommandConfine
export const commandConfineState: CommandConfine
export function installCommandConfine(ctx: Context): Promise<() => Promise<void>>
