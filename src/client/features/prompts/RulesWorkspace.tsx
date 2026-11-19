import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { RuleDefinition } from '../../../shared/rules.ts'
import { MODULE_CAPABILITIES, isModuleCapabilityDeclared } from '../../../shared/engine-capabilities.ts'
import type { ModuleConfigOrderEntry } from '../../../shared/module-config-order.ts'
import { configIdentityKey } from '../../../shared/module-config-order.ts'
import type { DraftsPort, InstructionFilesPort, ModuleActionsPort, ModuleFactsPort, NoticePort, RuleEditingPort } from '../../data/store-ports.ts'
import { usePromptToolFields } from '../../data/use-prompt-tool-fields.ts'
import { useModuleRuleEditors, type ModuleRuleEditor } from '../../data/use-rule-editor.ts'
import { BLANK_MODULE_TEMPLATE, canEditModule, moduleDeclares, writableModuleTargets } from '../../data/module-subject.ts'
import { useModuleConfigOrder } from '../../data/use-module-config-order.ts'
import type { RuleDiagnosticTarget } from '../../data/rule-diagnostics-session.ts'
import { configPositionKey, reorderToView, sameConfigPosition } from '../../data/prompt-config-order.ts'
import { hasRuleFields, rulesDirty } from '../../data/rule-drafts.ts'
import { instructionFileIdOf } from '../../data/prompt-config-content.ts'
import { factsVisibleTo, ruleFacts, type RuleFacts } from '../../data/rule-facts.ts'
import type { LayerCardView } from '../../data/layer-cards.ts'
import type { PromptConfigDraft } from '../../prompt-tool-types.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { SearchInput } from '../../ui/SearchInput.tsx'
import { Button } from '../../ui/Button.tsx'
import { Switch } from '../../ui/Switch.tsx'
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { PublicationNotice } from '../../ui/PublicationNotice.tsx'
import { PromptConfigCard } from './PromptConfigCard.tsx'
import { LAYER_LABEL_KEYS, translateLabel } from './prompt-config-policy.ts'
import { asTriggerRecord } from './RuleJsonField.tsx'
import { RuleCard } from './RuleCard.tsx'
import { useTemplateCreate } from './useTemplatePicker.tsx'
import { TemplateTargetPicker } from '../../ui/TemplatePicker.tsx'
import type { ModuleCreateItem } from '../modules/EngineModuleList.tsx'
import ui from '../../ui/controls.module.css'
import css from './rules.module.css'

const ruleSearchText = new WeakMap<RuleDefinition, string>()
const factsOf = new WeakMap<RuleDefinition, RuleFacts>()

function searchableRule(rule: RuleDefinition): string {
  let text = ruleSearchText.get(rule)
  if (text === undefined) {
    text = JSON.stringify(rule).toLowerCase()
    ruleSearchText.set(rule, text)
  }
  return text
}

export interface RulesWorkspaceProps {
  store: ModuleFactsPort & DraftsPort & RuleEditingPort & InstructionFilesPort & NoticePort & ModuleActionsPort
  t: PromptToolTranslate; scope?: 'main' | 'subagent'
  browse?: { filter: string; expanded?: string; allModules?: boolean; rulesScroll?: number; ruleNodes?: Map<string, string>; combination?: boolean; diagnosticTarget?: RuleDiagnosticTarget; publish?: () => void }
  onRuleEdit?: () => void
  onReturnToDiagnostics?: () => void
  createdHidden?: boolean; onShowCreated?: () => void
  beforeCards?: ReactNode
  viewFilter?: string; onViewFilterChange?: (value: string) => void
  keyword?: string; onKeywordChange?: (value: string) => void
  /** 层内设置：主语＝该实例卡所属模块，由调用方传进第三参；第四参是该卡内工具模板入口。 */
  renderLayerSettings?: (layer: string, config: PromptConfigDraft, moduleId: string, onChooseToolTemplate: (moduleId: string, anchor: HTMLButtonElement) => void) => ReactNode
  /** 指令文件卡的设置区：卡是全局段、没有归属模块，主语由装配层按启用模块逐个给出。 */
  renderInstructionSettings?: (config: PromptConfigDraft) => ReactNode
  hasLayerSettings?: (layer: string, moduleId: string) => boolean
  /** 某层某模块的卡片（不含 add 与 missingCapability）：规则卡与能力补卡的搜索共用。 */
  layerCards?: (layer: string, moduleId: string) => readonly LayerCardView[]
  renderModuleSettings?: (moduleId: string, layers: readonly string[]) => ReactNode
  /** 页级「添加」下拉的创建项（注入模板按层）：创建编排由本组件统一持有，两页只传清单。 */
  createItems?: readonly ModuleCreateItem[]
  /** SSR 可断言的入口：直接以「模板已选完、等选目标」的状态渲染目标选择浮层本身。 */
  addingTarget?: boolean
}

