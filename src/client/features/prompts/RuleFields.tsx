import { useState, type ReactNode } from 'react'
import type { RuleCondition, RuleEditorMeta } from '../../../shared/rules.ts'
import { cleared, type FieldDraft } from '../../data/workspace-drafts.ts'
import { changeHostCapability } from '../../data/host-control-policy.ts'
import type { PromptToolLocaleKey, PromptToolTranslate } from '../../locales.ts'
import type { EngineMeta } from '../../prompt-tool-types.ts'
import { FormField } from '../../ui/FormField.tsx'
import { TextInput } from '../../ui/TextInput.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { Switch } from '../../ui/Switch.tsx'
import { Button } from '../../ui/Button.tsx'
import { TagInput } from '../../ui/TagInput.tsx'
import { TriggerJsonField, asTriggerRecord } from './RuleJsonField.tsx'
import { triggerLabel, ruleFieldOptions } from './rule-labels.ts'
import { StepAdd, type StepCreation } from './RuleStepCard.tsx'
import { LAYER_LABEL_KEYS, STRATEGY_LABEL_KEYS, POSITION_LABEL_KEYS, AUDIENCE_LABEL_KEYS, MODEL_SCOPE_LABEL_KEYS, SUBJECT_LABEL_KEYS, MERGE_MODE_LABEL_KEYS, DEDUPE_LABEL_KEYS, PROMOTION_LABEL_KEYS, SLOT_KIND_LABEL_KEYS, ROLE_LABEL_KEYS, FILL_LABEL_KEYS, translateLabel } from './prompt-config-policy.ts'
import ui from '../../ui/controls.module.css'
import css from './rules.module.css'

export interface FieldContext { t: PromptToolTranslate; fields: Map<string, FieldDraft>; fieldKey: string; disabled?: boolean; engineMeta?: EngineMeta; onDraft: () => void }
const FIELD_LABELS: Record<string, PromptToolLocaleKey> = { layer: 'form.layer.label', strategy: 'form.strategy.label', position: 'form.position.label', audience: 'form.audience.label', modelScope: 'form.modelScope.label', subject: 'form.subject.label', mergeMode: 'form.merge.label', dedupe: 'form.dedupe.label', promotion: 'form.promotion.label', configKind: 'form.kind.label', role: 'form.role.label', fill: 'form.fill.label', order: 'form.order.label',
  // 动作字段：tool-gate 的 `decision` 与 tool-result 的 `action` 是动作类型名之外的两份含义，不能借 triggerLabel。
  action: 'rules.actionField.action', decision: 'rules.actionField.decision' }
const INJECTION_PLACEMENT = new Set(['layer', 'position', 'mergeMode', 'role', 'order', 'subject', 'audience', 'dedupe'])
export { cleared } from '../../data/workspace-drafts.ts'
function moveConditionDrafts<T>(fields: Map<string, T>, from: string, to: string): void {
  const values = [...fields].filter(([key]) => key === from || key.startsWith(from + ':'))
  cleared(fields, from)
  for (const [key, value] of values) fields.set(to + key.slice(from.length), value)
}

