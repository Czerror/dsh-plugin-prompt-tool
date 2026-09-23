import type { ReactNode } from 'react'
import type { TriggerEditorMeta } from '../../../shared/bridge-contract.ts'
import type { FieldDraft } from '../../data/workspace-drafts.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { FormField } from '../../ui/FormField.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { asTriggerRecord, TriggerJsonField } from './TriggerJsonField.tsx'
import { triggerLabel } from './trigger-labels.ts'
import ui from '../../ui/controls.module.css'
import css from './triggers.module.css'

interface ParameterProps {
  t: PromptToolTranslate; value: Record<string, unknown>; example: Record<string, unknown>
  fields: Map<string, FieldDraft>; fieldKey: string; disabled?: boolean
  omit?: string[]; depth?: number
  onChange: (value: Record<string, unknown>) => void; onDraft: () => void
}

/** 示例提供常用字段，已有扩展字段仍可编辑；最终合法值由服务端编译器决定。 */
export function TriggerParameterFields(props: ParameterProps): ReactNode {
  return Object.entries({ ...props.example, ...props.value }).map(([key, value]) => {
    if (props.omit?.includes(key)) return null
    const fieldKey = `${props.fieldKey}:${key}`
    const label = triggerLabel(props.t, key)
    const patch = (next: unknown): void => props.onChange({ ...props.value, [key]: next })
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if ((props.depth ?? 0) >= 2) return <TriggerJsonField key={key} {...props} value={value} shape="object" fieldKey={fieldKey} label={label} onChange={patch} />
      return <fieldset key={key} className={css.fieldset}><legend>{label}</legend>
        <TriggerParameterFields {...props} omit={undefined} depth={(props.depth ?? 0) + 1} fieldKey={fieldKey} example={asTriggerRecord(props.example[key])} value={asTriggerRecord(props.value[key])} onChange={patch} />
      </fieldset>
    }
    if (Array.isArray(value) && !value.every((item) => typeof item === 'string')) {
      return <TriggerJsonField key={key} {...props} value={value} shape="array" fieldKey={fieldKey} label={label} onChange={patch} />
    }
    if (typeof value === 'number') {
      const stored = props.fields.get(fieldKey)
      const field = stored !== undefined && (stored.error || stored.text !== stored.source || Number(stored.text) === value) ? stored : undefined
      return <FormField key={key} label={label} error={field?.error}>
        <input className={ui.configInput} aria-label={label} inputMode="decimal" readOnly={props.disabled} value={field?.text ?? String(value)} onChange={(event) => {
          if (props.disabled) return
          const text = event.target.value
          const valid = text.trim().length > 0 && Number.isFinite(Number(text))
          props.fields.set(fieldKey, { source: valid ? text : String(value), text, error: valid ? '' : props.t('triggers.number') })
          if (valid) patch(Number(text))
          props.onDraft()
        }} />
      </FormField>
    }
    if (typeof value === 'boolean') return <FormField key={key} label={label}>
      <input type="checkbox" aria-label={label} checked={value} disabled={props.disabled} onChange={(event) => patch(event.target.checked)} />
    </FormField>
    if (Array.isArray(value)) return <FormField key={key} label={label} hint={props.t('triggers.listHint')}>
      <textarea className={ui.configTextarea} aria-label={label} rows={2} readOnly={props.disabled} value={value.join('\n')}
        onChange={(event) => patch(event.target.value === '' ? [] : event.target.value.split('\n'))} />
    </FormField>
    return <FormField key={key} label={label}>
      <textarea className={ui.configTextarea} aria-label={label} rows={key === 'text' ? 3 : 1} readOnly={props.disabled} value={String(value ?? '')} onChange={(event) => patch(event.target.value)} />
    </FormField>
  })
}

export function replaceTriggerAction(rule: Record<string, unknown>, action: TriggerEditorMeta['actions'][number]): Record<string, unknown> {
  return { ...rule, channel: action.channel, phase: action.phase, do: structuredClone(action.example) }
}

export interface TriggerRuleFieldsProps extends Omit<ParameterProps, 'value' | 'example'> {
  rule: Record<string, unknown>
  meta: TriggerEditorMeta
}

