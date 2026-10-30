export interface RecoveryObservation { state: string; observedAt: string }
export function recoveryObservationOf(agent: object): RecoveryObservation | undefined
export const name: string
export const inject: string[]
export const configContract: { parse(raw: unknown, plugin: string): Record<string, unknown> }
export function apply(ctx: unknown, raw: unknown, options?: Record<string, unknown>): (() => void) | undefined
