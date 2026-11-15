import type { Context } from '@deepseek-ai/cordis'
import type { compileRules } from './rule-spec.mjs'

export function createProcessHostControls(ctx: Context, record: (record: {
  moduleId: string; ruleId: string; actionId: string; channel: string;
  definitionRevision?: string; outcome: 'hit' | 'unavailable';
  identityOutcome: 'matched' | 'condition-unavailable'; reason: string;
}) => void): {
  publish(id: string, item: { rules: ReturnType<typeof compileRules> } | null, isActive: () => boolean): Promise<void>
  retain(ids: readonly string[]): void
  withdraw(): void
  dispose(): Promise<void>
}
