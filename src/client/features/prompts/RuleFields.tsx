import { useState, type ReactNode } from 'react'
import type { RuleAction, RuleCondition, RuleEditorMeta } from '../../../shared/rules.ts'
import type { FieldDraft } from '../../data/workspace-drafts.ts'
import type { PromptToolLocaleKey, PromptToolTranslate } from '../../locales.ts'
import type { EngineMeta } from '../../prompt-tool-types.ts'
import { FormField } from '../../ui/FormField.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { Switch } from '../../ui/Switch.tsx'
import { Button } from '../../ui/Button.tsx'
import { TriggerJsonField, asTriggerRecord } from './RuleJsonField.tsx'
import { triggerLabel } from './rule-labels.ts'
import { LAYER_LABEL_KEYS, STRATEGY_LABEL_KEYS, POSITION_LABEL_KEYS, AUDIENCE_LABEL_KEYS, MODEL_SCOPE_LABEL_KEYS, SUBJECT_LABEL_KEYS, MERGE_MODE_LABEL_KEYS, DEDUPE_LABEL_KEYS, PROMOTION_LABEL_KEYS, SLOT_KIND_LABEL_KEYS, ROLE_LABEL_KEYS, FILL_LABEL_KEYS, translateLabel } from './prompt-config-policy.ts'
import ui from '../../ui/controls.module.css'
import css from './rules.module.css'