/** 两个受众页共用各模块规则草稿；排序只写身份，指令文件只走原文件通道。
 *  **没有「当前模块」**：每张规则卡的主语是它自己所属的模块（`owners` 的 moduleId）。 */
export function RulesWorkspace(props: RulesWorkspaceProps): ReactNode {
  const { store, t } = props, fields = usePromptToolFields(store, value => value)
  const scope = props.scope ?? 'main'

  const [localExpanded, setExpanded] = useState<string | undefined>(props.browse?.expanded)
  const [localAllModules, setAllModules] = useState(props.browse?.allModules ?? false)
  const [localCombination, setCombination] = useState(props.browse?.combination ?? false)
  const expanded = props.browse?.publish ? props.browse.expanded : localExpanded
  const allModules = props.browse?.publish ? props.browse.allModules === true : localAllModules
  const combination = props.browse?.publish ? props.browse.combination === true : localCombination
  const [modulePending, setModulePending] = useState<string>()
  const [enablePublication, setEnablePublication] = useState<{ pending: boolean; error?: string }>()
  const [orderFeedback, setOrderFeedback] = useState('')
  const [filter, setFilter] = useState(props.browse?.filter ?? '')
  const nodeBrowse = props.browse && (props.browse.ruleNodes ??= new Map())
  const modules = store.meta.modules ?? []
  const diagnosticTarget = props.browse?.diagnosticTarget
  const enabledModules = modules.filter(module => module.enabled === true)
  const enabledIds = new Set(enabledModules.map(module => module.id))
  const ownerIds = (allModules ? modules : modules.filter(module => enabledIds.has(module.id) || module.id === diagnosticTarget?.moduleId))
    .filter(module => moduleDeclares(modules, module.id, 'rules') !== false).map(module => module.id)
  // 排序请求生命周期归 useModuleConfigOrder（全仓唯一一份实现）；页面只提供「保存成功后要刷新哪些编辑器」。
  const ownersRef = useRef<ModuleRuleEditor[]>([])
  const order = useModuleConfigOrder(t, async () => (await Promise.all(ownersRef.current.map(owner => owner.editor.load(true)))).every(Boolean))
  const owners = useModuleRuleEditors(store, ownerIds)
  const diagnosticOwner = owners.find(owner => owner.moduleId === diagnosticTarget?.moduleId)
  const diagnosticEntry = diagnosticOwner?.draft.entries.find(entry => !entry.deleted && (entry.previousId ?? entry.value.id) === diagnosticTarget?.ruleId)
  const diagnosticKey = diagnosticEntry && diagnosticOwner && configIdentityKey({ moduleId: diagnosticOwner.moduleId, configId: diagnosticEntry.key })
  const pendingDiagnostic = useRef(diagnosticTarget)
  ownersRef.current = owners
  const revisions = JSON.stringify(owners.map(owner => [owner.moduleId, owner.draft.revisions?.settings]))
  const [discard, setDiscard] = useState<string>()
  // 逐模块可编辑判据：判据来源是该模块自己的事实（/meta 的 modules[].facts）。
  const readOnly = (id: string): boolean => !canEditModule(fields, store.meta.modules, id)
  const orderBlocked = new Set(combination ? owners.filter(owner => enabledIds.has(owner.moduleId)
    && (owner.draft.busy !== undefined || rulesDirty(owner.draft) || owner.draft.remote !== undefined)).map(owner => owner.moduleId) : [])
  const sortDisabled = order.busy || orderBlocked.size > 0
  const query = (props.keyword ?? filter).trim().toLowerCase(), view = props.viewFilter ?? 'all'
  const changeFilter = (value: string): void => {
    if (props.browse?.publish) { props.browse.filter = value; props.browse.publish() }
    else { setFilter(value); props.onKeywordChange?.(value); if (props.browse) props.browse.filter = value }
  }
  const select = (key: string | undefined): void => {
    if (props.browse) { props.browse.expanded = key; props.browse.publish?.() }
    if (!props.browse?.publish) setExpanded(key)
  }
  const toggle = (key: string): void => select(expanded === key ? undefined : key)
  useEffect(() => { order.reset() }, [enabledModules.map(module => module.id).join('\u0000'), order.reset])
  useEffect(() => { void order.load() }, [revisions, store.meta.modules, order.load])
  /**
   * 把源卡移到目标卡前/后：判据（`sameConfigPosition`）与重排（`reorderToView`）都在 data 层，
   * 这里只算可移动集合、调一次保存。跨插入点的目标不在集合里，重排原样返回。
   */
  const saveOrder = async (sourceId: string, targetId: string, before: boolean): Promise<boolean> => {
    const cards = order.configs
    if (order.busy || sortDisabled || order.snapshot === undefined || sourceId === targetId) return false
    const source = cards.find(card => card.id === sourceId), target = cards.find(card => card.id === targetId)
    if (source === undefined || target === undefined || !sameConfigPosition(source, target)) return false
    const movableIds = cards.filter(card => sameConfigPosition(card, source)).map(card => card.id)
    const next = reorderToView(cards, sourceId, targetId, before, movableIds)
    if (next === cards) return false
    return order.save(next)
  }
  const factsFor = (rule: RuleDefinition): RuleFacts => {
    let facts = factsOf.get(rule)
    if (facts === undefined) { facts = ruleFacts(rule); factsOf.set(rule, facts) }
    return facts
  }
  const orderByIdentity = new Map(order.snapshot?.entries.map(entry => [configIdentityKey(entry), entry]) ?? [])
  const entries = owners.flatMap(owner => owner.draft.entries.map(entry => ({ ...owner, entry,
    key: configIdentityKey({ moduleId: owner.moduleId, configId: entry.key }),
    identity: configIdentityKey({ moduleId: owner.moduleId, configId: entry.previousId ?? entry.value.id }),
    facts: factsFor(entry.value),
  }))).filter(({ entry, key, facts }) => !entry.deleted && (expanded === key || diagnosticKey === key || factsVisibleTo(facts, scope)))
    .filter(({ entry, moduleId: id, key, facts }) => expanded === key || diagnosticKey === key || (view === 'all' || view === 'context-activation' && facts.contextActivation || entry.value.layer === view)
      && (!query || id.toLowerCase().includes(query) || searchableRule(entry.value).includes(query) || entry.value.layer !== undefined && props.layerCards?.(entry.value.layer, id)?.some((card) => card.searchText.includes(query))))
    .sort((a, b) => (orderByIdentity.get(a.identity)?.sequence ?? Number.MAX_SAFE_INTEGER) - (orderByIdentity.get(b.identity)?.sequence ?? Number.MAX_SAFE_INTEGER))
  const moduleSettings = enabledModules.flatMap(module => {
    const owner = owners.find(item => item.moduleId === module.id)
    if (moduleDeclares(store.meta.modules, module.id, 'rules') !== false && (!owner?.draft.loaded || owner.draft.error)) return []
    const layers = new Set((owner?.draft.entries ?? []).filter(entry => !entry.deleted && factsVisibleTo(factsFor(entry.value), scope))
      .map(entry => entry.value.layer))
    const missing = MODULE_CAPABILITIES.filter(capability => isModuleCapabilityDeclared(capability.id, module.facts)
      && !layers.has(capability.displayLayer))
      .map(capability => capability.displayLayer)
      .filter((layer, index, all) => all.indexOf(layer) === index)
      .filter(layer => view === 'all' || view === layer)
    if (missing.length === 0 || props.renderModuleSettings === undefined) return []
    const name = `${module.name ?? ''} ${module.id}`.toLowerCase()
    const visible = missing.filter(layer => !query || name.includes(query)
      || props.layerCards?.(layer, module.id)?.some((card) => card.kind === 'capability' && card.searchText.includes(query)))
    return visible.length === 0 ? [] : [{ moduleId: module.id, layers: visible }]
  })
  const batchOwners = new Set(entries.map(row => row.editor))
  const batchDisabled = entries.length === 0 || owners.some(({ moduleId: id, draft, editor }) => batchOwners.has(editor)
    && (readOnly(id) || !draft.loaded || draft.busy !== undefined || hasRuleFields(draft) || draft.remote !== undefined))
  const batchSetEnabled = (enabled: boolean): void => {
    if (batchDisabled) return
    for (const { entry, editor } of entries) {
      if ((entry.value.enabled !== false) !== enabled) editor.patch(entry.key, { ...entry.value, enabled })
    }
    props.onRuleEdit?.()
    for (const editor of batchOwners) void editor.submit()
  }
  const visibleIdentities = new Set(entries.map(row => row.identity))
  const peersByPosition = new Map<string, ModuleConfigOrderEntry[]>()
  const peerIndex = new Map<string, number>()
  if (combination) for (const item of order.snapshot?.entries ?? []) {
    const identity = configIdentityKey(item)
    if (!visibleIdentities.has(identity)) continue
    const position = configPositionKey(item)
    const peers = peersByPosition.get(position) ?? []
    peerIndex.set(identity, peers.length)
    peers.push(item)
    peersByPosition.set(position, peers)
  }
  const moveButtons = (entry: ModuleConfigOrderEntry): ReactNode => {
    const identity = configIdentityKey(entry)
    const peers = peersByPosition.get(configPositionKey(entry)) ?? [], index = peerIndex.get(identity) ?? -1
    const pinned = peers.length <= 1
    const id = `${entry.moduleId} / ${entry.configId}`
    return <span className={css.row}>
      {[-1, 1].map(delta => <HintTooltip key={delta} label={pinned ? t('rules.orderPinnedHint') : t(delta < 0 ? 'rules.moveUp' : 'rules.moveDown', { id })}>
        <Button variant="outline" shape="pill" icon aria-label={t(delta < 0 ? 'rules.moveUp' : 'rules.moveDown', { id })}
          aria-disabled={sortDisabled || peers[index + delta] === undefined}
          onClick={event => {
            const target = peers[index + delta]
            if (sortDisabled || target === undefined) return
            const trigger = event.currentTarget
            setOrderFeedback('')
            void saveOrder(identity, configIdentityKey(target), delta < 0).then(saved => {
              if (saved) setOrderFeedback(t('rules.orderSaved', { id }))
              requestAnimationFrame(() => { if (document.activeElement === document.body) trigger.focus({ preventScroll: true }) })
            })
          }}>{delta < 0 ? '↑' : '↓'}</Button>
      </HintTooltip>)}
    </span>
  }
  const duplicate = ({ moduleId, draft, editor }: ModuleRuleEditor, rule: RuleDefinition): void => {
    let id = rule.id + '-copy', suffix = 2
    while (draft.entries.some(entry => !entry.deleted && entry.value.id === id)) id = rule.id + '-copy-' + suffix++
    const clone = structuredClone(rule)
    clone.then = clone.then.map(action => { if (action.kind !== 'inject-text') return action; const { id: _sourceId, ...config } = asTriggerRecord(action.config); return { ...action, config } })
    select(configIdentityKey({ moduleId, configId: editor.add({ ...clone, id, enabled: false }) }))
  }
  // 页级创建编排（T18 唯一入口）：下拉 → 模板浮层 → 只加一步选目标 → 写入所选模块。
  // 主语来自目标选择，不存在「当前模块」；写入只落在该目标模块自己已读回的草稿上。
  // 候选＝**只列可写用户模块**（启用状态与总闸不参与目标判据）；写入前还会再判一次。
  const create = useTemplateCreate({
    store,
    t,
    items: props.createItems ?? [],
    scope,
    targets: writableModuleTargets(store.meta.modules).sort((a, b) => a.id.localeCompare(b.id)),
    existingIds: (store.meta.modules ?? []).map(module => module.id),
    onCreated: (moduleId, configKey) => {
      if (!enabledIds.has(moduleId)) {
        setAllModules(true)
        if (props.browse) props.browse.allModules = true
      }
      select(configIdentityKey({ moduleId, configId: configKey }))
    },
  })
  // 指令文件卡是全局段（不属于任何模块）：设置区的主语由装配层按每个启用模块给出（参数按模块存储）。
  const instructionCards = fields.instructionCards.map(config => <PromptConfigCard key={config.id} t={t} meta={store.meta} config={config} expanded={expanded === config.id} canMoveUp={false} canMoveDown={false}
    renderLayerSettings={props.renderInstructionSettings === undefined ? undefined : (_layer, card) => props.renderInstructionSettings!(card)}
    onToggleExpanded={() => toggle(config.id)} onToggleEnabled={() => {}} onPatch={(_id, patch) => { const fileId = instructionFileIdOf(config); if (fileId !== undefined && typeof patch.text === 'string') store.patchInstructionText(fileId, patch.text) }}
    onMoveUp={() => {}} onMoveDown={() => {}} onDuplicate={() => {}} onDelete={() => {}}
    onSaveInstructionFile={id => { void store.persistInstructionFiles([id]) }} onReloadInstructionFile={id => store.reloadInstructionFile(id).then(() => {})}
    onPatchInstructionPolicy={store.instructionPolicy.error === undefined ? (id, override) => { void store.updateInstructionPolicy(id, override) } : undefined} />)
  const selected = entries.find(row => row.key === expanded)
  const list = useRef<HTMLUListElement>(null)
  const selectedButton = useRef<HTMLButtonElement>(null)
  const detailHeading = useRef<HTMLHeadingElement>(null)
  const workspaceHeading = useRef<HTMLHeadingElement>(null)
  const lastButton = useRef<HTMLButtonElement | null>(null)
  const focus = useRef<'list' | 'detail'>()
  const saveSelected = useRef<() => void>()
  const scrollRestored = useRef(false)
  useLayoutEffect(() => {
    if (pendingDiagnostic.current && diagnosticKey !== undefined) {
      pendingDiagnostic.current = undefined
      if (expanded !== diagnosticKey) select(diagnosticKey)
      if (diagnosticTarget?.actionId === undefined) focus.current = 'detail'
    }
    if (list.current?.getClientRects().length && !scrollRestored.current && entries.length > 0) {
      list.current.scrollTop = props.browse?.rulesScroll ?? 0
      scrollRestored.current = true
    }
    if (focus.current === 'detail' && detailHeading.current) {
      detailHeading.current.focus({ preventScroll: true })
      focus.current = undefined
    } else if (focus.current === 'list') {
      (lastButton.current?.isConnected ? lastButton.current : workspaceHeading.current)?.focus({ preventScroll: true })
      focus.current = undefined
    }
  })
  const back = (): void => {
    saveSelected.current?.()
    lastButton.current = selectedButton.current
    focus.current = 'list'
    select(undefined)
  }
  const changeCombination = (next: boolean): void => {
    if (props.browse) { props.browse.combination = next; props.browse.publish?.() }
    if (!props.browse?.publish) setCombination(next)
    if (next && selected) back()
  }
  const setModuleEnabled = async (id: string, enabled: boolean): Promise<void> => {
    setModulePending(id)
    try {
      const result = await store.moduleActions.enable(id, enabled)
      if (result.ok) {
        setEnablePublication(result.publication)
        if (result.refreshError) store.showNotice('error', result.refreshError)
      } else store.showNotice('error', t('moduleSwitcher.notice.enableFailed', { reason: result.message ?? id }))
    } finally { setModulePending(undefined) }
  }
  const refreshExclusivePeers = (id: string, rule: RuleDefinition): void => {
    if (!enabledIds.has(id) || rule.groupScope !== 'cross-module' || rule.exclusive !== true || !rule.group) return
    for (const owner of ownersRef.current) {
      if (owner.moduleId !== id && enabledIds.has(owner.moduleId)
        && owner.draft.saved.some(saved => saved.group === rule.group && saved.groupScope === 'cross-module' && saved.exclusive)) {
        void owner.editor.load(true)
      }
    }
  }
  return <section className={css.workspaceContainer} aria-label={t('rules.list')}>
    {diagnosticTarget && props.onReturnToDiagnostics && <div className={css.row}>
      <Button shape="pill" variant="outline" onClick={() => { saveSelected.current?.(); props.onReturnToDiagnostics?.() }}>{t('diagnostics.return')}</Button>
      {diagnosticKey === undefined && (diagnosticOwner === undefined || diagnosticOwner.draft.loaded || diagnosticOwner.draft.error)
        && <p role="status">{t('diagnostics.targetUnavailable')}</p>}
    </div>}
    <div className={css.ruleWorkspace} data-rule-open={selected !== undefined || undefined}>
    <div className={css.ruleListPane}>
    <div className={css.row}>
      <h2 ref={workspaceHeading} tabIndex={-1} className={css.workspaceHeading}>{t('rules.list')}</h2>
      <Button shape="pill" variant="outline" aria-pressed={combination} onClick={() => changeCombination(!combination)}>{t('rules.combination')}</Button>
    </div>
    <div className={ui.listFilterRow} data-module-toolbar>
      <SearchInput inline aria-label={t('rules.search')} placeholder={t('rules.search')} value={props.keyword ?? filter} onChange={event => changeFilter(event.target.value)} />
      <MenuSelect compact ariaLabel={t('rules.participatingModules')} value={allModules ? 'all' : 'active'} options={[
        { value: 'active', label: t('rules.participatingModules') }, { value: 'all', label: t('rules.allModules') },
      ]} onChange={value => {
        const next = value === 'all'
        if (props.browse) { props.browse.allModules = next; props.browse.publish?.() }
        if (!props.browse?.publish) setAllModules(next)
        if (!next && selected && !enabledIds.has(selected.moduleId)) back()
      }} />
      <MenuSelect compact className={css.control} ariaLabel={t('rules.layerFilter')} value={view} options={[{ value: 'all', label: t('rules.all') }, { value: 'context-activation', label: t('rules.worldBook') }, ...store.meta.layers.map(layer => ({ value: layer, label: translateLabel(t, LAYER_LABEL_KEYS, layer) }))]} onChange={value => props.onViewFilterChange?.(value)} />
      {!combination && create.toolbar}
      {props.addingTarget && <TemplateTargetPicker t={t} modules={writableModuleTargets(store.meta.modules)}
        existingIds={(store.meta.modules ?? []).map(module => module.id)}
        newModuleTemplate={BLANK_MODULE_TEMPLATE} onPick={() => {}} onClose={() => {}} />}
      <span className={ui.batchControls}>
        <Button shape="pill" variant="outline" data-batch="enable" disabled={batchDisabled} onClick={() => batchSetEnabled(true)}>{t('configs.batch.enableVisible')}</Button>
        <Button shape="pill" variant="outline" data-danger data-batch="disable" disabled={batchDisabled} onClick={() => batchSetEnabled(false)}>{t('configs.batch.disableVisible')}</Button>
      </span>
    </div>
    {create.dialogs}
    {owners.map(({ moduleId: id, draft, editor }) => {
      return (draft.error || hasRuleFields(draft)) && <div key={id}>
        {draft.error && <div className={css.row}>
          <span>{t('rules.source', { module: id })}</span>
          <p role="alert" className={css.error}>{draft.remote ? t('rules.conflict') : draft.error}</p>
          <Button variant="outline" shape="pill" disabled={draft.busy !== undefined} onClick={() => { void editor.retry() }}>{t(editor.retryKind === 'save' ? 'rules.retrySave' : 'workspace.retry')}</Button>
          {(rulesDirty(draft) || draft.remote) && <Button variant="outline" shape="pill" disabled={draft.busy !== undefined} onClick={() => setDiscard(id)}>{t('triggers.discard')}</Button>}
        </div>}
        {hasRuleFields(draft) && <p role="alert" className={css.error}>{t('rules.source', { module: id })} · {t('rules.fieldsPending')}</p>}
      </div>
    })}
    {order.error && <p role="alert" className={css.error}>{order.error}</p>}
    {combination && <>
      <div role="status">{orderFeedback}</div>
      <PublicationNotice publication={order.publication} pendingLabel={t('publication.pending')} retryLabel={t('publication.retry')}
        onRetry={() => { void order.retryPublication() }} />
      <PublicationNotice publication={enablePublication} pendingLabel={t('publication.pending')} retryLabel={t('publication.retry')}
        onRetry={() => { void store.moduleActions.retryEnable().then(result => {
          if (result.ok) setEnablePublication(result.publication)
          else setEnablePublication({ pending: true, error: result.message })
        }) }} />
      <fieldset className={css.moduleParticipation}><legend>{t('rules.participatingModules')}</legend>
        {modules.map(module => <div key={module.id} className={css.row}>
          <span>{module.name || module.id}</span>
          <Switch label={t('rules.source', { module: module.id })} checked={module.enabled === true}
            disabled={modulePending !== undefined || order.busy || module.broken !== undefined || module.renderable === false}
            onChange={enabled => { void setModuleEnabled(module.id, enabled) }} />
        </div>)}
      </fieldset>
    </>}
    {props.createdHidden && <Button variant="outline" shape="pill" onClick={props.onShowCreated}>{t('rules.showCreated')}</Button>}
    <ul className={css.ruleList} ref={list} onScroll={event => { if (props.browse) props.browse.rulesScroll = event.currentTarget.scrollTop }}>
    {entries.map(row => {
        const { entry, moduleId: id, key, draft, editor } = row
        const orderEntry = orderByIdentity.get(row.identity)
        const pendingWinner = draft.activationPending === entry.value.id
        const selectableWinner = enabledIds.has(id) && entry.value.groupScope === 'cross-module' && entry.value.exclusive === true && Boolean(entry.value.group)
        return <li key={key} data-module-id={id}>
          <button type="button" className={css.ruleChoice} ref={selected?.key === key ? selectedButton : undefined} aria-current={selected?.key === key || undefined}
            onClick={event => {
              if (key !== expanded) saveSelected.current?.()
              if (combination) changeCombination(false)
              lastButton.current = event.currentTarget
              focus.current = 'detail'
              select(key)
              if (key === expanded) { detailHeading.current?.focus(); focus.current = undefined }
            }}>
            <span>{entry.value.name || entry.value.id}</span>
            <small>{id} · {entry.value.id} · {entry.value.layer === undefined ? t('rules.module') : translateLabel(t, LAYER_LABEL_KEYS, entry.value.layer)}
              {!enabledIds.has(id) ? ' · ' + t('rules.moduleInactive') : entry.value.enabled === false ? ' · ' + t('rules.identity.disabled') : ''}
              {combination && orderEntry && ' · ' + t('rules.combinationSequence', { sequence: orderEntry.sequence })}</small>
          </button>
          {combination && orderEntry && moveButtons(orderEntry)}
          {combination && selectableWinner && <Button shape="pill" variant="outline" disabled={readOnly(id) || modulePending !== undefined || order.busy || orderBlocked.has(id)}
            onClick={() => {
              const rule = entry.value
              if (!pendingWinner && rule.enabled === false) editor.patch(entry.key, { ...rule, enabled: true })
              const result = pendingWinner ? editor.retry() : editor.submit({ activateRuleId: rule.id })
              void result.then(() => refreshExclusivePeers(id, rule))
            }}>{pendingWinner ? t('rules.resumeWinner') : t('rules.selectWinner', { id: entry.value.id })}</Button>}
        </li>
      })}
    </ul>
    {entries.length === 0 && moduleSettings.length === 0 && (query !== '' || view !== 'all') && owners.every(owner => owner.draft.loaded) && <p>{t('rules.noMatch')}</p>}
    {!combination && <>{instructionCards}
    {props.beforeCards}
    {moduleSettings.map(item => <div key={`module-settings-${scope}-${item.moduleId}`} className={css.workspace} data-module-settings={item.moduleId}>{props.renderModuleSettings!(item.moduleId, item.layers)}</div>)}</>}
    </div>
    {selected && <div className={css.ruleDetail}>
      <Button shape="pill" variant="outline" onClick={back}>{t('rules.backToList')}</Button>
      <h2 ref={detailHeading} tabIndex={-1} className={css.workspaceHeading}>{selected.moduleId} / {selected.entry.value.id}</h2>
      <RuleCard key={selected.key} t={t} entry={selected.entry} draft={selected.draft} editor={selected.editor} meta={store.meta} source={selected.moduleId} moduleId={selected.moduleId} disabled={readOnly(selected.moduleId)}
        expanded onToggle={back} onDuplicate={() => duplicate(selected, selected.entry.value)} leaveSave={saveSelected} nodeBrowse={nodeBrowse} onBrowseChange={props.browse?.publish}
        diagnosticActionId={diagnosticKey === selected.key ? diagnosticTarget?.actionId : undefined}
        onRuleEdit={props.onRuleEdit}
        onActivate={() => refreshExclusivePeers(selected.moduleId, selected.entry.value)}
        expandedRows={store.editorDrafts.expanded}
        renderSettings={selected.entry.value.layer !== undefined && props.hasLayerSettings?.(selected.entry.value.layer, selected.moduleId) && props.renderLayerSettings ? (rule, module) => props.renderLayerSettings!(rule.layer!, { id: rule.id, layer: rule.layer }, module, create.openToolsForModule) : undefined} />
    </div>}
    </div>
    {discard && <ConfirmDialog title={t('triggers.discard')} description={t('triggers.discardHint')} confirmLabel={t('triggers.discard')} cancelLabel={t('triggers.cancel')} onCancel={() => setDiscard(undefined)} onConfirm={() => { owners.find(owner => owner.moduleId === discard)?.editor.discard(); setDiscard(undefined) }} />}
  </section>
}
