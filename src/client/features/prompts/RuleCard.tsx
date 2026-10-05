import { useId, useRef, useState, type ReactNode } from 'react'
import type { RuleDefinition } from '../../../shared/rules.ts'
import type { RuleEditor, RuleEntry, RulesDraft } from '../../data/rule-drafts.ts'
import { hasRuleFields, rulesDirty } from '../../data/rule-drafts.ts'
import type { EngineMeta } from '../../prompt-tool-types.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { FormField } from '../../ui/FormField.tsx'
import { TextInput } from '../../ui/TextInput.tsx'
import { Switch } from '../../ui/Switch.tsx'
import { Button } from '../../ui/Button.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx'
import { CollapsibleCard } from '../../ui/CollapsibleCard.tsx'
import { PromptConfigNavigation } from './PromptConfigNavigation.tsx'
import { LAYER_LABEL_KEYS, translateLabel } from './prompt-config-policy.ts'
import { TriggerJsonField, asTriggerRecord } from './RuleJsonField.tsx'
import { RuleStepsPanel } from './RuleSteps.tsx'
import { conditionalActions, countConditions, countNodes, isValidNode, nodeList } from './rule-steps.ts'
import css from './rules.module.css'

export function RuleCard(props: {
  t: PromptToolTranslate; entry: RuleEntry; draft: RulesDraft; editor: RuleEditor; meta: EngineMeta
  expanded: boolean; onToggle: () => void; disabled?: boolean; onDuplicate: () => void
  /** 折叠卡状态池（工作台草稿池，跨折叠与切页保留）。 */
  expandedRows: Map<string, boolean>
  headerActions?: ReactNode
  source?: string
  renderSettings?: (rule: RuleDefinition) => ReactNode
}): ReactNode {
  const { t, entry, editor, draft } = props, rule = entry.value
  const panelId = useId(), ownsFocus = useRef(false)
  const [confirming, setConfirming] = useState(false)
  const disabled = props.disabled === true || draft.busy === 'save'
  const nodes = [...nodeList(rule.then), ...nodeList(rule.else)]
  // 路径上带条件的动作必须支持条件（event 生命周期）；引擎在编译期拒绝其余组合。
  const unsupported = conditionalActions(nodes, rule.if !== undefined)
    .some(action => draft.meta?.actions.find(item => item.kind === action.kind)?.supportsWhen === false)
  const totals = countNodes(nodes)
  const summary = totals.branches === 0
    ? t('rules.summary', { conditions: countConditions(rule.if), actions: totals.actions })
    : t('rules.summary.branches', { conditions: countConditions(rule.if), actions: totals.actions, branches: totals.branches })
  const patch = (next: Partial<RuleDefinition>): void => { if (!disabled) editor.patch(entry.key, { ...entry.value, ...next }) }
  const save = (): void => { if (!disabled && !unsupported && rulesDirty(draft) && !hasRuleFields(draft)) void editor.submit() }
  const fieldContext = { t, fields: draft.fields, disabled, engineMeta: props.meta, onDraft: editor.changed }
  return <CollapsibleCard id={panelId} title={rule.name || rule.id} meta={(props.source ? t('rules.source', { module: props.source }) + ' · ' : '') + (rule.layer === undefined ? t('rules.module') : translateLabel(t, LAYER_LABEL_KEYS, rule.layer)) + ' · ' + summary}
    expanded={props.expanded} onToggle={() => { if (props.expanded) save(); props.onToggle() }} bodyClassName={css.cardPanel}
    data-rule-id={rule.id} data-rule-key={entry.key}
    onFocus={() => { ownsFocus.current = true }} onBlur={(event) => {
      ownsFocus.current = false
      // 批量开关自行提交，避免离卡自动保存抢先发出旧状态。
      if (event.relatedTarget instanceof Element && event.relatedTarget.closest('[data-batch]')) return
      requestAnimationFrame(() => { if (!ownsFocus.current) save() })
    }}
    actions={<span className={css.headerActions} data-rule-header-actions>{props.headerActions}<span className={css.switchLine}>
      <Switch label={t('rules.enable', { name: rule.name || rule.id })} checked={rule.enabled !== false} disabled={disabled || draft.busy !== undefined || hasRuleFields(draft)} onChange={enabled => {
        patch({ enabled }); void editor.submit(enabled ? { activateRuleId: rule.id } : {})
      }} />
      </span></span>}>
    <div className={css.body} data-rule-editor>
      <div className={css.fields}>
        <FormField label={t('rules.rename')}><TextInput value={rule.id} spellCheck={false} readOnly={disabled} onChange={event => patch({ id: event.target.value })} /></FormField>
        <FormField label={t('rules.name')}><TextInput value={rule.name ?? ''} readOnly={disabled} onChange={event => patch({ name: event.target.value || undefined })} /></FormField>
        <FormField label={t('rules.layer')}><MenuSelect compact className={css.control} ariaLabel={t('rules.layer')} value={rule.layer ?? ''} disabled={disabled}
          options={[{ value: '', label: t('rules.module') }, ...props.meta.layers.map(layer => ({ value: layer, label: translateLabel(t, LAYER_LABEL_KEYS, layer) }))]}
          onChange={layer => patch({ layer: layer === '' ? undefined : layer as RuleDefinition['layer'] })} /></FormField>
        <div className={css.exclusiveGroup}>
          <FormField label={t('rules.group')} hint={t('rules.scopeHint')} hintMode="tooltip"><TextInput readOnly={disabled} value={rule.group ?? ''} onChange={event => patch({ group: event.target.value || undefined })} /></FormField>
          <div className={css.toggle}><span>{t('rules.exclusive')}</span><span className={css.switchLine}><Switch label={t('rules.exclusive')} checked={rule.exclusive === true} disabled={disabled} onChange={exclusive => patch({ exclusive })} /></span></div>
        </div>
      </div>
      {unsupported && <p role="alert" className={css.error}>{t('rules.unsupported')}</p>}
      <PromptConfigNavigation t={t} layer={rule.layer ?? 'module'} renderLayerSettings={props.renderSettings ? () => <section className={css.section} aria-label={t('rules.settings')}>{props.renderSettings?.(rule)}</section> : undefined}>
        <section data-config-panel="rule" aria-label={t('rules.stepsTab')} className={css.section}>{draft.meta && <RuleStepsPanel
          t={t} rule={rule} meta={draft.meta} engineMeta={props.meta} fields={draft.fields} expanded={props.expandedRows}
          prefix={props.source ?? rule.id} fieldKey={entry.key} disabled={disabled} onDraft={editor.changed}
          onChange={next => patch(next)} />}</section>
      <section data-config-panel="definition" aria-label={t('rules.jsonTab')} className={css.section}><TriggerJsonField {...fieldContext} fieldKey={entry.key + ':full'} label={t('triggers.advanced')} shape="object" value={rule} onChange={value => {
        const candidate = asTriggerRecord(value)
        if (typeof candidate.id !== 'string' || !Array.isArray(candidate.then) || !candidate.then.every(isValidNode)
          || (candidate.else !== undefined && !nodeList(candidate.else).every(isValidNode))) {
          const raw = draft.fields.get(entry.key + ':full'); if (raw) raw.error = t('triggers.invalidJson'); return
        }
        for (const key of draft.fields.keys()) if (key.startsWith(entry.key + ':') && key !== entry.key + ':full') draft.fields.delete(key)
        editor.patch(entry.key, candidate as unknown as RuleDefinition)
      }} /></section>
      </PromptConfigNavigation>
      <div className={css.row}>
        <Button variant="outline" shape="pill" disabled={disabled || draft.busy !== undefined || hasRuleFields(draft) || unsupported} onClick={save}>{t('rules.save')}</Button>
        <Button variant="outline" shape="pill" disabled={disabled || draft.busy !== undefined || hasRuleFields(draft)} onClick={props.onDuplicate}>{t('rules.duplicate')}</Button>
        <Button variant="outline" shape="pill" data-danger disabled={disabled || draft.busy !== undefined} onClick={() => setConfirming(true)}>{t('rules.delete')}</Button>
      </div>
    </div>
    {confirming && <ConfirmDialog title={t('rules.delete')} description={t('rules.deleteHint', { id: rule.id })} confirmLabel={t('rules.delete')} cancelLabel={t('triggers.cancel')}
      onCancel={() => setConfirming(false)} onConfirm={() => { editor.remove(entry.key); void editor.submit() }} />}
  </CollapsibleCard>
}
