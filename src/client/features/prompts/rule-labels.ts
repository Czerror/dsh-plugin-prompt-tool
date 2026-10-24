import type { PromptToolLocaleKey, PromptToolTranslate } from '../../locales.ts'
import { TRIGGERS_ZH } from '../../locales-triggers.ts'

/** 规则协议名只作未知扩展的兜底；已知选项以本地化名称呈现。 */
export function triggerLabel(t: PromptToolTranslate, name: string): string {
  const key = `triggers.label.${name}` as PromptToolLocaleKey
  return Object.hasOwn(TRIGGERS_ZH, key) ? t(key) : name
}

const FIELD_OPTIONS: Record<string, Record<string, readonly string[]>> = {
  'tool-gate': { decision: ['allow', 'deny', 'ask'] },
  'tool-result': { action: ['accept', 'replace', 'block'] },
  'stream-output': { mode: ['pass', 'replace'] },
  'inbox-prepend': { target: ['next-turn', 'next-step'] },
  count: { per: ['session', 'turn'], of: ['tool-call', 'tool-result', 'assistant-message', 'assistant-chars', 'user-message', 'turn'] },
  text: { logic: ['any', 'all', 'not', 'notAny'], mode: ['scan', 'prefix'], wordBoundary: ['ascii-token', 'unicode'] },
  anchor: { subject: ['userMessage', 'assistantReasoning', 'assistantText', 'toolResult'], logic: ['any', 'all', 'not', 'notAny'], mode: ['scan', 'prefix'], wordBoundary: ['ascii-token', 'unicode'] },
  // in 需要字符串数组，编辑器没有数组输入，只留在手写 YAML 能力里。
  variable: { op: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'present', 'absent'], scope: ['effective', 'module', 'global'] },
  source: { match: ['exact', 'prefix'] },
  phase: { promoteOn: ['tool-call', 'assistant-message', 'either'] },
}

/** 仅有限枚举使用选择器，协议值与自由文本保持原样。 */
export function ruleFieldOptions(t: PromptToolTranslate, kind: string, field: string): { value: string; label: string }[] | undefined {
  const values = field === 'waterfallPosition' ? ['default', 'outermost'] : FIELD_OPTIONS[kind]?.[field]
  return values?.map(value => ({ value, label: field === 'waterfallPosition' ? triggerLabel(t, value)
    : t(`triggers.option.${kind === 'count' && field === 'of' && value === 'turn' ? 'turn-count' : value}` as PromptToolLocaleKey) }))
}
