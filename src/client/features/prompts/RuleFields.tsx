import type { ReactNode } from 'react'
import type { RuleCondition, RuleEditorMeta } from '../../../shared/rules.ts'
import type { FieldDraft } from '../../data/workspace-drafts.ts'
import type { PromptToolLocaleKey, PromptToolTranslate } from '../../locales.ts'
import type { EngineMeta } from '../../prompt-tool-types.ts'
import { FormField } from '../../ui/FormField.tsx'
import { TextInput } from '../../ui/TextInput.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { Switch } from '../../ui/Switch.tsx'
import { Button } from '../../ui/Button.tsx'
import { TriggerJsonField, asTriggerRecord } from './RuleJsonField.tsx'
import { triggerLabel } from './rule-labels.ts'
import { LAYER_LABEL_KEYS, STRATEGY_LABEL_KEYS, POSITION_LABEL_KEYS, AUDIENCE_LABEL_KEYS, MODEL_SCOPE_LABEL_KEYS, SUBJECT_LABEL_KEYS, MERGE_MODE_LABEL_KEYS, DEDUPE_LABEL_KEYS, PROMOTION_LABEL_KEYS, SLOT_KIND_LABEL_KEYS, ROLE_LABEL_KEYS, FILL_LABEL_KEYS, translateLabel } from './prompt-config-policy.ts'
import ui from '../../ui/controls.module.css'
import css from './rules.module.css'

interface FieldContext { t: PromptToolTranslate; fields: Map<string, FieldDraft>; fieldKey: string; disabled?: boolean; engineMeta?: EngineMeta; onDraft: () => void }
const FIELD_LABELS: Record<string, PromptToolLocaleKey> = { layer: 'form.layer.label', strategy: 'form.strategy.label', position: 'form.position.label', audience: 'form.audience.label', modelScope: 'form.modelScope.label', subject: 'form.subject.label', mergeMode: 'form.merge.label', dedupe: 'form.dedupe.label', promotion: 'form.promotion.label', configKind: 'form.kind.label', role: 'form.role.label', fill: 'form.fill.label', order: 'form.order.label',
  // 动作字段：`decision` 与 `action` 是动作类型名之外的两份含义（裁决档 / 事后判决），不能借 triggerLabel。
  action: 'rules.actionField.action', decision: 'rules.actionField.decision', toolNames: 'rules.actionField.toolNames' }
/** 清掉某个字段前缀下的原始草稿（含嵌套键）。 */
export const cleared = (fields: Map<string, FieldDraft>, prefix: string): void => { for (const key of fields.keys()) if (key === prefix || key.startsWith(prefix + ':')) fields.delete(key) }
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
    // 动作的 config.layer 只能选引擎真正可注入的八层（tool-pipeline 只作规则级展示归属）；
    // 其余 layer 下拉（视图筛选等）仍是九层。`:config` 前缀只有 inject-text 会产生。
    const layerOptions = props.fieldKey.endsWith(':config') ? props.engineMeta?.injectionLayers : props.engineMeta?.layers
    const enums = key === 'layer' ? layerOptions : key === 'strategy' ? props.engineMeta?.strategies
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
    if (typeof value === 'boolean') return <div key={key} className={css.toggle}><span>{label}</span><span className={css.switchLine}><Switch label={label} checked={value} disabled={props.disabled} onChange={patch} /></span></div>
    const optionalNumber = requestField && ['temperature', 'maxTokens'].includes(key)
    if (typeof value === 'number' || optionalNumber) {
      const retained = props.fields.get(fieldKey)
      const draft = retained && (retained.error || retained.text !== retained.source || retained.text === String(value ?? '') || typeof value === 'number' && Number(retained.text) === value) ? retained : undefined
      return <FormField key={key} label={label} error={draft?.error}><TextInput aria-label={label} inputMode="decimal" readOnly={props.disabled} value={draft?.text ?? String(value ?? '')}
        onChange={event => { const text = event.target.value, empty = text.trim() === '', valid = optionalNumber && empty || !empty && Number.isFinite(Number(text)); props.fields.set(fieldKey, { source: valid ? text : String(value ?? ''), text, error: valid ? '' : t('triggers.number') }); if (valid) patch(empty ? undefined : Number(text)); props.onDraft() }} /></FormField>
    }
    const multiline = Array.isArray(value) || ['text', 'prompt', 'prefix', 'suffix', 'template', 'description'].includes(key)
    const text = Array.isArray(value) ? value.join('\n') : String(value ?? '')
    const edit = (next: string): void => patch(Array.isArray(value) ? next === '' ? [] : next.split('\n') : requestField && ['provider', 'model', 'reasoningEffort'].includes(key) && next === '' ? undefined : next)
    return <FormField key={key} className={multiline && !Array.isArray(value) ? css.full : undefined} label={label}>
      {multiline ? <textarea className={ui.configTextarea + (Array.isArray(value) ? ' ' + css.listControl : '')} aria-label={label} rows={Array.isArray(value) ? 2 : 3} readOnly={props.disabled} value={text} onChange={event => edit(event.target.value)} />
        : <TextInput aria-label={label} readOnly={props.disabled} value={text} onChange={event => edit(event.target.value)} />}
    </FormField>
  })
}
export function RuleConditionFields(props: FieldContext & { value: RuleCondition | undefined; meta: RuleEditorMeta; nested?: boolean; heading?: string; onRemove?: () => void; onChange: (value: RuleCondition | undefined) => void }): ReactNode {
  const { t, value, meta } = props
  const keys = Object.keys(value ?? {}), kind = keys[0] ?? '', entry = meta.predicates.find(item => item.kind === kind)
  const invalid = value !== undefined && (keys.length !== 1 || entry === undefined)
  const remove = props.onRemove ? <Button variant="outline" shape="pill" data-danger disabled={props.disabled} onClick={props.onRemove}>{t('rules.removeCondition')}</Button>
    : value !== undefined && <Button variant="outline" shape="pill" disabled={props.disabled} onClick={() => { cleared(props.fields, props.fieldKey); props.onChange(undefined) }}>{t('rules.clearCondition')}</Button>
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
      {kind !== 'not' && <Button variant="outline" shape="pill" disabled={props.disabled || first === undefined} onClick={() => { if (first) props.onChange({ [kind]: [...children, structuredClone(first.example)] }) }}>{t('rules.addCondition')}</Button>}
    </div> : entry && <div className={css.fields}><RuleParameterFields {...props} value={asTriggerRecord(value?.[kind])} example={asTriggerRecord(entry.example[kind])} fieldKey={props.fieldKey + ':' + kind} onChange={next => props.onChange({ ...value, [kind]: next })} /></div>}
    {!props.nested && !composite && value !== undefined && first && <Button variant="outline" shape="pill" disabled={props.disabled} onClick={() => {
      moveConditionDrafts(props.fields, props.fieldKey, props.fieldKey + ':all:0')
      props.onChange({ all: [value, structuredClone(first.example)] })
    }}>{t('rules.addCondition')}</Button>}
  </div>
}