export function TriggerRuleFields(props: TriggerRuleFieldsProps): ReactNode {
  const { rule, meta, t } = props
  const multi = Array.isArray(rule.do)
  const actions = multi ? rule.do as unknown[] : [rule.do]
  const action = asTriggerRecord(actions[0])
  const entry = meta.actions.find(({ kind }) => kind === action.kind)
  const unsupported = actions.some((item) => meta.actions.find(({ kind }) => kind === asTriggerRecord(item).kind)?.supportsWhen === false)
  const condition = asTriggerRecord(rule.when)
  const conditionKind = Object.keys(condition)[0] ?? ''
  const conditionEntry = meta.predicates.find(({ kind }) => kind === conditionKind)
  const patch = (next: Record<string, unknown>): void => props.onChange({ ...rule, ...next })
  const removeCondition = (): void => { const next = { ...rule }; delete next.when; props.onChange(next) }
  const clearDrafts = (suffix: string, keepJson = false): void => {
    for (const key of props.fields.keys()) if (key.startsWith(`${props.fieldKey}:${suffix}`) && (!keepJson || key !== `${props.fieldKey}:${suffix}:json`)) props.fields.delete(key)
  }
  const selectOptions = (entries: Array<{ kind: string }>, current: string) => [
    ...entries.map(({ kind }) => ({ value: kind, label: triggerLabel(t, kind) })),
    ...(current !== '' && !entries.some(({ kind }) => kind === current) ? [{ value: current, label: current }] : []),
  ]
  const base = { t, fields: props.fields, disabled: props.disabled, onDraft: props.onDraft }
  return <div data-trigger-fields>
    <fieldset className={css.fieldset}><legend>{t('triggers.when')}</legend>
      {unsupported && <p role="note">{t('triggers.unsupportedWhen')}</p>}
      <FormField label={t('triggers.conditionType')}>
        <MenuSelect ariaLabel={t('triggers.conditionType')} value={conditionKind} disabled={props.disabled || unsupported}
          options={[{ value: '', label: t('triggers.unconditional') }, ...selectOptions(meta.predicates, conditionKind)]}
          onChange={(kind) => {
            clearDrafts('when')
            if (kind === '') removeCondition()
            else { const next = meta.predicates.find((item) => item.kind === kind); if (next !== undefined) patch({ when: structuredClone(next.example) }) }
          }} />
      </FormField>
      {unsupported && rule.when != null && <button type="button" className={ui.pillButton} disabled={props.disabled} onClick={() => { clearDrafts('when'); removeCondition() }}>{t('triggers.removeWhen')}</button>}
      {!unsupported && conditionEntry !== undefined && !meta.composites.includes(conditionKind) && <TriggerParameterFields {...base}
        fieldKey={`${props.fieldKey}:when:${conditionKind}`} value={asTriggerRecord(condition[conditionKind])} example={asTriggerRecord(conditionEntry.example[conditionKind])}
        onChange={(next) => patch({ when: { ...condition, [conditionKind]: next } })} />}
      {rule.when != null && <TriggerJsonField {...base} label={t('triggers.conditionJson')} value={rule.when} shape="object" fieldKey={`${props.fieldKey}:when:json`} onChange={(when) => { clearDrafts('when', true); patch({ when }) }} />}
    </fieldset>
    <fieldset className={css.fieldset}><legend>{t('triggers.action')}</legend>
      {multi ? <p>{t('triggers.complex')}</p> : <FormField label={t('triggers.actionType')}>
        <MenuSelect ariaLabel={t('triggers.actionType')} value={String(action.kind ?? '')} disabled={props.disabled}
          options={selectOptions(meta.actions, String(action.kind ?? ''))} onChange={(kind) => {
            const next = meta.actions.find((item) => item.kind === kind)
            if (next !== undefined) { clearDrafts('do'); props.onChange(replaceTriggerAction(rule, next)) }
          }} />
      </FormField>}
      {!multi && <TriggerParameterFields {...base} omit={['kind']} fieldKey={`${props.fieldKey}:do`} value={action} example={entry?.example ?? {}} onChange={(next) => patch({ do: next })} />}
      <TriggerJsonField {...base} label={t(multi ? 'triggers.multiActions' : 'triggers.actionJson')} value={rule.do} shape={multi ? 'array' : 'object'} fieldKey={`${props.fieldKey}:do:json`} onChange={(next) => { clearDrafts('do', true); patch({ do: next }) }} />
    </fieldset>
    <p className={ui.configFieldHint}>{t('triggers.executionHint')}</p>
    <div data-trigger-execution>
      <FormField label={t('triggers.channel')}><input className={ui.configInput} aria-label={t('triggers.channel')} value={String(rule.channel ?? '')} readOnly={props.disabled} onChange={(event) => patch({ channel: event.target.value })} /></FormField>
      <FormField label={t('triggers.phase')}><input className={ui.configInput} aria-label={t('triggers.phase')} value={String(rule.phase ?? '')} readOnly={props.disabled} onChange={(event) => patch({ phase: event.target.value || undefined })} /></FormField>
      <FormField label={t('triggers.waterfall')}><MenuSelect ariaLabel={t('triggers.waterfall')} value={String(rule.waterfallPosition ?? 'default')} disabled={props.disabled}
        options={meta.waterfallPositions.map((value) => ({ value, label: triggerLabel(t, value) }))} onChange={(next) => patch({ waterfallPosition: next })} /></FormField>
      <TriggerParameterFields {...base} value={rule.channelOrder === undefined ? {} : { channelOrder: rule.channelOrder }} example={{ channelOrder: 0 }} fieldKey={props.fieldKey} onChange={(next) => patch(next)} />
    </div>
  </div>
}
