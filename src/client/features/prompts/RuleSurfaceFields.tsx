import type { ReactNode } from 'react'
import type { PromptToolLocaleKey } from '../../locales.ts'
import { Button } from '../../ui/Button.tsx'
import { FormField } from '../../ui/FormField.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { Switch } from '../../ui/Switch.tsx'
import { TagInput } from '../../ui/TagInput.tsx'
import { TextInput } from '../../ui/TextInput.tsx'
import { RuleParameterFields, cleared, type FieldContext } from './RuleFields.tsx'
import { TriggerJsonField, asTriggerRecord } from './RuleJsonField.tsx'
import { CloseButton } from './RuleStepCard.tsx'
import ui from '../../ui/controls.module.css'
import css from './rules.module.css'

type RecordValue = Record<string, unknown>
type SurfaceProps = FieldContext & { value: RecordValue; onChange: (value: RecordValue) => void }
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value)
const names = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')

function patched(value: RecordValue, patch: RecordValue): RecordValue {
  const next = { ...value, ...patch }
  for (const key of Object.keys(patch)) if (patch[key] === undefined) delete next[key]
  return next
}

/** 名单始终以数组保存；未声明与显式空名单由模式选择器区分。 */
function NameList(props: FieldContext & { label: string; value: unknown; onChange: (value: unknown) => void }): ReactNode {
  if (props.value !== undefined && !names(props.value)) return <TriggerJsonField {...props} shape="array" />
  return <TagInput label={props.label} value={props.value ?? []} disabled={props.disabled}
    placeholder={props.t('rules.tokens.placeholder')} removeLabel={tag => props.t('rules.tokens.remove', { tag })} onChange={props.onChange} />
}

function Mode(props: { t: SurfaceProps['t']; label: string; value: string; options: [string, PromptToolLocaleKey][]; disabled?: boolean; onChange: (value: string) => void }): ReactNode {
  return <FormField label={props.label}><MenuSelect compact ariaLabel={props.label} value={props.value} disabled={props.disabled}
    options={props.options.map(([value, label]) => ({ value, label: props.t(label) }))} onChange={props.onChange} /></FormField>
}

function ToolsFields(props: SurfaceProps): ReactNode {
  const { t, value } = props
  const dynamic = value.allowFrom !== undefined
  const mode = value.deny !== undefined && !dynamic ? 'deny' : 'allow'
  const patch = (change: RecordValue): void => props.onChange(patched(value, change))
  return <>
    <Mode {...props} label={t('rules.surface.toolMode')} value={mode} options={[[ 'allow', 'rules.surface.allow' ], [ 'deny', 'rules.surface.deny' ]]}
      onChange={next => { cleared(props.fields, props.fieldKey); patch({ allow: undefined, deny: undefined, [next]: value[mode] ?? [], ...(next === 'deny' ? { allowFrom: undefined } : {}) }) }} />
    <NameList {...props} fieldKey={`${props.fieldKey}:${mode}`} label={t(mode === 'allow' ? 'rules.surface.fixedTools' : 'rules.surface.deniedTools')}
      value={value[mode]} onChange={next => patch({ [mode]: next, [mode === 'allow' ? 'deny' : 'allow']: undefined })} />
    {(mode === 'allow' || dynamic) && <div className={css.surfaceGroup}>
      <div className={css.surfaceSwitchRow}><span>{t('rules.surface.dynamic')}</span><Switch label={t('rules.surface.dynamic')} checked={dynamic} disabled={props.disabled}
        onChange={enabled => { cleared(props.fields, `${props.fieldKey}:allowFrom`); patch({ allowFrom: enabled ? { tool: '', key: '' } : undefined, ...(enabled || value.allow !== undefined || value.deny !== undefined ? {} : { allow: [] }) }) }} /></div>
      {dynamic && (record(value.allowFrom) ? <>
        <div className={css.surfaceColumns}>{(['tool', 'key'] as const).map(key => <FormField key={key} label={t(key === 'tool' ? 'rules.surface.discoveryTool' : 'rules.surface.argumentKey')}>
          <TextInput aria-label={t(key === 'tool' ? 'rules.surface.discoveryTool' : 'rules.surface.argumentKey')} readOnly={props.disabled}
            placeholder={key === 'tool' ? 'tool_search' : 'toolNames'} value={String(asTriggerRecord(value.allowFrom)[key] ?? '')}
            onChange={event => patch({ allowFrom: { ...asTriggerRecord(value.allowFrom), [key]: event.target.value } })} />
        </FormField>)}</div>
        <RuleParameterFields {...props} value={value.allowFrom} omit={['tool', 'key']} fieldKey={`${props.fieldKey}:allowFrom`} onChange={next => patch({ allowFrom: next })} />
      </> : <TriggerJsonField {...props} label={t('rules.surface.dynamic')} value={value.allowFrom} shape="object" fieldKey={`${props.fieldKey}:allowFrom`} onChange={next => patch({ allowFrom: next })} />)}
    </div>}
    <div className={css.surfaceSwitchRow}><span>{t('rules.surface.requireMatch')}</span><Switch label={t('rules.surface.requireMatch')} checked={value.requireMatch === true}
      disabled={props.disabled || mode === 'deny' && !dynamic} onChange={next => patch({ requireMatch: next })} /></div>
    <RuleParameterFields {...props} omit={['allow', 'deny', 'allowFrom', 'requireMatch']} />
  </>
}

