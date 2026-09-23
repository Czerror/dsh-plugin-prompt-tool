import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { TriggerEditorMeta } from '../../../shared/bridge-contract.ts'
import { bridgeCall } from '../../data/bridge-client.ts'
import { createTriggerEditor, getTriggerDraft, hasTriggerFieldDrafts, triggerDraftDirty, type TriggerEditor, type TriggerEditorDraft } from '../../data/trigger-drafts.ts'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import { usePromptToolFields } from '../../data/use-prompt-tool-fields.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx'
import { FormField } from '../../ui/FormField.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { asTriggerRecord, TriggerJsonField } from './TriggerJsonField.tsx'
import { TriggerRuleFields } from './TriggerRuleFields.tsx'
import { triggerLabel } from './trigger-labels.ts'
import ui from '../../ui/controls.module.css'
import css from './triggers.module.css'

export function newTriggerRule(values: unknown[], action: TriggerEditorMeta['actions'][number], source?: unknown): Record<string, unknown> {
  const ids = new Set(values.map((value) => asTriggerRecord(value).id))
  const prefix = source === undefined ? 'rule' : `${String(asTriggerRecord(source).id ?? 'rule')}-copy`
  let index = 1
  while (ids.has(`${prefix}-${index}`)) index++
  return source === undefined
    ? { id: `${prefix}-${index}`, channel: action.channel, phase: action.phase, do: structuredClone(action.example) }
    : { ...structuredClone(asTriggerRecord(source)), id: `${prefix}-${index}` }
}

/** 删除只移动对应行的字段键；其他未完成 JSON 输入不能随索引变化丢失。 */
export function removeTriggerRule(draft: TriggerEditorDraft, index: number): unknown[] {
  const fields = Array.from(draft.fields)
  for (const [key] of fields) {
    const match = /^rule:(\d+)(:.*)$/.exec(key)
    if (match === null || Number(match[1]) < index) continue
    draft.fields.delete(key)
  }
  for (const [key, value] of fields) {
    const match = /^rule:(\d+)(:.*)$/.exec(key)
    if (match === null) continue
    if (Number(match[1]) > index) draft.fields.set(`rule:${Number(match[1]) - 1}${match[2]}`, value)
  }
  return draft.value.filter((_, at) => at !== index)
}

interface TriggerRulesListProps {
  draft: TriggerEditorDraft; editor: TriggerEditor; t: PromptToolTranslate; disabled?: boolean; onDraft: () => void
  renderFields?: (rule: Record<string, unknown>, index: number, onChange: (value: Record<string, unknown>) => void) => ReactNode
}

