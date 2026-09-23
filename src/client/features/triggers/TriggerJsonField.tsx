import type { ReactNode } from 'react'
import type { FieldDraft } from '../../data/workspace-drafts.ts'
import { deepEqual } from '../../data/dirty-state.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { FormField } from '../../ui/FormField.tsx'
import ui from '../../ui/controls.module.css'

export const asTriggerRecord = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** 干净字段随外部快照更新；未完成输入仍归用户所有。 */
export function triggerJsonText(fields: Map<string, FieldDraft>, key: string, value: unknown): FieldDraft {
  const existing = fields.get(key)
  if (existing !== undefined) {
    if (existing.text !== existing.source || existing.error) return existing
    try { if (deepEqual(JSON.parse(existing.text), value)) return existing } catch { /* 使用当前值 */ }
  }
  const text = JSON.stringify(value, null, 2) ?? '{}'
  return { source: text, text, error: '' }
}

export function editTriggerJson(fields: Map<string, FieldDraft>, key: string, value: unknown, text: string, shape: 'object' | 'array', invalid: string, onChange: (value: unknown) => void): void {
  const previous = triggerJsonText(fields, key, value)
  try {
    const parsed: unknown = JSON.parse(text)
    if (shape === 'array' ? !Array.isArray(parsed) : parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(invalid)
    fields.set(key, { source: text, text, error: '' })
    onChange(parsed)
  } catch {
    fields.set(key, { source: previous.source, text, error: invalid })
  }
}

export function TriggerJsonField(props: {
  t: PromptToolTranslate; label: string; value: unknown; shape: 'object' | 'array'
  fields: Map<string, FieldDraft>; fieldKey: string; disabled?: boolean
  onChange: (value: unknown) => void; onDraft: () => void
}): ReactNode {
  const draft = triggerJsonText(props.fields, props.fieldKey, props.value)
  return <FormField label={props.label} error={draft.error}>
    <textarea className={ui.configTextarea} aria-label={props.label} rows={8} spellCheck={false} readOnly={props.disabled}
      value={draft.text} onChange={(event) => {
        if (props.disabled) return
        editTriggerJson(props.fields, props.fieldKey, props.value, event.target.value, props.shape, props.t('triggers.invalidJson'), props.onChange)
        props.onDraft()
      }} />
  </FormField>
}
