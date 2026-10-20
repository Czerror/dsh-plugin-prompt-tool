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

/**
 * 工具可见面：一份声明拥有 allow/deny、发现工具与 requireMatch。
 * 名单两种模式都保留（官方 ToolRestriction 的 and/or 语义）；选择模式只切换主名单，
 * 不删除作者已写的另一份。
 */
export function VisibilityFields(props: SurfaceProps): ReactNode {
  const { t, value } = props
  const patch = (change: RecordValue): void => props.onChange(patched(value, change))
  const mode = value.allow !== undefined ? 'allow' : 'deny'
  const discovery = record(value.discovery) ? value.discovery : undefined
  return <>
    <Mode {...props} label={t('rules.surface.toolMode')} value={mode} options={[['allow', 'rules.surface.allow'], ['deny', 'rules.surface.deny']]}
      onChange={next => { cleared(props.fields, `${props.fieldKey}:${next}`); patch({ [next]: value[next] ?? [] }) }} />
    <NameList {...props} fieldKey={`${props.fieldKey}:${mode}`} label={t(mode === 'allow' ? 'rules.surface.fixedTools' : 'rules.surface.deniedTools')}
      value={value[mode]} onChange={next => patch({ [mode]: next })} />
    <div className={css.surfaceSwitchRow}><span>{t('rules.surface.dynamic')}</span><Switch label={t('rules.surface.dynamic')} checked={discovery !== undefined} disabled={props.disabled}
      onChange={enabled => patch({ discovery: enabled ? { tool: '', key: '' } : undefined })} /></div>
    {discovery !== undefined && <div className={css.surfaceColumns}>{(['tool', 'key'] as const).map(key => <FormField key={key} label={t(key === 'tool' ? 'rules.surface.discoveryTool' : 'rules.surface.argumentKey')}>
      <TextInput aria-label={t(key === 'tool' ? 'rules.surface.discoveryTool' : 'rules.surface.argumentKey')} readOnly={props.disabled}
        placeholder={key === 'tool' ? 'tool_search' : 'toolNames'} value={String(discovery[key] ?? '')}
        onChange={event => patch({ discovery: { ...discovery, [key]: event.target.value } })} />
    </FormField>)}</div>}
    <div className={css.surfaceSwitchRow}><span>{t('triggers.label.requireMatch')}</span><Switch label={t('triggers.label.requireMatch')} checked={value.requireMatch === true}
      disabled={props.disabled || mode === 'deny'} onChange={next => patch({ requireMatch: next })} /></div>
    <RuleParameterFields {...props} omit={['id', 'kind', 'allow', 'deny', 'discovery', 'requireMatch']} />
  </>
}

export function AssemblyFields(props: SurfaceProps): ReactNode {
  const { t, value } = props
  if (!record(value.target)) return <TriggerJsonField {...props} fieldKey={`${props.fieldKey}:target`} label={t('triggers.label.target')} value={value.target} shape="object" onChange={target => props.onChange({ ...value, target })} />
  const target = value.target
  const set = (key: string, next: unknown): void => props.onChange({ ...value, target: patched(target, { [key]: next }) })
  return <div className={css.surfaceFields}>
    {(['sections', 'contexts'] as const).map(key => {
      const enabled = target[key] !== undefined, fieldKey = `${props.fieldKey}:target:${key}`, label = t(`rules.surface.${key}`)
      const context = { ...props, value: asTriggerRecord(target[key]), fieldKey, onChange: (next: RecordValue) => set(key, next) }
      return <section key={key} className={css.surfaceSection} aria-label={label}>
        <div className={css.surfaceSwitchRow}><span>{label}</span><Switch label={t('rules.surface.editTarget', { target: label })} checked={enabled} disabled={props.disabled}
          onChange={next => { cleared(props.fields, fieldKey); set(key, next ? {} : undefined) }} /></div>
        {enabled && (record(target[key]) ? <TextSurfaceFields {...context} target={key} />
          : <TriggerJsonField {...props} label={label} value={target[key]} shape="object" fieldKey={fieldKey} onChange={next => set(key, next)} />)}
      </section>
    })}
    <RuleParameterFields {...props} fieldKey={`${props.fieldKey}:target`} value={target} omit={['sections', 'contexts']} onChange={next => props.onChange({ ...value, target: next })} />
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