export function TriggerRulesList({ draft, editor, t, disabled, onDraft, renderFields }: TriggerRulesListProps): ReactNode {
  const [createKind, setCreateKind] = useState('')
  const [confirm, setConfirm] = useState<number | 'discard'>()
  const [selected, setSelected] = useState(0)
  const [advanced, setAdvanced] = useState(false)
  const [saved, setSaved] = useState(false)
  const actions = draft.meta?.actions ?? []
  const action = actions.find(({ kind }) => kind === createKind) ?? actions[0]
  const dirty = triggerDraftDirty(draft)
  const pending = draft.busy !== undefined
  const blocked = disabled || !draft.loaded
  const patch = (values: unknown[]): void => { setSaved(false); editor.patch(values) }
  const patchRule = (index: number, value: unknown): void => patch(draft.value.map((rule, at) => at === index ? value : rule))
  const error = draft.error === undefined ? undefined : t(draft.remote !== undefined ? 'triggers.remoteConflict' : draft.error.code === 'triggers-conflict' ? 'triggers.conflict' : 'triggers.failed')
  return <section className={ui.section} aria-label={t('triggers.title')} data-trigger-editor aria-busy={pending}>
    <header className={ui.configActions}><h3>{t('triggers.title')}</h3><span>{t('triggers.count', { count: draft.value.length })}</span></header>
    <p className={ui.configFieldHint}>{t('triggers.hint')}</p>
    <div className={ui.configActions}>
      <MenuSelect ariaLabel={t('triggers.actionType')} value={action?.kind ?? ''} options={actions.map(({ kind }) => ({ value: kind, label: triggerLabel(t, kind) }))} disabled={blocked || pending} onChange={setCreateKind} />
      <button type="button" className={ui.pillButton} disabled={blocked || pending || action === undefined} onClick={() => {
        if (action === undefined) return
        setSelected(draft.value.length); patch([...draft.value, newTriggerRule(draft.value, action)])
      }}>{t('triggers.create')}</button>
      <button type="button" className={ui.pillButton} disabled={pending} onClick={() => { setSaved(false); void editor.load() }}>{t('triggers.reload')}</button>
      <button type="button" className={ui.pillButton} disabled={blocked || pending || hasTriggerFieldDrafts(draft) || draft.remote !== undefined} onClick={() => { void editor.submit(true) }}>{t('triggers.validate')}</button>
      <button type="button" className={ui.pillButton} disabled={blocked || pending || !dirty || hasTriggerFieldDrafts(draft) || draft.remote !== undefined} onClick={() => {
        void editor.submit().then((ok) => { if (ok) setSaved(true) })
      }}>{t(draft.busy === 'save' ? 'triggers.saving' : 'triggers.save')}</button>
      {(dirty || draft.remote !== undefined) && <button type="button" className={ui.pillButton} data-danger disabled={pending} onClick={() => setConfirm('discard')}>{t('triggers.discard')}</button>}
    </div>
    {error !== undefined && <div role="alert"><p>{error}</p>{draft.error?.message && <p>{draft.error.message}</p>}</div>}
    {hasTriggerFieldDrafts(draft) && <p role="alert">{t('triggers.fixDrafts')}</p>}
    <p role="status">{t(!draft.loaded ? 'triggers.loading' : dirty ? 'triggers.dirty' : saved ? 'triggers.saved' : draft.validated ? 'triggers.validated' : 'triggers.clean')}</p>
    {draft.loaded && draft.value.length === 0 && <p>{t('triggers.empty')}</p>}
    {draft.value.length > 0 && <FormField label={t('triggers.selectedRule')}><MenuSelect ariaLabel={t('triggers.selectedRule')}
      value={String(Math.min(selected, draft.value.length - 1))} options={draft.value.map((value, index) => ({ value: String(index), label: String(asTriggerRecord(value).id ?? index + 1) }))}
      onChange={(value) => setSelected(Number(value))} /></FormField>}
    {draft.value.flatMap((value, index) => {
      if (index !== Math.min(selected, draft.value.length - 1)) return []
      const rule = asTriggerRecord(value)
      const list = Array.isArray(rule.do) ? rule.do : [rule.do]
      const summary = `${rule.when == null ? t('triggers.unconditional') : Object.keys(asTriggerRecord(rule.when)).map(kind => triggerLabel(t, kind)).join(' + ')} → ${list.map((item) => triggerLabel(t, String(asTriggerRecord(item).kind ?? ''))).join(' + ')}`
      return [<div key={index} className={css.rule} data-trigger-rule={index}>
        <p className={css.summary}>{summary}</p>
        <FormField label={t('triggers.id')}><input className={ui.configInput} aria-label={t('triggers.id')} value={String(rule.id ?? '')} readOnly={blocked} onChange={(event) => patchRule(index, { ...rule, id: event.target.value })} /></FormField>
        <div className={ui.configActions}>
          <button type="button" className={ui.pillButton} aria-pressed={!advanced} onClick={() => setAdvanced(false)}>{t('triggers.structured')}</button>
          <button type="button" className={ui.pillButton} aria-pressed={advanced} onClick={() => setAdvanced(true)}>{t('triggers.advanced')}</button>
        </div>
        <div hidden={advanced}>{renderFields?.(rule, index, (next) => patchRule(index, next))}</div>
        <div hidden={!advanced}>
          <TriggerJsonField t={t} label={t('triggers.advanced')} value={value} shape="object" fields={draft.fields} fieldKey={`rule:${index}:full`} disabled={blocked}
            onChange={(next) => {
              for (const key of draft.fields.keys()) if (key.startsWith(`rule:${index}:`) && key !== `rule:${index}:full`) draft.fields.delete(key)
              patchRule(index, next)
            }} onDraft={onDraft} />
        </div>
        <div className={ui.configActions}>
          <button type="button" className={ui.pillButton} disabled={blocked || pending || action === undefined || hasTriggerFieldDrafts(draft)} onClick={() => {
            if (action !== undefined) { setSelected(draft.value.length); patch([...draft.value, newTriggerRule(draft.value, action, value)]) }
          }}>{t('triggers.duplicate')}</button>
          <button type="button" className={ui.pillButton} data-danger disabled={blocked || pending} onClick={() => setConfirm(index)}>{t('triggers.delete')}</button>
        </div>
      </div>]
    })}
    {confirm !== undefined && <ConfirmDialog title={t(confirm === 'discard' ? 'triggers.discard' : 'triggers.delete')}
      description={t(confirm === 'discard' ? 'triggers.discardHint' : 'triggers.deleteHint', { id: confirm === 'discard' ? '' : String(asTriggerRecord(draft.value[confirm]).id ?? '') })}
      confirmLabel={t(confirm === 'discard' ? 'triggers.discard' : 'triggers.delete')} cancelLabel={t('triggers.cancel')}
      onCancel={() => setConfirm(undefined)} onConfirm={() => { if (confirm === 'discard') editor.discard(); else patch(removeTriggerRule(draft, confirm)); setSaved(false) }} />}
  </section>
}

export function TriggerRulesEditor(props: { store: PromptToolStore; t: PromptToolTranslate; renderFields?: TriggerRulesListProps['renderFields'] }): ReactNode {
  const { store, t } = props
  const fields = usePromptToolFields(store, (value) => value)
  const presetId = fields.presetTemplate
  useSyncExternalStore(store.subscribeDrafts, store.getDraftRevision, store.getDraftRevision)
  const draft = getTriggerDraft(store.editorDrafts, presetId)
  const editor = useMemo(() => createTriggerEditor(presetId, draft, {
    request: (body) => bridgeCall('triggers', body), enqueue: store.enqueuePresetTask,
    isCurrent: () => store.getFields().presetTemplate === presetId,
    changed: store.publishDrafts,
  }), [draft, presetId, store])
  useEffect(() => { if (presetId) void editor.load() }, [editor, presetId])
  return <TriggerRulesList draft={draft} editor={editor} t={t} disabled={!fields.writePreset || store.moduleFacts?.editable !== true}
    onDraft={() => { draft.validated = false; store.publishDrafts() }} renderFields={props.renderFields ?? ((rule, index, onChange) => draft.meta && <TriggerRuleFields
      t={t} rule={rule} meta={draft.meta} fields={draft.fields} fieldKey={`rule:${index}`} disabled={!fields.writePreset || store.moduleFacts?.editable !== true}
      onChange={onChange} onDraft={() => { draft.validated = false; store.publishDrafts() }} />)} />
}