/** 删除条件节点时，同步移动仍保留的原始字段草稿。 */
export function removeConditionDraft<T>(fields: Map<string, T>, prefix: string, index: number): void {
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
export function RuleParameterFields(props: FieldContext & { value: Record<string, unknown>; example?: Record<string, unknown>; omit?: string[]; configOmit?: string[]; depth?: number; injectionConfig?: boolean; requestPatch?: boolean; readLimits?: boolean; delegationLimits?: boolean; onChange: (value: Record<string, unknown>) => void }): ReactNode {
  const { t } = props
  const values = Object.entries({ ...props.example, ...props.value }).filter(([key]) => !props.omit?.includes(key))
  const renderField = ([key, mergedValue]: [string, unknown]): ReactNode => {
    if (props.value.kind === 'tool-result' && props.value.action === 'edit-text' && key === 'text') return null
    const readLimitField = props.readLimits === true && ['maxLineLength', 'maxBytes', 'limit'].includes(key)
    const delegationLimitField = props.delegationLimits === true && ['maxDepth', 'askTimeout'].includes(key)
    const value = readLimitField || delegationLimitField ? props.value[key] : mergedValue
    const fieldKey = props.fieldKey + ':' + key, label = props.injectionConfig && key === 'text' ? t('form.text.label') : readLimitField ? t(key === 'maxLineLength' ? 'triggers.label.readMaxLineLength' : key === 'maxBytes' ? 'triggers.label.readMaxBytes' : 'triggers.label.readLimit') : props.value.kind === 'host-control' && key === 'value' ? t('triggers.label.readLimitsValue') : props.value.kind === 'subagent-params' && key === 'tool' ? t('triggers.label.delegationTool') : props.value.kind === 'subagent-params' && key === 'provider' ? t('triggers.label.delegationProvider') : key === 'action' && props.fieldKey.endsWith(':anchor:after') ? t('triggers.label.afterAction') : FIELD_LABELS[key] === undefined ? triggerLabel(t, key) : t(FIELD_LABELS[key])
    const patch = (next: unknown): void => {
      if (key === 'capability' && props.value.kind === 'host-control') {
        props.onChange(changeHostCapability(props.value, next, props))
        return
      }
      const updated = { ...props.value }
      if (next === undefined) delete updated[key]; else updated[key] = next
      if (key === 'action' && props.value.kind === 'tool-result') {
        if (next === 'edit-text') {
          delete updated.text
          cleared(props.fields, props.fieldKey + ':text')
          if (!Array.isArray(updated.edits) || updated.edits.length === 0) updated.edits = [{ region: 'web-notice', match: '', text: '' }]
        } else {
          delete updated.edits
          cleared(props.fields, props.fieldKey + ':edits')
          if ((next === 'replace' || next === 'block') && updated.text === undefined) updated.text = ''
        }
      }
      props.onChange(updated)
    }
    const requestField = props.requestPatch && props.fieldKey.endsWith(':patch')
    const choices = ruleFieldOptions(t, String(props.value.id === undefined ? props.fieldKey.split(':').at(-1) ?? '' : props.value.kind ?? ''), key)
    if (choices !== undefined && typeof value === 'string') return <FormField key={key} label={label}><MenuSelect compact ariaLabel={label} value={value} disabled={props.disabled}
      options={choices.some(option => option.value === value) ? choices : [...choices, { value, label: value }]} onChange={patch} /></FormField>
    // 动作的 config.layer 只能选引擎真正可注入的六层；
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
      ? <div key={key} className={css.parameterGroup}>{key !== 'config' && <h5>{props.value.kind === 'host-control' && props.value.capability === 'delegation-limits' && key === 'value' ? t('triggers.option.delegation-limits') : label}</h5>}<div className={css.fields}><RuleParameterFields {...props} injectionConfig={props.value.kind === 'inject-text' && key === 'config'} readLimits={props.value.kind === 'host-control' && props.value.capability === 'file-read-limits' && key === 'value'} delegationLimits={props.value.kind === 'host-control' && props.value.capability === 'delegation-limits' && key === 'value'} depth={(props.depth ?? 0) + 1} omit={key === 'config' ? props.configOmit : undefined} fieldKey={fieldKey} value={asTriggerRecord(value)} example={props.value.kind === 'host-control' && props.value.capability === 'delegation-limits' && key === 'value' ? { maxDepth: 10, askTimeout: 300 } : asTriggerRecord(props.example?.[key])} onChange={patch} /></div></div>
      : <div key={key} className={css.full}><TriggerJsonField {...props} value={value} shape="object" fieldKey={fieldKey} label={label} onChange={patch} /></div>
    if (Array.isArray(value) && (key === 'match' || key === 'edits' && props.value.kind === 'tool-result' || !value.every(item => typeof item === 'string'))) return <div key={key} className={css.full}><TriggerJsonField {...props} value={value} shape="array" fieldKey={fieldKey} label={label} onChange={patch} /></div>
    if (Array.isArray(value)) return <div key={key} className={css.full}><TagInput label={label} value={value} disabled={props.disabled}
      placeholder={t('rules.tokens.placeholder')} removeLabel={tag => t('rules.tokens.remove', { tag })} onChange={patch} /></div>
    if (typeof value === 'boolean') return <div key={key} className={css.toggle}><span>{label}</span><span className={css.switchLine}><Switch label={label} checked={value} disabled={props.disabled} onChange={patch} /></span></div>
    const fallbackNumber = key === 'fallbackAfter' && props.fieldKey.endsWith(':anchor')
    const textLength = ['minChars', 'maxChars'].includes(key) && props.fieldKey.endsWith(':text')
    const instructionsBudget = readLimitField || key === 'maxPromoteSteps' || key === 'maxTokens' && !requestField
    const delegationDepth = key === 'maxDepth'
    const optionalNumber = readLimitField || delegationLimitField || requestField && ['temperature', 'maxTokens'].includes(key)
    if (typeof value === 'number' || optionalNumber) {
      const retained = props.fields.get(fieldKey)
      const draft = retained && (retained.error || retained.text !== retained.source || retained.text === String(value ?? '') || typeof value === 'number' && Number(retained.text) === value) ? retained : undefined
      return <FormField key={key} label={label} hint={readLimitField ? t(key === 'maxLineLength' ? 'triggers.hint.readMaxLineLength' : key === 'maxBytes' ? 'triggers.hint.readMaxBytes' : 'triggers.hint.readLimit') : undefined} hintMode={readLimitField ? 'tooltip' : undefined} error={draft?.error}><TextInput aria-label={label} inputMode="decimal" readOnly={props.disabled} value={draft?.text ?? String(value ?? '')}
        onChange={event => { const text = event.target.value, empty = text.trim() === '', valid = optionalNumber && empty || !empty && Number.isFinite(Number(text)) && (!fallbackNumber || Number.isInteger(Number(text)) && Number(text) > 0) && (!textLength || Number.isSafeInteger(Number(text)) && Number(text) >= 0) && (!instructionsBudget || Number.isSafeInteger(Number(text)) && Number(text) > 0) && (!delegationDepth || Number.isSafeInteger(Number(text)) && Number(text) >= 0) && (!(delegationLimitField && key === 'askTimeout') || Number.isInteger(Number(text)) && Number(text) >= 1 && Number(text) <= 2147483); props.fields.set(fieldKey, { source: valid ? text : String(value ?? ''), text, error: valid ? '' : t('triggers.number') }); if (valid) patch(empty ? undefined : Number(text)); props.onDraft() }} /></FormField>
    }
    const multiline = ['text', 'prompt', 'prefix', 'suffix', 'template', 'description', 'instructionHint'].includes(key)
    const text = String(value ?? '')
    const edit = (next: string): void => patch(requestField && ['provider', 'model', 'reasoningEffort'].includes(key) && next === '' ? undefined : next)
    return <FormField key={key} className={multiline ? css.full : undefined} label={label}>
      {multiline ? <textarea className={props.injectionConfig && key === 'text' ? `${ui.configTextarea} ${css.inspectorPrompt}` : ui.configTextarea} aria-label={label} rows={3} readOnly={props.disabled} value={text} onChange={event => edit(event.target.value)} />
        : <TextInput aria-label={label} readOnly={props.disabled} value={text} onChange={event => edit(event.target.value)} />}
    </FormField>
  }
  if (!props.injectionConfig) return values.map(renderField)
  const placement = values.filter(([key]) => INJECTION_PLACEMENT.has(key))
  const content = values.filter(([key]) => !INJECTION_PLACEMENT.has(key))
  const textIndex = content.findIndex(([key]) => key === 'text')
  if (textIndex > 0) content.unshift(...content.splice(textIndex, 1))
  return <>
    {content.length > 0 && <fieldset className={css.inspectorGroup}><legend>{t('form.section.content')}</legend><div className={css.fields}>{content.map(renderField)}</div></fieldset>}
    {placement.length > 0 && <fieldset className={css.inspectorGroup}><legend>{t('rules.injectionPlacement')}</legend><div className={css.fields}>{placement.map(renderField)}</div></fieldset>}
  </>
}
export function RuleConditionFields(props: FieldContext & { expanded: Map<string, boolean>; prefix: string; creation: StepCreation; value: RuleCondition | undefined; meta: RuleEditorMeta; nested?: boolean; childrenLinks?: ReactNode; onChange: (value: RuleCondition | undefined) => void }): ReactNode {
  const { t, value, meta } = props
  const [addKind, setAddKind] = useState('')
  const viewKey = (path: string): string => `${props.prefix}:${path}`
  const move = (from: string, to: string): void => {
    moveConditionDrafts(props.fields, from, to)
    moveConditionDrafts(props.expanded, viewKey(from), viewKey(to))
  }
  const clearChildren = (): void => {
    for (const key of props.expanded.keys()) if (key.startsWith(viewKey(props.fieldKey) + ':')) props.expanded.delete(key)
  }
  const keys = Object.keys(value ?? {}), kind = keys[0] ?? '', entry = meta.predicates.find(item => item.kind === kind)
  const invalid = value !== undefined && (keys.length !== 1 || entry === undefined)
  if (invalid) return <div className={css.full}><p role="note">{t('rules.unknown')}</p><TriggerJsonField {...props} value={value} shape="object" label={t('triggers.conditionJson')} onChange={next => props.onChange(asTriggerRecord(next))} /></div>
  const children = kind === 'not' ? [asTriggerRecord(value?.not)] : Array.isArray(value?.[kind]) ? value[kind] as RuleCondition[] : []
  const composite = meta.composites.includes(kind)
  const first = meta.predicates.find(item => !meta.composites.includes(item.kind))
  const selected = meta.predicates.find(item => item.kind === addKind) ?? first
  const add = kind !== 'not' && (composite || !props.nested && value !== undefined) && <StepAdd
    creation={props.creation} path={props.fieldKey} label={t('rules.addCondition')} disabled={props.disabled}>
    <MenuSelect compact ariaLabel={t('rules.steps.addConditionType')} value={selected?.kind ?? ''} disabled={props.disabled || selected === undefined}
      options={meta.predicates.map(item => ({ value: item.kind, label: triggerLabel(t, item.kind === 'tool' ? 'toolReady' : item.kind) }))} onChange={setAddKind} />
    <Button variant="outline" shape="pill" disabled={props.disabled || selected === undefined} onClick={() => {
      if (!selected || value === undefined) return
      if (composite) {
        props.expanded.set(viewKey(props.fieldKey + ':' + kind + ':' + children.length), true)
        props.onChange({ [kind]: [...children, structuredClone(selected.example)] })
      } else {
        move(props.fieldKey, props.fieldKey + ':all:0')
        props.expanded.set(viewKey(props.fieldKey), true)
        props.expanded.set(viewKey(props.fieldKey + ':all:1'), true)
        props.onChange({ all: [value, structuredClone(selected.example)] })
      }
    }}>{t('rules.addCondition')}</Button>
  </StepAdd>
  const selectKind = (next: string): void => {
    if (value !== undefined && meta.composites.includes(next)) {
      if (next === 'not') {
        move(props.fieldKey, props.fieldKey + ':not:0')
        props.expanded.set(viewKey(props.fieldKey), true)
        props.onChange({ not: value })
      } else if (composite) {
        move(props.fieldKey + ':' + kind, props.fieldKey + ':' + next)
        props.onChange({ [next]: children })
      } else {
        move(props.fieldKey, props.fieldKey + ':' + next + ':0')
        props.expanded.set(viewKey(props.fieldKey), true)
        props.onChange({ [next]: [value] })
      }
      return
    }
    cleared(props.fields, props.fieldKey)
    clearChildren()
    const selected = meta.predicates.find(item => item.kind === next)
    props.onChange(selected === undefined ? undefined : structuredClone(selected.example))
  }
  return <div className={css.condition} data-rule-condition={props.fieldKey}>
    <FormField label={t('triggers.conditionType')}><MenuSelect compact className={css.control} ariaLabel={t('triggers.conditionType')} value={kind} disabled={props.disabled}
      options={[{ value: '', label: t('triggers.unconditional') }, ...meta.predicates.map(item => ({ value: item.kind, label: triggerLabel(t, item.kind) }))]}
      onChange={selectKind} /></FormField>
    {composite ? props.childrenLinks : entry && <div className={css.fields}>
      {(kind === 'anchor' ? ['after', 'fallbackAfter'] : kind === 'text' ? ['minChars', 'maxChars'] : []).map(key => {
        const parameters = asTriggerRecord(value?.[kind]), present = Object.hasOwn(parameters, key)
        return <div key={key} className={css.toggle}><span>{triggerLabel(t, key)}</span><Switch label={triggerLabel(t, key)} checked={present} disabled={props.disabled} onChange={enabled => {
          const next = { ...parameters }
          if (enabled) next[key] = key === 'after' ? { action: '' } : key === 'fallbackAfter' ? 1 : 0
          else { delete next[key]; cleared(props.fields, props.fieldKey + ':' + kind + ':' + key) }
          props.onChange({ ...value, [kind]: next })
        }} /></div>
      })}
      <RuleParameterFields {...props} value={asTriggerRecord(value?.[kind])} example={Object.fromEntries(Object.entries(asTriggerRecord(entry.example[kind])).filter(([key]) => !(kind === 'anchor' ? ['after', 'fallbackAfter'] : kind === 'text' ? ['minChars', 'maxChars'] : []).includes(key)))} fieldKey={props.fieldKey + ':' + kind} onChange={next => props.onChange({ ...value, [kind]: next })} />
    </div>}
    {add}
  </div>
}
