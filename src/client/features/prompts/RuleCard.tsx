import { useEffect, useId, useLayoutEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { AutoSaveSelection } from '../../ui/AutoSaveSelection.ts'
import type { RuleDefinition } from '../../../shared/rules.ts'
import type { RuleDiagnosticRecord } from '../../../shared/bridge-contract.ts'
import type { RuleEditor, RuleEntry, RulesDraft } from '../../data/rule-drafts.ts'
import { hasRuleFields, rulesDirty } from '../../data/rule-drafts.ts'
import { hostCapabilityChannel } from '../../data/host-control-policy.ts'
import { useAutosave } from '../../data/use-autosave.ts'
import type { EngineMeta } from '../../prompt-tool-types.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { FormField } from '../../ui/FormField.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { TextInput } from '../../ui/TextInput.tsx'
import { Switch } from '../../ui/Switch.tsx'
import { Button } from '../../ui/Button.tsx'
import { IconChevronDownOutlineRegular, IconCloseFillRegular } from '../../ui/icons.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx'
import { LAYER_LABEL_KEYS, translateLabel } from './prompt-config-policy.ts'
import { TriggerJsonField, asTriggerRecord } from './RuleJsonField.tsx'
import { RuleStepsPanel } from './RuleSteps.tsx'
import { ruleFeedback } from './rule-feedback.ts'
import type { CanvasInstructionFile } from './RuleCanvas.tsx'
import { conditionalActions, countConditions, countNodes, isValidNode, nodeList } from './rule-steps.ts'
import { deepEqual } from '../../data/dirty-state.ts'
import ui from '../../ui/controls.module.css'
import css from './rules.module.css'

export function RuleCard(props: {
  t: PromptToolTranslate; entry: RuleEntry; draft: RulesDraft; editor: RuleEditor; meta: EngineMeta
  disabled?: boolean; onDuplicate: () => void
  /** 折叠卡状态池（工作台草稿池，跨折叠与切页保留）。 */
  expandedRows: Map<string, boolean>
  source?: string
  /** 本卡的主语（它所属的模块）：层内设置按它取，不从任何会话状态兜底。 */
  moduleId: string
  moduleName: string
  moduleEnabled: boolean
  modulesEnabled: boolean
  diagnostics?: readonly RuleDiagnosticRecord[]
  leaveSave?: MutableRefObject<(() => void) | undefined>
  nodeBrowse?: Map<string, string>
  canvasBrowse?: Map<string, { scale: number; x: number; y: number; positions: Record<string, { x: number; y: number }> }>
  onBrowseChange?: () => void
  libraryOpen: boolean
  libraryId: string
  onCloseLibrary: () => void
  onCanvasInteract: () => void
  instructionFiles: readonly CanvasInstructionFile[]
  activeInstructionId?: string
  hideNodeInspector?: boolean
  onSelectInstruction: (id: string) => void
  onCloseInstruction: () => void
  dismissDrawer: MutableRefObject<(() => void) | undefined>
  diagnosticActionId?: string
  diagnosticFocusToken?: object
  onRuleEdit?: () => void
  onActivate?: () => void
  renderSettings?: (rule: RuleDefinition, moduleId: string) => ReactNode
}): ReactNode {
  const { t, entry, editor, draft, moduleName, moduleEnabled, modulesEnabled } = props, rule = entry.value
  const ruleName = rule.name || rule.id
  const panelId = useId()
  const [confirming, setConfirming] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [drawer, setDrawer] = useState<'properties' | 'definition' | 'identity' | undefined>()
  const surface = useRef<HTMLElement>(null)
  const drawerTrigger = useRef<HTMLElement>()
  const openDrawer = (next: NonNullable<typeof drawer>, trigger: HTMLButtonElement): void => {
    props.onCloseInstruction()
    drawerTrigger.current = trigger
    setDrawer(drawer === next ? undefined : next)
  }
  const closeDrawer = (restoreFocus: boolean): void => {
    if (drawer === undefined) return
    setDrawer(undefined)
    if (restoreFocus) drawerTrigger.current?.focus({ preventScroll: true })
  }
  useLayoutEffect(() => {
    const element = surface.current, header = element?.querySelector('header')
    if (!element || !header) return
    const container = element.closest<HTMLElement>('[data-canvas-workspace]')
    const measure = () => container?.style.setProperty('--pt-canvas-top', `${(header as HTMLElement).offsetTop + header.getBoundingClientRect().height + 16}px`)
    const observer = new ResizeObserver(measure)
    observer.observe(header); observer.observe(element); measure()
    return () => { observer.disconnect(); container?.style.removeProperty('--pt-canvas-top') }
  }, [])
  useLayoutEffect(() => {
    if (drawer) surface.current?.querySelector<HTMLElement>('[data-rule-drawer] button')?.focus()
  }, [drawer])
  useLayoutEffect(() => {
    if (!drawer) return
    const ref = props.dismissDrawer
    ref.current = () => setDrawer(undefined)
    return () => { ref.current = undefined }
  }, [drawer, props.dismissDrawer])
  const disabled = props.disabled === true
  const nodes = [...nodeList(rule.then), ...nodeList(rule.else)]
  // 路径上带条件的动作必须支持条件（event 生命周期）；引擎在编译期拒绝其余组合。
  const unsupported = conditionalActions(nodes, rule.if !== undefined)
    .some(action => draft.meta?.actions.find(item => item.kind === action.kind)?.supportsWhen === false)
  const totals = countNodes(nodes)
  const summary = totals.branches === 0
    ? t('rules.summary', { conditions: countConditions(rule.if), actions: totals.actions })
    : t('rules.summary.branches', { conditions: countConditions(rule.if), actions: totals.actions, branches: totals.branches })
  const patch = (next: Partial<RuleDefinition>): void => {
    if (!disabled) {
      editor.patch(entry.key, { ...entry.value, ...next })
      props.onRuleEdit?.()
    }
  }
  const autosave = useAutosave(props.moduleId + ':' + entry.key, () => {
    if (!disabled && !unsupported && rulesDirty(draft, entry.key) && !hasRuleFields(draft, entry.key)) void editor.submitRule(entry.key)
  })
  useEffect(() => () => editor.setComposing(entry.key, false), [editor, entry.key])
  // 完整提交资格与未完成草稿仍由 editor 判定。
  const save = (): void => { if (draft.loaded) autosave.flush() }
  useLayoutEffect(() => {
    if (!props.leaveSave) return
    props.leaveSave.current = save
    return () => { if (props.leaveSave) props.leaveSave.current = undefined }
  })
  const onDraft = (): void => { editor.changed(); if (hasRuleFields(draft, entry.key)) props.onRuleEdit?.() }
  const fieldContext = { t, fields: draft.fields, disabled, engineMeta: props.meta, onDraft }
  const targets = new Set<string>()
  const collectTargets = (values: readonly unknown[]): void => { for (const value of values) {
    if (value === null || typeof value !== 'object') continue
    const node = value as Record<string, unknown>
    if (node.kind === 'subagent-params') targets.add('subagent:params')
    if (node.kind === 'host-control') {
      const channel = hostCapabilityChannel(node.capability)
      if (channel) targets.add(channel)
    }
    if (node.kind === 'assembly') {
      const target = asTriggerRecord(node.target)
      if (Array.isArray(target.toolDescriptions) && target.toolDescriptions.length > 0) targets.add('tool:descriptions')
      if (Array.isArray(target.skillDescriptions) && target.skillDescriptions.length > 0) targets.add('skill:descriptions')
    }
    if (node.kind === 'tool-result' && node.action === 'edit-text' && Array.isArray(node.edits) && node.edits.length > 0) targets.add('tool:results')
    if (node.kind === 'persona' && (node.stripDefaultIdentity === 'preset' || node.stripDefaultIdentity === 'harness')) targets.add(`persona:identity:${node.stripDefaultIdentity}`)
    collectTargets(nodeList(node.then)); collectTargets(nodeList(node.else))
  } }
  collectTargets(nodes)
  const saved = draft.saved.find(value => value.id === entry.previousId)
  const contentRevision = deepEqual(saved, rule) ? draft.revisions?.rules[rule.id] : undefined
  const revision = contentRevision === undefined ? undefined : `${contentRevision}:${draft.revisions?.settings}`
  const observed = props.diagnostics?.filter(record => revision !== undefined && record.definitionRevision === revision
    && record.moduleId === props.moduleId && record.ruleId === rule.id && targets.has(record.channel)) ?? []
  const effective = observed.filter(record => record.identityOutcome !== 'condition-miss')
  const availability = effective.some(record => record.identityOutcome !== 'matched') ? 'rules.identity.unavailable'
    : effective.length > 0 ? 'rules.identity.matched' : 'rules.identity.unverified'
  const reason = observed.filter(record => record.reason).map(record => record.reason).join(' · ')
  const status = t(rule.enabled === false ? 'rules.identity.disabled' : 'rules.identity.enabled') + ' · '
    + t(rule.enabled === false || props.disabled ? 'rules.identity.unverified' : rule.executionScope === 'process' && availability === 'rules.identity.matched' ? targets.has('host:command-confine') ? 'rules.commandReady' : 'rules.processReady' : availability)
  const activationPending = draft.activationPending === rule.id
  const feedback = ruleFeedback(draft, editor, t)
  const publicationError = feedback.publication ? draft.publicationError : undefined
  const dirty = rulesDirty(draft, entry.key)
  const enableRuleLabel = t('rules.enableRuleLabel')
  const saveStatus = feedback.issue ?? (draft.busy === 'save' && !feedback.publication ? t('rules.saving')
    : hasRuleFields(draft, entry.key) ? t('rules.fieldsPending') : undefined)
  const saveText = saveStatus ?? (dirty ? t('rules.dirty') : feedback.publication ? undefined : t('rules.clean'))
  const drawerLabel = t(drawer === 'identity' ? 'rules.identityDetails' : drawer === 'properties' ? 'rules.ruleSettings' : 'rules.definition')
  return <AutoSaveSelection.Provider value={save}><section ref={surface} id={panelId} className={css.canvasSurface} aria-label={ruleName}
    data-rule-id={rule.id} data-rule-key={entry.key}
    onFocus={autosave.onFocus} onBlur={autosave.onBlur}
    onCompositionStart={() => { editor.setComposing(entry.key, true); autosave.onCompositionStart() }}
    onCompositionEnd={() => { editor.setComposing(entry.key, false); autosave.onCompositionEnd() }}
    >
    <header className={css.canvasTopbar} data-canvas-obstacle="top">
      <div className={css.contextCluster}>
        <button type="button" className={css.canvasIdentity} title={`${props.moduleId} / ${rule.id} · ${summary}`}
          aria-expanded={drawer === 'identity'} data-rule-drawer-trigger onClick={event => openDrawer('identity', event.currentTarget)}>
          <span>{moduleName}</span>
          <span aria-hidden="true">›</span>
          <strong>{ruleName}</strong>
          <IconChevronDownOutlineRegular />
        </button>
        <div className={css.canvasStates}>
          <small className={css.moduleState} data-enabled={moduleEnabled}>{t(moduleEnabled ? 'rules.moduleIsEnabled' : 'rules.moduleIsDisabled')}</small>
          {!modulesEnabled && <small className={css.pausedState}>{t('rules.modulePaused')}</small>}
          <div className={css.canvasFeedback}>
            <div className={css.canvasFeedbackText} role="status" aria-atomic="true">
              {saveText && <small className={css.canvasSaveState} data-clean={!saveStatus && !dirty || undefined}>{saveText}</small>}
              {feedback.publication && <small className={`${css.canvasSaveState} ${css.canvasPublicationState}`}>{feedback.publication}</small>}
              {publicationError && <small className={css.canvasPublicationError} title={publicationError}>{publicationError}</small>}
            </div>
            {feedback.action && <Button shape="pill" variant="outline" disabled={draft.busy !== undefined} aria-label={feedback.action}
              onClick={() => { void editor.retry().then(ok => { if (ok && activationPending) props.onActivate?.() }) }}>{feedback.action}</Button>}
            {(draft.pending || draft.remote) && <Button shape="pill" variant="outline" aria-label={t('triggers.discard')} title={t('triggers.discard')}
              disabled={draft.busy !== undefined} onClick={() => setDiscarding(true)}>{t('rules.discardButton')}</Button>}
          </div>
        </div>
      </div>
      <div className={css.commandCluster}>
        <span className={css.headerActions} data-rule-header-actions>
          <label className={css.ruleEnable}>
            <AutoSaveSelection.Provider value={undefined}><Switch label={enableRuleLabel} checked={rule.enabled !== false} disabled={disabled || hasRuleFields(draft, entry.key)} onChange={enabled => {
              patch({ enabled }); void editor.submitRule(entry.key, enabled ? { activateRuleId: rule.id } : {}).then(() => { if (enabled) props.onActivate?.() })
            }} /></AutoSaveSelection.Provider>
            <span>{enableRuleLabel}</span>
          </label>
        </span>
        <HintTooltip label={t('rules.ruleSettings')}><span className={css.compactCommand}>
          <Button variant="outline" shape="pill" aria-label={t('rules.ruleSettings')} aria-expanded={drawer === 'properties'} data-rule-drawer-trigger onClick={event => openDrawer('properties', event.currentTarget)}>
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" aria-hidden="true"><path d="M2 4h3m3 0h6M2 8h7m3 0h2M2 12h2m3 0h7M5 2.5v3M9 6.5v3M4 10.5v3" /></svg>
            <span>{t('rules.ruleSettingsButton')}</span>
          </Button>
        </span></HintTooltip>
        <HintTooltip label={t('rules.definition')}><span className={css.compactCommand}>
          <Button variant="outline" shape="pill" aria-label={t('rules.definition')} aria-expanded={drawer === 'definition'} data-rule-drawer-trigger onClick={event => openDrawer('definition', event.currentTarget)}>
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" aria-hidden="true"><path d="m5.5 4.5-3.5 3.5 3.5 3.5m5-7 3.5 3.5-3.5 3.5m-1-8-3 9" /></svg>
            <span>{t('rules.definition')}</span>
          </Button>
        </span></HintTooltip>
      </div>
    </header>
    <div className={css.body} data-rule-editor>
      {targets.size > 0 && (reason ? <HintTooltip label={reason}><p role="status" className={css.status} tabIndex={0} aria-label={status + ' · ' + reason}>{status}</p></HintTooltip> : <p role="status" className={css.status}>{status}</p>)}
      {drawer !== undefined && <aside data-rule-drawer data-canvas-obstacle="right" className={`${css.definitionDrawer} ${ui.configForm}`} aria-label={drawerLabel}
        onKeyDown={event => {
          if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
          event.stopPropagation()
          event.preventDefault()
          closeDrawer(true)
        }}>
      <div className={css.drawerHeading}>
        <h3>{drawerLabel}</h3>
        <Button icon aria-label={t('rules.closePanel', { name: drawerLabel })} onClick={() => closeDrawer(true)}><IconCloseFillRegular /></Button>
      </div>
      {drawer === 'identity' && <dl className={css.identityDetails}>
        <dt>{t('rules.module')}</dt><dd>{moduleName}</dd>
        <dt>{t('rules.name')}</dt><dd>{ruleName}</dd>
        {(saveStatus || feedback.publication) && <><dt>{t('rules.saveStateLabel')}</dt><dd>
          {saveText && <div>{saveText}</div>}
          {draft.retry === 'read' && draft.error && !draft.remote && draft.error !== publicationError && <div>{draft.error}</div>}
          {feedback.publication && <div>{feedback.publication}</div>}
          {publicationError && <div>{publicationError}</div>}
        </dd></>}
      </dl>}
      {drawer === 'properties' && <><div className={css.headerFields}>
        <FormField label={t('rules.rename')}><TextInput value={rule.id} spellCheck={false} readOnly={disabled} onChange={event => patch({ id: event.target.value })} /></FormField>
        <FormField label={t('rules.name')}><TextInput value={rule.name ?? ''} readOnly={disabled} onChange={event => patch({ name: event.target.value || undefined })} /></FormField>
        <FormField label={t('rules.executionScope')}><MenuSelect compact ariaLabel={t('rules.executionScope')} value={rule.executionScope ?? 'agent'} disabled={disabled}
          options={[{ value: 'agent', label: t('rules.agentScope') }, { value: 'process', label: t('rules.processScope') }]}
          onChange={executionScope => patch({ executionScope: executionScope as RuleDefinition['executionScope'] })} /></FormField>
        <FormField label={t('rules.layer')}><MenuSelect compact className={css.control} ariaLabel={t('rules.layer')} value={rule.layer ?? ''} disabled={disabled}
          options={[{ value: '', label: t('rules.module') }, ...props.meta.layers.map(layer => ({ value: layer, label: translateLabel(t, LAYER_LABEL_KEYS, layer) }))]}
          onChange={layer => patch({ layer: layer === '' ? undefined : layer as RuleDefinition['layer'] })} /></FormField>
        <FormField label={t('rules.group')} hint={t('rules.scopeHint')} hintMode="tooltip"><TextInput readOnly={disabled} value={rule.group ?? ''} onChange={event => patch({ group: event.target.value || undefined })} /></FormField>
        <FormField label={t('form.groupScope.label')}><MenuSelect compact ariaLabel={t('form.groupScope.label')} value={rule.groupScope ?? 'module'} disabled={disabled}
          options={[{ value: 'module', label: t('form.groupScope.module') }, { value: 'cross-module', label: t('form.groupScope.crossModule') }]}
          onChange={groupScope => patch({ groupScope: groupScope as RuleDefinition['groupScope'] })} /></FormField>
        <div className={css.toggle}><span>{t('rules.exclusive')}</span><span className={css.switchLine}><Switch label={t('rules.exclusive')} checked={rule.exclusive === true} disabled={disabled} onChange={exclusive => { patch({ exclusive }); save() }} /></span></div>
      </div>
      {props.renderSettings?.(rule, props.moduleId)}
      <div className={css.row}>
        <Button variant="outline" shape="pill" aria-label={t('rules.duplicate')} title={t('rules.duplicate')}
          disabled={disabled || draft.busy !== undefined || hasRuleFields(draft, entry.key)} onClick={props.onDuplicate}>{t('rules.duplicateButton')}</Button>
        <Button variant="outline" shape="pill" data-danger aria-label={t('rules.delete')} title={t('rules.delete')}
          disabled={disabled || draft.busy !== undefined} onClick={() => setConfirming(true)}>{t('rules.deleteButton')}</Button>
      </div></>}
      {drawer === 'definition' && <TriggerJsonField {...fieldContext} fieldKey={entry.key + ':full'} label={t('triggers.advanced')} shape="object" value={rule} onChange={value => {
        const candidate = asTriggerRecord(value)
        if (typeof candidate.id !== 'string' || !Array.isArray(candidate.then) || !candidate.then.every(isValidNode)
          || (candidate.else !== undefined && !nodeList(candidate.else).every(isValidNode))) {
          const raw = draft.fields.get(entry.key + ':full'); if (raw) raw.error = t('triggers.invalidJson'); return
        }
        for (const key of draft.fields.keys()) if (key.startsWith(entry.key + ':') && key !== entry.key + ':full') draft.fields.delete(key)
        editor.patch(entry.key, candidate as unknown as RuleDefinition)
        props.onRuleEdit?.()
      }} />}
      </aside>}
      {unsupported && <p role="alert" className={css.error}>{t('rules.unsupported')}</p>}
        <section data-config-panel="rule" aria-label={t('rules.stepsTab')} className={css.section}>{draft.meta && <RuleStepsPanel
          t={t} rule={rule} meta={draft.meta} engineMeta={props.meta} fields={draft.fields} expanded={props.expandedRows}
          libraryOpen={props.libraryOpen} libraryId={props.libraryId} onCloseLibrary={props.onCloseLibrary}
          instructionFiles={props.instructionFiles} activeInstructionId={props.activeInstructionId} hideNodeInspector={props.hideNodeInspector || drawer !== undefined} onSelectInstruction={props.onSelectInstruction}
          onCanvasInteract={() => { closeDrawer(false); props.onCanvasInteract() }}
          prefix={props.source ?? rule.id} fieldKey={entry.key} browseKey={JSON.stringify([props.moduleId, entry.key])} nodeBrowse={props.nodeBrowse} canvasBrowse={props.canvasBrowse} onBrowseChange={props.onBrowseChange}
          diagnosticActionId={props.diagnosticActionId} diagnosticFocusToken={props.diagnosticFocusToken} disabled={disabled} onDraft={onDraft}
          onChange={next => patch(next)} onMove={(path, index, offset) => autosave.commit(() => {
            if (!disabled && !unsupported) void editor.move(entry.key, path, index, offset)
          })} />}</section>
    </div>
    {confirming && <ConfirmDialog title={t('rules.delete')} description={t('rules.deleteHint', { id: rule.id })} confirmLabel={t('rules.deleteButton')} cancelLabel={t('triggers.cancel')}
      onCancel={() => setConfirming(false)} onConfirm={() => { editor.remove(entry.key); props.onRuleEdit?.(); void editor.submitRule(entry.key) }} />}
    {discarding && <ConfirmDialog title={t('triggers.discard')} description={t('triggers.discardHint')} confirmLabel={t('rules.discardButton')} cancelLabel={t('triggers.cancel')}
      onCancel={() => setDiscarding(false)} onConfirm={() => { editor.discard(); setDiscarding(false) }} />}
  </section></AutoSaveSelection.Provider>
}