function AddedEntries(props: SurfaceProps): ReactNode {
  const { t, value } = props
  const entries = value.add
  const set = (next: unknown): void => { cleared(props.fields, `${props.fieldKey}:add`); props.onChange({ ...value, add: next }) }
  if (entries !== undefined && (!Array.isArray(entries) || !entries.every(record))) return <TriggerJsonField {...props}
    label={t('rules.surface.addEntries')} fieldKey={`${props.fieldKey}:add`} value={entries} shape="array" onChange={set} />
  return <div className={css.surfaceGroup}>
    {(entries as RecordValue[] | undefined)?.map((entry, index) => <div key={index} className={css.surfaceEntry}>
      <div className={css.surfaceHeading}><FormField label={t('rules.surface.entryName')}><TextInput aria-label={t('rules.surface.entryName')} readOnly={props.disabled}
        value={String(entry.name ?? '')} onChange={event => set((entries as RecordValue[]).map((item, at) => at === index ? { ...item, name: event.target.value } : item))} /></FormField>
        <CloseButton label={t('rules.surface.removeEntry', { index: index + 1 })} disabled={props.disabled}
          onClick={() => set((entries as RecordValue[]).filter((_, at) => at !== index))} /></div>
      <FormField label={t('rules.surface.entryText')}><textarea className={ui.configTextarea} aria-label={t('rules.surface.entryText')} rows={3} readOnly={props.disabled}
        value={String(entry.text ?? '')} onChange={event => set((entries as RecordValue[]).map((item, at) => at === index ? { ...item, text: event.target.value } : item))} /></FormField>
    </div>)}
    <div><Button variant="outline" shape="pill" disabled={props.disabled} onClick={() => set([...(entries as RecordValue[] | undefined ?? []), { name: '', text: '' }])}>{t('rules.surface.addEntries')}</Button></div>
  </div>
}

function TextSurfaceFields(props: SurfaceProps & { target: 'sections' | 'contexts' }): ReactNode {
  const { t, value, target } = props
  const mode = target === 'contexts' && value.clear === true ? 'clear' : value.keep !== undefined ? 'keep' : value.remove !== undefined ? 'remove' : ''
  const options: [string, PromptToolLocaleKey][] = [['', 'rules.surface.unrestricted'], ...(target === 'sections' ? [['keep', 'rules.surface.keep'] as [string, PromptToolLocaleKey]] : []), ['remove', 'rules.surface.remove'], ...(target === 'contexts' ? [['clear', 'rules.surface.clear'] as [string, PromptToolLocaleKey]] : [])]
  return <>
    <Mode {...props} label={t('rules.surface.textMode')} value={mode} options={options} onChange={next => {
      cleared(props.fields, props.fieldKey)
      props.onChange(patched(value, { ...(target === 'sections' ? { keep: undefined } : { clear: undefined }), remove: undefined,
        ...(next === 'clear' ? { clear: true, add: undefined } : next === '' ? {} : { [next]: Array.isArray(value[mode]) ? value[mode] : [] }) }))
    }} />
    {(mode === 'keep' || mode === 'remove') && <NameList {...props} fieldKey={`${props.fieldKey}:${mode}`} label={t(mode === 'keep' ? 'rules.surface.keptNames' : 'rules.surface.removedNames')}
      value={value[mode]} onChange={next => props.onChange({ ...value, [mode]: next })} />}
    {mode !== 'clear' && <AddedEntries {...props} />}
    <RuleParameterFields {...props} omit={target === 'sections' ? ['keep', 'remove', 'add'] : ['clear', 'remove', 'add']} />
  </>
}

