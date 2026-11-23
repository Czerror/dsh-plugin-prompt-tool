import type { PromptToolLocaleKey, PromptToolTranslate } from '../locales.ts'
import { cleared, type FieldDraft } from './workspace-drafts.ts'

const readLimits = (): Record<string, unknown> => ({ maxLineLength: 10000, maxBytes: 1048576, limit: 20000 })
const capabilities = new Map<string, { initialValue: () => unknown; channel?: string; coerceChannel?: boolean }>([
  ['file-read-limits', { initialValue: readLimits }],
  ['delegation-limits', { initialValue: () => ({ maxDepth: 10, askTimeout: 300 }) }],
  ['command-confine-passthrough', { initialValue: () => true, channel: 'host:command-confine' }],
  ['repeat-tool-reminder', { initialValue: () => true, coerceChannel: true }],
  ['compaction-tool-result-pruner', { initialValue: () => true, coerceChannel: true }],
  ['message-shape-guards', { initialValue: () => true }],
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