interface FieldContext { t: PromptToolTranslate; fields: Map<string, FieldDraft>; fieldKey: string; disabled?: boolean; engineMeta?: EngineMeta; onDraft: () => void }
const FIELD_LABELS: Record<string, PromptToolLocaleKey> = { layer: 'form.layer.label', strategy: 'form.strategy.label', position: 'form.position.label', audience: 'form.audience.label', modelScope: 'form.modelScope.label', subject: 'form.subject.label', mergeMode: 'form.merge.label', dedupe: 'form.dedupe.label', promotion: 'form.promotion.label', configKind: 'form.kind.label', role: 'form.role.label', fill: 'form.fill.label', order: 'form.order.label' }
const cleared = (fields: Map<string, FieldDraft>, prefix: string): void => { for (const key of fields.keys()) if (key === prefix || key.startsWith(prefix + ':')) fields.delete(key) }
function moveConditionDrafts(fields: Map<string, FieldDraft>, from: string, to: string): void {
  const values = [...fields].filter(([key]) => key === from || key.startsWith(from + ':'))
  cleared(fields, from)
  for (const [key, value] of values) fields.set(to + key.slice(from.length), value)
}
/** 删除条件节点时，同步移动仍保留的原始字段草稿。 */
export function removeConditionDraft(fields: Map<string, FieldDraft>, prefix: string, index: number): void {
  const retained = [...fields]
  cleared(fields, prefix)
  for (const [key, value] of retained) {
    if (!key.startsWith(prefix + ':')) continue
    const tail = key.slice(prefix.length + 1), separator = tail.indexOf(':')
    const part = separator < 0 ? tail : tail.slice(0, separator), at = Number(part)
    if (!/^\d+$/.test(part) || at < index) fields.set(key, value)
    else if (at > index) fields.set(prefix + ':' + (at - 1) + (separator < 0 ? '' : tail.slice(separator)), value)
  }
}
/** 标量就地编辑，对象平铺；未知字段随对象保留，深结构用 JSON。 */
export function RuleParameterFields(props: FieldContext & { value: Record<string, unknown>; example?: Record<string, unknown>; omit?: string[]; configOmit?: string[]; depth?: number; requestPatch?: boolean; onChange: (value: Record<string, unknown>) => void }): ReactNode {
  const { t } = props
  return Object.entries({ ...props.example, ...props.value }).map(([key, value]) => {
    if (props.omit?.includes(key)) return null
    const fieldKey = props.fieldKey + ':' + key, label = FIELD_LABELS[key] === undefined ? triggerLabel(t, key) : t(FIELD_LABELS[key])
    const patch = (next: unknown): void => { const value = { ...props.value }; if (next === undefined) delete value[key]; else value[key] = next; props.onChange(value) }
    const requestField = props.requestPatch && props.fieldKey.endsWith(':patch')
    const enums = key === 'layer' ? props.engineMeta?.layers : key === 'strategy' ? props.engineMeta?.strategies
      : key === 'position' ? props.engineMeta?.positions : key === 'audience' ? ['', ...(props.engineMeta?.audienceModes ?? [])]
        : key === 'modelScope' ? props.engineMeta?.modelScopes : key === 'subject' ? props.engineMeta?.subjects
          : key === 'mergeMode' ? props.engineMeta?.mergeModes : key === 'dedupe' ? props.engineMeta?.dedupes
            : key === 'promotion' ? props.engineMeta?.promotions : key === 'configKind' ? props.engineMeta?.slotKinds
              : key === 'role' ? props.engineMeta?.roles : key === 'fill' ? props.engineMeta?.fills : undefined
    const labels = key === 'layer' ? LAYER_LABEL_KEYS : key === 'strategy' ? STRATEGY_LABEL_KEYS : key === 'position' ? POSITION_LABEL_KEYS
      : key === 'modelScope' ? MODEL_SCOPE_LABEL_KEYS : key === 'subject' ? SUBJECT_LABEL_KEYS
        : key === 'mergeMode' ? MERGE_MODE_LABEL_KEYS : key === 'dedupe' ? DEDUPE_LABEL_KEYS : key === 'promotion' ? PROMOTION_LABEL_KEYS
          : key === 'configKind' ? SLOT_KIND_LABEL_KEYS : key === 'role' ? ROLE_LABEL_KEYS : key === 'fill' ? FILL_LABEL_KEYS : AUDIENCE_LABEL_KEYS
    if (enums !== undefined && typeof value === 'string') return <FormField key={key} label={label}><MenuSelect compact ariaLabel={label} className={css.control} value={value} disabled={props.disabled}
      options={[...new Set([...enums, value])].map(item => ({ value: item, label: translateLabel(t, labels, item) }))} onChange={next => patch(key === 'audience' && next === '' ? undefined : next)} /></FormField>
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return (props.depth ?? 0) < 2
      ? <div key={key} className={css.parameterGroup}>{key !== 'config' && <h5>{label}</h5>}<div className={css.fields}><RuleParameterFields {...props} depth={(props.depth ?? 0) + 1} omit={key === 'config' ? props.configOmit : undefined} fieldKey={fieldKey} value={asTriggerRecord(value)} example={asTriggerRecord(props.example?.[key])} onChange={patch} /></div></div>
      : <div key={key} className={css.full}><TriggerJsonField {...props} value={value} shape="object" fieldKey={fieldKey} label={label} onChange={patch} /></div>
    if (Array.isArray(value) && !value.every(item => typeof item === 'string')) return <div key={key} className={css.full}><TriggerJsonField {...props} value={value} shape="array" fieldKey={fieldKey} label={label} onChange={patch} /></div>
    if (typeof value === 'boolean') return <div key={key} className={css.toggle}><span>{label}</span><span className={css.switchLine}><Switch className={css.switchTarget} label={label} checked={value} disabled={props.disabled} onChange={patch} /></span></div>
    const optionalNumber = requestField && ['temperature', 'maxTokens'].includes(key)
    if (typeof value === 'number' || optionalNumber) {
      const retained = props.fields.get(fieldKey)
      const draft = retained && (retained.error || retained.text !== retained.source || retained.text === String(value ?? '') || typeof value === 'number' && Number(retained.text) === value) ? retained : undefined
      return <FormField key={key} label={label} error={draft?.error}><input className={ui.configInput + ' ' + css.number} aria-label={label} inputMode="decimal" readOnly={props.disabled} value={draft?.text ?? String(value ?? '')}
        onChange={event => { const text = event.target.value, empty = text.trim() === '', valid = optionalNumber && empty || !empty && Number.isFinite(Number(text)); props.fields.set(fieldKey, { source: valid ? text : String(value ?? ''), text, error: valid ? '' : t('triggers.number') }); if (valid) patch(empty ? undefined : Number(text)); props.onDraft() }} /></FormField>
    }
    const multiline = Array.isArray(value) || ['text', 'prompt', 'prefix', 'suffix', 'template', 'description'].includes(key)
    const text = Array.isArray(value) ? value.join('\n') : String(value ?? '')
    const edit = (next: string): void => patch(Array.isArray(value) ? next === '' ? [] : next.split('\n') : requestField && ['provider', 'model', 'reasoningEffort'].includes(key) && next === '' ? undefined : next)
    return <FormField key={key} className={multiline && !Array.isArray(value) ? css.full : undefined} label={label}>
      {multiline ? <textarea className={ui.configTextarea + (Array.isArray(value) ? ' ' + css.listControl : '')} aria-label={label} rows={Array.isArray(value) ? 2 : 3} readOnly={props.disabled} value={text} onChange={event => edit(event.target.value)} />
        : <input className={ui.configInput + ' ' + css.control} aria-label={label} readOnly={props.disabled} value={text} onChange={event => edit(event.target.value)} />}
    </FormField>
  })
}
export function RuleConditionFields(props: FieldContext & { value: RuleCondition | undefined; meta: RuleEditorMeta; nested?: boolean; heading?: string; onRemove?: () => void; onChange: (value: RuleCondition | undefined) => void }): ReactNode {
  const { t, value, meta } = props
  const keys = Object.keys(value ?? {}), kind = keys[0] ?? '', entry = meta.predicates.find(item => item.kind === kind)
  const invalid = value !== undefined && (keys.length !== 1 || entry === undefined)
  const remove = props.onRemove ? <Button variant="outline" className={css.button} data-danger disabled={props.disabled} onClick={props.onRemove}>{t('rules.removeCondition')}</Button>
    : value !== undefined && <Button variant="outline" className={css.button} disabled={props.disabled} onClick={() => { cleared(props.fields, props.fieldKey); props.onChange(undefined) }}>{t('rules.clearCondition')}</Button>
  if (invalid) return <div className={css.full}><div className={css.conditionHead}>{props.heading && <span className={css.conditionOrdinal}>{props.heading}</span>}{remove}</div><p role="note">{t('rules.unknown')}</p><TriggerJsonField {...props} value={value} shape="object" label={t('triggers.conditionJson')} onChange={next => props.onChange(asTriggerRecord(next))} /></div>
  const children = kind === 'not' ? [asTriggerRecord(value?.not)] : Array.isArray(value?.[kind]) ? value[kind] as RuleCondition[] : []
  const composite = meta.composites.includes(kind)
  const first = meta.predicates.find(item => !meta.composites.includes(item.kind))
  const selectKind = (next: string): void => {
    if (value !== undefined && meta.composites.includes(next)) {
      if (next === 'not') {
        moveConditionDrafts(props.fields, props.fieldKey, props.fieldKey + ':not:0')
        props.onChange({ not: value })
      } else if (composite) {
        moveConditionDrafts(props.fields, props.fieldKey + ':' + kind, props.fieldKey + ':' + next)
        props.onChange({ [next]: children })
      } else {
        moveConditionDrafts(props.fields, props.fieldKey, props.fieldKey + ':' + next + ':0')
        props.onChange({ [next]: [value] })
      }
      return
    }
    cleared(props.fields, props.fieldKey)
    const selected = meta.predicates.find(item => item.kind === next)
    props.onChange(selected === undefined ? undefined : structuredClone(selected.example))
  }
  const updateChild = (index: number, next: RuleCondition | undefined): void => {
    if (next === undefined) { removeConditionDraft(props.fields, props.fieldKey + ':' + kind, index); props.onChange(kind === 'not' || children.length === 1 ? undefined : { [kind]: children.filter((_, at) => at !== index) }); return }
    props.onChange({ [kind]: kind === 'not' ? next : children.map((child, at) => at === index ? next : child) })
  }
  return <div className={css.condition} data-rule-condition={props.fieldKey}>
    <div className={css.conditionHead}>{props.heading && <span className={css.conditionOrdinal}>{props.heading}</span>}<FormField label={t('triggers.conditionType')}><MenuSelect compact className={css.control} ariaLabel={t('triggers.conditionType')} value={kind} disabled={props.disabled}
      options={[{ value: '', label: t('triggers.unconditional') }, ...meta.predicates.map(item => ({ value: item.kind, label: triggerLabel(t, item.kind) }))]}
      onChange={selectKind} /></FormField>
      {remove}
    </div>
    {composite ? <div className={css.conditions}>
      {children.map((child, index) => <div key={index} className={css.conditionChild} role="group" aria-label={t('rules.condition', { index: index + 1 })}>
        <RuleConditionFields {...props} value={child} nested heading={t('rules.condition', { index: index + 1 })} onRemove={() => updateChild(index, undefined)} fieldKey={props.fieldKey + ':' + kind + ':' + index} onChange={next => updateChild(index, next)} /></div>)}
      {kind !== 'not' && <Button variant="outline" className={css.button} disabled={props.disabled || first === undefined} onClick={() => { if (first) props.onChange({ [kind]: [...children, structuredClone(first.example)] }) }}>{t('rules.addCondition')}</Button>}
    </div> : entry && <div className={css.fields}><RuleParameterFields {...props} value={asTriggerRecord(value?.[kind])} example={asTriggerRecord(entry.example[kind])} fieldKey={props.fieldKey + ':' + kind} onChange={next => props.onChange({ ...value, [kind]: next })} /></div>}
    {!props.nested && !composite && value !== undefined && first && <Button variant="outline" className={css.button} disabled={props.disabled} onClick={() => {
      moveConditionDrafts(props.fields, props.fieldKey, props.fieldKey + ':all:0')
      props.onChange({ all: [value, structuredClone(first.example)] })
    }}>{t('rules.addCondition')}</Button>}
  </div>
}
export function RuleActionsFields(props: FieldContext & { value: RuleAction[]; meta: RuleEditorMeta; engineMeta: EngineMeta; conditional: boolean; onChange: (value: RuleAction[]) => void }): ReactNode {
  const { t, meta } = props
  const [addKind, setAddKind] = useState('inject-text')
  const selectable = meta.actions.filter(action => !props.conditional || action.supportsWhen)
  const selected = selectable.find(action => action.kind === addKind) ?? selectable[0]
  const swap = (index: number, offset: number): void => { const next = [...props.value]; [next[index], next[index + offset]] = [next[index + offset]!, next[index]!]; props.onChange(next) }
  return <div className={css.actions}>
    {props.value.map((action, index) => {
      const entry = meta.actions.find(item => item.kind === action.kind), fieldKey = props.fieldKey + ':' + action.id
      const config = asTriggerRecord(action.config), params = asTriggerRecord(config.params)
      const layer = String(config.layer ?? 'pre-step'), policy = props.engineMeta.layerFieldPolicies[layer]
      const staticAudience = layer === 'system-section' && (params.complete === true || params.suppressRuntimeContext === true)
      const example = action.kind === 'request-params' ? { ...entry?.example, patch: { provider: '', model: '', reasoningEffort: '', temperature: undefined, maxTokens: undefined } }
        : action.kind === 'inject-text' ? { ...entry?.example, config: { strategy: 'static', configKind: 'ordered', ...(policy?.merge ? { mergeMode: 'separate' } : {}), ...(policy?.position ? { position: 'after-user' } : {}), ...(staticAudience ? { audience: '' } : {}), ...asTriggerRecord(entry?.example.config) } }
          : entry?.example
      const patch = (next: Record<string, unknown>): void => props.onChange(props.value.map((item, at) => at === index ? { ...next, id: action.id, kind: String(next.kind ?? action.kind) } : item))
      return <section key={action.id || index} className={css.action} data-rule-action={action.id}>
        <div className={css.actionHead}><h4>{t('rules.action', { index: index + 1 })}</h4><MenuSelect compact className={css.control} ariaLabel={t('triggers.actionType')} value={action.kind} disabled={props.disabled}
          options={[...new Set([...selectable.map(item => item.kind), action.kind])].map(kind => ({ value: kind, label: triggerLabel(t, kind) }))}
          onChange={kind => { const next = meta.actions.find(item => item.kind === kind); if (next) { cleared(props.fields, fieldKey); patch({ ...structuredClone(next.example), id: action.id, kind }) } }} />
          <Button variant="outline" className={css.button + ' ' + css.iconButton} aria-label={t('rules.moveUp', { id: action.id })} disabled={props.disabled || index === 0} onClick={() => swap(index, -1)}>↑</Button>
          <Button variant="outline" className={css.button + ' ' + css.iconButton} aria-label={t('rules.moveDown', { id: action.id })} disabled={props.disabled || index === props.value.length - 1} onClick={() => swap(index, 1)}>↓</Button>
          <Button variant="outline" className={css.button} data-danger aria-label={t('rules.removeAction', { id: action.id })} disabled={props.disabled} onClick={() => { cleared(props.fields, fieldKey); props.onChange(props.value.filter((_, at) => at !== index)) }}>{t('rules.removeActionShort')}</Button>
        </div>
        {entry === undefined ? <><p role="note">{t('rules.unknown')}</p><TriggerJsonField {...props} fieldKey={fieldKey} label={t('rules.rawAction')} shape="object" value={action} onChange={next => patch(asTriggerRecord(next))} /></>
          : <div className={css.fields}><RuleParameterFields {...props} fieldKey={fieldKey} value={action} requestPatch={action.kind === 'request-params'}
            example={example}
            omit={['id', 'kind', ...(action.kind === 'request-params' ? ['audience', 'modelScope'] : [])]}
            configOmit={action.kind === 'inject-text' ? ['modelScope', 'promotion', 'subject', 'match', ...staticAudience ? [] : ['audience']] : undefined} onChange={patch} /></div>}
      </section>
    })}
    <div className={css.row}><MenuSelect compact className={css.control} ariaLabel={t('rules.addAction')} value={selected?.kind ?? ''} disabled={props.disabled || selectable.length === 0} options={selectable.map(action => ({ value: action.kind, label: triggerLabel(t, action.kind) }))} onChange={setAddKind} />
      <Button variant="outline" className={css.button} disabled={props.disabled || selected === undefined} onClick={() => { if (!selected) return; let number = 1; while (props.value.some(action => action.id === 'action-' + number)) number++; props.onChange([...props.value, { ...structuredClone(selected.example), id: 'action-' + number, kind: selected.kind }]) }}>{t('rules.addAction')}</Button>
    </div>
  </div>
}
