import type { PromptToolLocaleKey, PromptToolTranslate } from '../locales.ts'
import { cleared, type FieldDraft } from './workspace-drafts.ts'

const readLimits = (): Record<string, unknown> => ({ maxLineLength: 10000, maxBytes: 1048576, limit: 20000 })
const capabilities = new Map<string, { initialValue: () => unknown; channel?: string; coerceChannel?: boolean }>([
  ['file-read-limits', { initialValue: readLimits }],
  ['delegation-limits', { initialValue: () => ({ maxDepth: 10, askTimeout: 300 }) }],
  ['approval-decisions', { initialValue: () => ({ autoGrant: false, autoReviewPassthrough: false, toolAskAllow: false }) }],
  ['provider-hook-decisions', { initialValue: () => ({ 'claude-code': true }) }],
  ['escalation-criteria', { initialValue: () => true, coerceChannel: true }],
  ['escalation-grant', { initialValue: () => true, coerceChannel: true }],
  ['escalation-outcome', { initialValue: () => true, coerceChannel: true }],
  ['sandbox-soft-default', { initialValue: () => 'danger-full-access', channel: 'host:process-defaults', coerceChannel: true }],
  ['approval-composition-default', { initialValue: () => 'never', channel: 'host:process-defaults', coerceChannel: true }],
  ['approval-config-default', { initialValue: () => 'never', channel: 'host:process-defaults', coerceChannel: true }],
  ['command-confine-passthrough', { initialValue: () => true, channel: 'host:command-confine' }],
  ['sandbox-file-write', { initialValue: () => true, coerceChannel: true }],
  ['filesystem-fence', { initialValue: () => true, coerceChannel: true }],
  ['filesystem-observation', { initialValue: () => true, coerceChannel: true }],
  ['repeat-tool-reminder', { initialValue: () => true, coerceChannel: true }],
  ['compaction-tool-result-pruner', { initialValue: () => true, coerceChannel: true }],
  ['current-system-snapshot', { initialValue: () => true }],
  ['message-shape-guards', { initialValue: () => true }],
  ['oauth-identity-prefix', { initialValue: () => true }],
  ['provider-system-role', { initialValue: () => true }],
  ['messages-current-system', { initialValue: () => true }],
  ['session-rewind', { initialValue: () => true }],
  ['session-rewind-todos', { initialValue: () => true }],
])

export function hostCapabilityOptions(t: PromptToolTranslate): { value: string; label: string }[] {
  return [...capabilities.keys()].map(value => ({ value, label: t(`triggers.option.${value}` as PromptToolLocaleKey) }))
}

export function changeHostCapability(action: Record<string, unknown>, next: unknown, context: { fields: Map<string, FieldDraft>; fieldKey: string }): Record<string, unknown> {
  const updated: Record<string, unknown> = { ...action }
  if (next === undefined) delete updated.capability
  else updated.capability = next
  if (next === action.capability) return updated
  const initial = (capabilities.get(String(next))?.initialValue ?? readLimits)()
  // 旧编辑入口仅对布尔能力转换协议名，非字符串的对象/字符串能力仍走读取额度兜底。
  updated.value = typeof next === 'string' || initial === true ? initial : readLimits()
  cleared(context.fields, context.fieldKey + ':value')
  return updated
}

export function hostCapabilityChannel(capability: unknown): string | undefined {
  const name = String(capability)
  const policy = capabilities.get(name)
  if (!policy || (typeof capability !== 'string' && !policy.coerceChannel)) return undefined
  return policy.channel ?? `host:${name}`
}
