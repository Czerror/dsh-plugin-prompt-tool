import type { Context } from '@deepseek-ai/cordis'
import { installPersonaRegistration } from './runtime/persona-registration.ts'

export const name = 'prompt-tool-persona-registration'
export const inject: string[] = []
export function apply(ctx: Context): void { installPersonaRegistration(ctx) }