export function AssemblyFields(props: SurfaceProps): ReactNode {
  const { t, value } = props
  if (!record(value.target)) return <TriggerJsonField {...props} fieldKey={`${props.fieldKey}:target`} label={t('triggers.label.target')} value={value.target} shape="object" onChange={target => props.onChange({ ...value, target })} />
  const target = value.target
  const set = (key: string, next: unknown): void => props.onChange({ ...value, target: patched(target, { [key]: next }) })
  return <div className={css.surfaceFields}>
    {(['tools', 'sections', 'contexts'] as const).map(key => {
      const enabled = target[key] !== undefined, fieldKey = `${props.fieldKey}:target:${key}`, label = t(`rules.surface.${key}`)
      const context = { ...props, value: asTriggerRecord(target[key]), fieldKey, onChange: (next: RecordValue) => set(key, next) }
      return <section key={key} className={css.surfaceSection} aria-label={label}>
        <div className={css.surfaceSwitchRow}><span>{label}</span><Switch label={t('rules.surface.editTarget', { target: label })} checked={enabled} disabled={props.disabled}
          onChange={next => { cleared(props.fields, fieldKey); set(key, next ? key === 'tools' ? { deny: [] } : {} : undefined) }} /></div>
        {enabled && (record(target[key]) ? key === 'tools' ? <ToolsFields {...context} /> : <TextSurfaceFields {...context} target={key} />
          : <TriggerJsonField {...props} label={label} value={target[key]} shape="object" fieldKey={fieldKey} onChange={next => set(key, next)} />)}
      </section>
    })}
    <RuleParameterFields {...props} fieldKey={`${props.fieldKey}:target`} value={target} omit={['tools', 'sections', 'contexts']} onChange={next => props.onChange({ ...value, target: next })} />
    <RuleParameterFields {...props} omit={['id', 'kind', 'target']} />
  </div>
}

export function MessageFilterFields(props: SurfaceProps): ReactNode {
  const { t, value } = props
  const mode = value.sources !== undefined ? 'sources' : value.keepKinds !== undefined ? 'keepKinds' : ''
  return <div className={css.surfaceFields}>
    <Mode {...props} label={t('rules.surface.sourceMode')} value={mode} options={[[ '', 'rules.surface.unrestricted' ], [ 'sources', 'rules.surface.strictSources' ], [ 'keepKinds', 'rules.surface.incrementalSources' ]]}
      onChange={next => { cleared(props.fields, `${props.fieldKey}:sources`); cleared(props.fields, `${props.fieldKey}:keepKinds`);
        props.onChange(patched(value, { sources: undefined, keepKinds: undefined, ...(next === '' ? {} : { [next]: value[mode] ?? [] }) })) }} />
    {mode !== '' && <NameList {...props} fieldKey={`${props.fieldKey}:${mode}`} label={t('rules.surface.keptSources')} value={value[mode]} onChange={next => props.onChange({ ...value, [mode]: next })} />}
    <NameList {...props} fieldKey={`${props.fieldKey}:blockPlugins`} label={t('rules.surface.blockPlugins')} value={value.blockPlugins}
      onChange={next => props.onChange({ ...value, blockPlugins: next })} />
    <RuleParameterFields {...props} omit={['id', 'kind', 'sources', 'keepKinds', 'blockPlugins']} />
  </div>
}
