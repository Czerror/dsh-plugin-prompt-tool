import { useId, useRef, useState, type ReactNode } from 'react'
import type { RuleDefinition } from '../../../shared/rules.ts'
import type { RuleEditor, RuleEntry, RulesDraft } from '../../data/rule-drafts.ts'
import { hasRuleFields, rulesDirty } from '../../data/rule-drafts.ts'
import type { EngineMeta } from '../../prompt-tool-types.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { FormField } from '../../ui/FormField.tsx'
import { Switch } from '../../ui/Switch.tsx'
import { Button } from '../../ui/Button.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx'
import { CollapsibleCard } from '../../ui/CollapsibleCard.tsx'
import { PromptConfigNavigation } from './PromptConfigNavigation.tsx'
import { LAYER_LABEL_KEYS, translateLabel } from './prompt-config-policy.ts'
import { TriggerJsonField, asTriggerRecord } from './RuleJsonField.tsx'
import { RuleActionsFields, RuleConditionFields } from './RuleFields.tsx'
import ui from '../../ui/controls.module.css'
import css from './rules.module.css'

export function RuleCard(props: {
  t: PromptToolTranslate; entry: RuleEntry; draft: RulesDraft; editor: RuleEditor; meta: EngineMeta
  expanded: boolean; onToggle: () => void; disabled?: boolean; onDuplicate: () => void
  headerActions?: ReactNode
  renderSettings?: (rule: RuleDefinition) => ReactNode
}): ReactNode {
  const { t, entry, editor, draft } = props, rule = entry.value
  const panelId = useId(), ownsFocus = useRef(false)
  const [confirming, setConfirming] = useState(false)
  const disabled = props.disabled === true || draft.busy === 'save'
  const unsupported = rule.when !== undefined && rule.do.some(action => draft.meta?.actions.find(item => item.kind === action.kind)?.supportsWhen === false)
  const patch = (next: Partial<RuleDefinition>): void => { if (!disabled) editor.patch(entry.key, { ...entry.value, ...next }) }
  const save = (): void => { if (!disabled && !unsupported && rulesDirty(draft) && !hasRuleFields(draft)) void editor.submit() }
  const fieldContext = { t, fields: draft.fields, disabled, engineMeta: props.meta, onDraft: editor.changed }
  return <CollapsibleCard id={panelId} title={rule.name || rule.id} meta={(rule.layer === undefined ? t('rules.module') : translateLabel(t, LAYER_LABEL_KEYS, rule.layer)) + ' · ' + rule.do.length + ' ' + t('triggers.action')}
    expanded={props.expanded} onToggle={() => { if (props.expanded) save(); props.onToggle() }} bodyClassName={css.cardPanel}
    data-rule-id={rule.id} data-rule-key={entry.key}
    onFocus={() => { ownsFocus.current = true }} onBlur={() => { ownsFocus.current = false; requestAnimationFrame(() => { if (!ownsFocus.current) save() }) }}
    actions={<span className={css.headerActions} data-rule-header-actions>{props.headerActions}<span className={css.switchLine}>
      <Switch className={css.switchTarget} label={t('rules.enable', { name: rule.name || rule.id })} checked={rule.enabled !== false} disabled={disabled || draft.busy !== undefined || hasRuleFields(draft)} onChange={enabled => {
        patch({ enabled }); void editor.submit(enabled ? { activateRuleId: rule.id } : {})
      }} />
      </span></span>}>
    <div className={css.body} data-rule-editor>
      <div className={css.fields}>
        <FormField label={t('rules.rename')}><input className={ui.configInput + ' ' + css.control} value={rule.id} spellCheck={false} readOnly={disabled} onChange={event => patch({ id: event.target.value })} /></FormField>
        <FormField label={t('rules.name')}><input className={ui.configInput + ' ' + css.control} value={rule.name ?? ''} readOnly={disabled} onChange={event => patch({ name: event.target.value || undefined })} /></FormField>
        <FormField label={t('rules.layer')}><MenuSelect compact className={css.control} ariaLabel={t('rules.layer')} value={rule.layer ?? ''} disabled={disabled}
          options={[{ value: '', label: t('rules.module') }, ...props.meta.layers.map(layer => ({ value: layer, label: translateLabel(t, LAYER_LABEL_KEYS, layer) }))]}
          onChange={layer => patch({ layer: layer === '' ? undefined : layer as RuleDefinition['layer'] })} /></FormField>
        <div className={css.exclusiveGroup}>
          <FormField label={t('rules.group')} hint={t('rules.scopeHint')} hintMode="tooltip"><input className={ui.configInput + ' ' + css.control} readOnly={disabled} value={rule.group ?? ''} onChange={event => patch({ group: event.target.value || undefined })} /></FormField>
          <div className={css.toggle}><span>{t('rules.exclusive')}</span><span className={css.switchLine}><Switch className={css.switchTarget} label={t('rules.exclusive')} checked={rule.exclusive === true} disabled={disabled} onChange={exclusive => patch({ exclusive })} /></span></div>
        </div>
      </div>
      {unsupported && <p role="alert" className={css.error}>{t('rules.unsupported')}</p>}
      <PromptConfigNavigation t={t} layer={rule.layer ?? 'module'} renderLayerSettings={props.renderSettings ? () => <section className={css.section} aria-label={t('rules.settings')}>{props.renderSettings?.(rule)}</section> : undefined}>
        <section data-config-panel="conditions" aria-label={t('form.navigation.conditions')} className={css.section}>{draft.meta && <RuleConditionFields {...fieldContext} fieldKey={entry.key + ':when'} meta={draft.meta} value={rule.when}
          onChange={when => patch({ when })} />}</section>
        <section data-config-panel="execution" aria-label={t('rules.actionsTab')} className={css.section}>{draft.meta && <RuleActionsFields {...fieldContext} fieldKey={entry.key + ':do'} meta={draft.meta} engineMeta={props.meta} conditional={rule.when !== undefined} value={rule.do} onChange={actions => patch({ do: actions })} />}</section>
      <section data-config-panel="definition" aria-label={t('rules.jsonTab')} className={css.section}><TriggerJsonField {...fieldContext} fieldKey={entry.key + ':full'} label={t('triggers.advanced')} shape="object" value={rule} onChange={value => {
        const candidate = asTriggerRecord(value)
        if (typeof candidate.id !== 'string' || !Array.isArray(candidate.do) || candidate.do.some(action => typeof asTriggerRecord(action).id !== 'string' || typeof asTriggerRecord(action).kind !== 'string')) {
          const raw = draft.fields.get(entry.key + ':full'); if (raw) raw.error = t('triggers.invalidJson'); return
        }
        for (const key of draft.fields.keys()) if (key.startsWith(entry.key + ':') && key !== entry.key + ':full') draft.fields.delete(key)
        editor.patch(entry.key, candidate as unknown as RuleDefinition)
      }} /></section>
      </PromptConfigNavigation>
      <div className={css.row}>
        <Button variant="outline" className={css.button} disabled={disabled || draft.busy !== undefined || hasRuleFields(draft) || unsupported} onClick={save}>{t('rules.save')}</Button>
        <Button variant="outline" className={css.button} disabled={disabled || draft.busy !== undefined || hasRuleFields(draft)} onClick={props.onDuplicate}>{t('rules.duplicate')}</Button>
        <Button variant="outline" className={css.button} data-danger disabled={disabled || draft.busy !== undefined} onClick={() => setConfirming(true)}>{t('rules.delete')}</Button>
      </div>
    </div>
    {confirming && <ConfirmDialog title={t('rules.delete')} description={t('rules.deleteHint', { id: rule.id })} confirmLabel={t('rules.delete')} cancelLabel={t('triggers.cancel')}
      onCancel={() => setConfirming(false)} onConfirm={() => { editor.remove(entry.key); void editor.submit() }} />}
  </CollapsibleCard>
}
