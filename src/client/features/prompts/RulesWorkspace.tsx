import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { RuleDefinition } from '../../../shared/rules.ts'
import type { InjectionPoint } from '../../../shared/engine-capabilities.ts'
import type { ModuleConfigOrderEntry } from '../../../shared/module-config-order.ts'
import { configIdentityKey } from '../../../shared/module-config-order.ts'
import type { DraftsPort, InstructionFilesPort, ModuleActionsPort, ModuleFactsPort, NoticePort, RuleEditingPort } from '../../data/store-ports.ts'
import { usePromptToolFields } from '../../data/use-prompt-tool-fields.ts'
import { useModuleRuleEditors, type ModuleRuleEditor } from '../../data/use-rule-editor.ts'
import { canEditSubject, moduleDeclares, writableModuleTargets } from '../../data/module-subject.ts'
import { useModuleConfigOrder } from '../../data/use-module-config-order.ts'
import type { RuleDiagnosticTarget } from '../../data/rule-diagnostics-session.ts'
import { configPositionKey, swapConfigOrder } from '../../data/prompt-config-order.ts'
import { hasRuleFields, rulesDirty } from '../../data/rule-drafts.ts'
import { instructionFileIdOf } from '../../data/prompt-config-content.ts'
import { ruleFacts, type RuleFacts } from '../../data/rule-facts.ts'
import { isModuleSettingsCard, moduleSettingsLayers, toolSettingsDeclared, type LayerCardView } from '../../data/layer-cards.ts'
import type { PromptConfigDraft } from '../../prompt-tool-types.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { CanvasChoiceContext } from '../../ui/MenuSelect.tsx'
import { SearchInput } from '../../ui/SearchInput.tsx'
import { Button } from '../../ui/Button.tsx'
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { PublicationNotice } from '../../ui/PublicationNotice.tsx'
import { ModulePickerCards } from '../modules/ModuleSwitcher.tsx'
import type { WorkspaceSidebar } from '../../app/workspace/workspace-browse-state.ts'
import { IconCloseFillRegular } from '../../ui/icons.tsx'
import { ActivityIcon, BlocksIcon, LibraryBigIcon, ListChecksIcon, PanelLeftCloseIcon } from './canvas-sidebar-icons.tsx'
import { InstructionFileInspector } from './InstructionFileInspector.tsx'
import { InstructionCanvas, type CanvasInstructionFile } from './RuleCanvas.tsx'
import { LAYER_LABEL_KEYS, translateLabel } from './prompt-config-policy.ts'
import { asTriggerRecord } from './RuleJsonField.tsx'
import { RuleCard } from './RuleCard.tsx'
import { useTemplateCreate } from './useTemplatePicker.tsx'
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

function selectedRuleIdentity(expanded: string | undefined): [string, string] | undefined {
  if (!expanded?.startsWith('[')) return undefined
  try {
    const identity: unknown = JSON.parse(expanded)
    if (Array.isArray(identity) && identity.length === 2 && typeof identity[0] === 'string' && typeof identity[1] === 'string') {
      return [identity[0], identity[1]]
    }
  } catch {
    // 共享选择也可能是指令文件 ID。
  }
}

function ModuleBrowser({ store, t, open, scope, editingModule, onBrowse, feedback }: {
  store: RulesWorkspaceProps['store']; t: PromptToolTranslate; open: boolean; scope: string; editingModule?: string
  onBrowse: (id: string, ruleKey?: string) => void; feedback: ReactNode
}): ReactNode {
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => { if (open) search.current?.focus({ preventScroll: true }) }, [open])
  return <>
    {open && <>
      <h2 className={css.workspaceHeading}>{t('rules.sidebarModules')}</h2>
      <SearchInput ref={search} aria-label={t('rules.moduleSearch')} placeholder={t('rules.moduleSearch')} value={query}
        onChange={event => setQuery(event.currentTarget.value)} onKeyDown={event => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing || !query.trim()) return
          const results = event.currentTarget.closest('aside')?.querySelectorAll<HTMLButtonElement>('[data-module-browse]')
          const exact = Array.from(results ?? []).find(button => button.dataset.moduleBrowse?.toLowerCase() === query.trim().toLowerCase())
          const target = exact ?? (results?.length === 1 ? results[0] : undefined)
          if (target && !target.disabled) { event.preventDefault(); target.click() }
        }} />
      {feedback}
    </>}
    <ModulePickerCards store={store} t={t} open={open} query={query} scope={scope} editingModule={editingModule} onBrowse={onBrowse} />
  </>
}

export interface RulesWorkspaceProps {
  store: ModuleFactsPort & DraftsPort & RuleEditingPort & InstructionFilesPort & NoticePort & ModuleActionsPort
  t: PromptToolTranslate
  renderDiagnostics?: () => ReactNode
  browse?: { sidebar?: WorkspaceSidebar; filter: string; expanded?: string; allModules?: boolean; moduleFilter?: string; rulesScroll?: number; ruleNodes?: Map<string, string>; ruleCanvas?: Map<string, { scale: number; x: number; y: number; positions: Record<string, { x: number; y: number }> }>; diagnosticTarget?: RuleDiagnosticTarget; publish?: () => void }
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
  renderModuleSettings?: (moduleId: string, layer: string, onChooseToolTemplate: (moduleId: string, anchor: HTMLButtonElement) => void) => ReactNode
  /** 模板选择器按注入层分组。 */
  createItems?: readonly ModuleCreateItem[]
}

/** 两个受众页共用各模块规则草稿；排序只写身份，指令文件只走原文件通道。
 *  **没有「当前模块」**：每张规则卡的主语是它自己所属的模块（`owners` 的 moduleId）。 */
export function RulesWorkspace(props: RulesWorkspaceProps): ReactNode {
  const { store, t } = props, fields = usePromptToolFields(store, value => value)

  const workspace = useRef<HTMLDivElement>(null)
  const saveInstruction = useRef<() => void>()
  const [fileSelection, setFileSelection] = useState<{ id: string; owner: typeof store.getInstructionPool; contextId: string | null }>()
  const [settingsSelection, setSettingsSelection] = useState<{ moduleId: string; layer: InjectionPoint; owner: typeof store.editorDrafts }>()
  const settingsTitleId = useId()
  const settingsHeading = useRef<HTMLHeadingElement>(null)
  const settingsTrigger = useRef<HTMLButtonElement>()
  const [localExpanded, setExpanded] = useState<string | undefined>(props.browse?.expanded)
  const [localSidebar, setLocalSidebar] = useState<WorkspaceSidebar>('library')
  const sidebar = props.browse?.publish ? props.browse.sidebar ?? 'library' : localSidebar
  const showList = sidebar === 'rules'
  const libraryOpen = sidebar === 'library'
  const panelOpen = showList || sidebar === 'modules' || sidebar === 'diagnostics'
  const nav = useRef<HTMLDivElement>(null)
  const listPaneId = useId()
  const dismissDrawer = useRef<() => void>()
  const modulePaneId = useId()
  const diagnosticPaneId = useId()
  const libraryId = useId()
  const libraryToggle = useRef<HTMLButtonElement>(null)
  const [localAllModules, setAllModules] = useState(props.browse?.allModules ?? false)
  const [localModuleFilter, setModuleFilter] = useState(props.browse?.moduleFilter)
  const expanded = props.browse?.publish ? props.browse.expanded : localExpanded
  const allModules = props.browse?.publish ? props.browse.allModules === true : localAllModules
  const { subscribeEnable, getEnableState, retryEnable } = store.moduleActions
  const { busy: modulePending, error: enableError, publication: enablePublication, refreshFailed: enableRefreshFailed } =
    useSyncExternalStore(subscribeEnable, getEnableState, getEnableState)
  const [orderFeedback, setOrderFeedback] = useState('')
  const [filter, setFilter] = useState(props.browse?.filter ?? '')
  const nodeBrowse = props.browse && (props.browse.ruleNodes ??= new Map())
  const modules = store.meta.modules ?? []
  const requestedModule = props.browse?.publish ? props.browse.moduleFilter : localModuleFilter
  const moduleFilter = modules.find(module => module.id === requestedModule)?.id
  const diagnosticTarget = props.browse?.diagnosticTarget
  const enabledModules = modules.filter(module => module.enabled === true)
  const enabledIds = new Set(enabledModules.map(module => module.id))
  const [editingModule, editingKey] = (!moduleFilter && !allModules ? selectedRuleIdentity(expanded) : undefined) ?? []
  // 参与范围内停用当前模块后，只保留正在编辑的规则。
  const pinnedModule = editingModule !== undefined && !enabledIds.has(editingModule) && editingModule !== diagnosticTarget?.moduleId ? editingModule : undefined
  const ownerIds = (moduleFilter ? modules.filter(module => module.id === moduleFilter)
    : allModules ? modules : modules.filter(module => enabledIds.has(module.id) || module.id === diagnosticTarget?.moduleId || module.id === pinnedModule))
    .filter(module => moduleDeclares(modules, module.id, 'rules') !== false).map(module => module.id)
  // 排序请求生命周期归 useModuleConfigOrder（全仓唯一一份实现）；页面只提供「保存成功后要刷新哪些编辑器」。
  const ownersRef = useRef<ModuleRuleEditor[]>([])
  const order = useModuleConfigOrder(t, async () => {
    const activeIds = new Set(ownersRef.current.map(owner => owner.moduleId))
    for (const [id, draft] of store.editorDrafts.rules) {
      if (enabledIds.has(id) && !activeIds.has(id) && draft.loaded) {
        draft.loaded = false
        store.publishDrafts(id)
      }
    }
    return (await Promise.all(ownersRef.current.filter(owner => enabledIds.has(owner.moduleId)).map(owner => owner.editor.load(true)))).every(Boolean)
  })
  const owners = useModuleRuleEditors(store, ownerIds)
  const diagnosticOwner = owners.find(owner => owner.moduleId === diagnosticTarget?.moduleId)
  const diagnosticEntry = diagnosticOwner?.draft.entries.find(entry => !entry.deleted && (entry.previousId ?? entry.value.id) === diagnosticTarget?.ruleId)
  const diagnosticKey = diagnosticEntry && diagnosticOwner && configIdentityKey({ moduleId: diagnosticOwner.moduleId, configId: diagnosticEntry.key })
  const handledDiagnostic = useRef<RuleDiagnosticTarget>()
  ownersRef.current = owners
  const revisions = JSON.stringify(owners.map(owner => [owner.moduleId, owner.draft.revisions?.settings]))
  const [discard, setDiscard] = useState<string>()
  // 逐模块可编辑判据：判据来源是该模块自己的事实（/meta 的 modules[].facts）。
  const writableIds = useMemo(() => new Set(store.meta.modules?.filter(module =>
    canEditSubject({ modulesEnabled: fields.modulesEnabled, moduleFacts: module.facts })).map(module => module.id)),
  [fields.modulesEnabled, store.meta.modules])
  const readOnly = (id: string): boolean => !writableIds.has(id)
  const needsOrderBlock = (draft: ModuleRuleEditor['draft']): boolean =>
    draft.busy !== undefined || draft.pending !== undefined || draft.remote !== undefined || rulesDirty(draft)
  const orderBlocked = () => showList && enabledModules.some(({ id }) => {
    const draft = store.editorDrafts.rules.get(id)
    return draft !== undefined && needsOrderBlock(draft)
  })
  const blocked = useSyncExternalStore(store.subscribeDrafts, orderBlocked, orderBlocked)
  const sortDisabled = order.busy || modulePending || blocked
  const query = (props.keyword ?? filter).trim().toLowerCase(), view = props.viewFilter ?? 'all'
  const changeFilter = (value: string): void => {
    if (props.browse?.publish) { props.browse.filter = value; props.browse.publish() }
    else { setFilter(value); props.onKeywordChange?.(value); if (props.browse) props.browse.filter = value }
  }
  const select = (key: string | undefined): void => {
    if (key !== expanded) setSettingsSelection(undefined)
    if (props.browse) { props.browse.expanded = key; props.browse.publish?.() }
    if (!props.browse?.publish) setExpanded(key)
  }
  useEffect(() => { order.reset() }, [enabledModules.map(module => module.id).join('\u0000'), order.reset])
  useEffect(() => { void order.load() }, [revisions, store.meta.modules, order.load])
  const saveOrder = async (sourceId: string, targetId: string): Promise<boolean> => {
    const cards = order.configs
    if (sortDisabled || order.snapshot === undefined || orderBlocked()) return false
    const next = swapConfigOrder(cards, sourceId, targetId)
    if (next === cards) return false
    return order.save(next)
  }
  const factsFor = (rule: RuleDefinition): RuleFacts => {
    let facts = factsOf.get(rule)
    if (facts === undefined) { facts = ruleFacts(rule); factsOf.set(rule, facts) }
    return facts
  }
  const orderByIdentity = new Map(order.snapshot?.entries.map((entry, index) => [configIdentityKey(entry), { entry, index }]) ?? [])
  const rows = owners.flatMap(owner => (owner.moduleId === pinnedModule
    ? owner.draft.entries.filter(entry => entry.key === editingKey)
    : owner.draft.entries).map(entry => ({ ...owner, entry,
    key: configIdentityKey({ moduleId: owner.moduleId, configId: entry.key }),
    identity: configIdentityKey({ moduleId: owner.moduleId, configId: entry.previousId ?? entry.value.id }),
    facts: factsFor(entry.value),
  }))).filter(({ entry }) => !entry.deleted)
  const visibleRows = rows.filter(({ entry, moduleId: id, facts }) =>
    (moduleFilter !== undefined || allModules || enabledIds.has(id))
    && (view === 'all' || view === 'context-activation' && facts.contextActivation || entry.value.layer === view)
    && (!query || id.toLowerCase().includes(query) || searchableRule(entry.value).includes(query) || entry.value.layer !== undefined && props.layerCards?.(entry.value.layer, id)?.some((card) => card.searchText.includes(query))))
  const entries = [...visibleRows]
  const diagnosticRow = rows.find(row => row.key === diagnosticKey)
  if (diagnosticRow && !entries.includes(diagnosticRow)) entries.push(diagnosticRow)
  entries.sort((a, b) => (orderByIdentity.get(a.identity)?.index ?? Number.MAX_SAFE_INTEGER) - (orderByIdentity.get(b.identity)?.index ?? Number.MAX_SAFE_INTEGER))
  const settingsModule = settingsSelection?.owner === store.editorDrafts && props.renderModuleSettings
    ? enabledModules.find(module => module.id === settingsSelection.moduleId && (!moduleFilter || module.id === moduleFilter)
      && module.broken === undefined && module.renderable !== false
      && moduleSettingsLayers(module).has(settingsSelection.layer)) : undefined
  const activeSettings = settingsModule === undefined ? undefined : settingsSelection
  const settingOwners = showList ? new Map(owners.map(owner => [owner.moduleId, owner])) : undefined
  const moduleSettings = settingOwners === undefined || props.renderModuleSettings === undefined ? [] : enabledModules.flatMap(module => {
    if (moduleFilter && module.id !== moduleFilter) return []
    if (module.broken !== undefined || module.renderable === false) return []
    const owner = settingOwners.get(module.id)
    if (moduleDeclares(store.meta.modules, module.id, 'rules') !== false && (!owner?.draft.loaded || owner.draft.error)) return []
    const layers = new Set((owner?.draft.entries ?? []).filter(entry => !entry.deleted)
      .map(entry => entry.value.layer))
    const missing = [...moduleSettingsLayers(module)].filter(layer => !layers.has(layer) && (view === 'all' || view === layer))
    if (missing.length === 0) return []
    const name = `${module.name ?? ''} ${module.id}`.toLowerCase()
    const visible = missing.filter(layer => !query || name.includes(query)
      || props.layerCards?.(layer, module.id)?.some((card) => card.kind !== 'param'
        && isModuleSettingsCard(card, toolSettingsDeclared(module)) && card.searchText.includes(query)))
    return visible.length === 0 ? [] : [{ moduleId: module.id, name: module.name || module.id, layers: visible }]
  })
  useLayoutEffect(() => {
    if (activeSettings) settingsHeading.current?.focus({ preventScroll: true })
  }, [activeSettings])
  const batchOwners = new Set(visibleRows.map(row => row.editor))
  const batchDisabled = visibleRows.length === 0 || owners.some(({ moduleId: id, draft, editor }) => batchOwners.has(editor)
    && (readOnly(id) || !draft.loaded || draft.busy !== undefined || hasRuleFields(draft) || draft.remote !== undefined))
  const batchSetEnabled = (enabled: boolean): void => {
    if (batchDisabled) return
    for (const { entry, editor } of visibleRows) {
      if ((entry.value.enabled !== false) !== enabled) editor.patch(entry.key, { ...entry.value, enabled })
    }
    props.onRuleEdit?.()
    for (const editor of batchOwners) void editor.submit()
  }
  const visibleIdentities = new Set(showList ? visibleRows.map(row => row.identity) : [])
  const peersByPosition = new Map<string, ModuleConfigOrderEntry[]>()
  const peerIndex = new Map<string, number>()
  for (const item of showList ? order.snapshot?.entries ?? [] : []) {
    const identity = configIdentityKey(item)
    if (!visibleIdentities.has(identity)) continue
    const position = configPositionKey(item)
    const peers = peersByPosition.get(position) ?? []
    peerIndex.set(identity, peers.length)
    peers.push(item)
    peersByPosition.set(position, peers)
  }
  const moveButtons = (identity: string, entry: ModuleConfigOrderEntry | undefined, id: string): ReactNode => {
    const peers = entry === undefined ? undefined : peersByPosition.get(configPositionKey(entry))
    const index = peerIndex.get(identity)
    return [-1, 1].map(delta => {
      const target = index === undefined ? undefined : peers?.[index + delta]
      const label = t(delta < 0 ? 'rules.moveUp' : 'rules.moveDown', { id })
      const unavailable = sortDisabled || entry === undefined || target === undefined || readOnly(entry.moduleId) || readOnly(target.moduleId)
      return <button key={delta} type="button" className={css.ruleMove} aria-label={label} title={label}
        aria-disabled={unavailable} tabIndex={unavailable ? -1 : undefined}
        onClick={event => {
          event.stopPropagation()
          if (unavailable) return
          const trigger = event.currentTarget
          setOrderFeedback('')
          void saveOrder(identity, configIdentityKey(target)).then(saved => {
            if (saved) setOrderFeedback(t('rules.orderSaved', { id }))
            requestAnimationFrame(() => { if (document.activeElement === document.body) trigger.focus({ preventScroll: true }) })
          })
        }}>{delta < 0 ? '↑' : '↓'}</button>
    })
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
    targets: writableModuleTargets(store.meta.modules).sort((a, b) => a.id.localeCompare(b.id)),
    existingIds: (store.meta.modules ?? []).map(module => module.id),
    onCreated: (moduleId, configKey) => {
      if (moduleFilter && moduleFilter !== moduleId) {
        if (props.browse) props.browse.moduleFilter = moduleId
        setModuleFilter(moduleId)
      }
      if (!enabledIds.has(moduleId)) {
        setAllModules(true)
        if (props.browse) props.browse.allModules = true
      }
      select(configIdentityKey({ moduleId, configId: configKey }))
    },
  })
  const files = useMemo(() => fields.instructionCards.flatMap(config => {
    const id = instructionFileIdOf(config)
    if (id === undefined) return []
    const path = String(config.params?.displayPath ?? config.params?.file ?? '')
    const name = store.instructionPolicy.policy.files?.[id]?.name || path.split(/[\\/]/).pop() || config.name || id
    const summary = t(config.params?.scope === 'global' ? 'rules.globalInstruction' : 'rules.workspaceInstruction')
    return [{ id, path, name, summary, enabled: config.enabled !== false && config.agentControl?.enabled !== false } satisfies CanvasInstructionFile]
  }), [fields.instructionCards, store.instructionPolicy.policy, t])
  const contextId = files.length ? store.getInstructionPool().contextId : null
  const activeFile = fileSelection?.owner === store.getInstructionPool && fileSelection.contextId === contextId
    ? fields.instructionCards.find(config => instructionFileIdOf(config) === fileSelection.id) : undefined
  const activeFileId = activeFile && instructionFileIdOf(activeFile)
  const closeInstruction = (restoreFocus: boolean): void => {
    if (!activeFileId) return
    saveInstruction.current?.()
    setFileSelection(undefined)
    if (restoreFocus) workspace.current?.querySelector<HTMLButtonElement>(`[data-instruction-file-id="${CSS.escape(activeFileId)}"]`)?.focus({ preventScroll: true })
  }
  const closeSettings = (restoreFocus: boolean): void => {
    if (!settingsSelection) return
    setSettingsSelection(undefined)
    if (!restoreFocus) return
    const trigger = settingsTrigger.current
    const fallback = nav.current?.querySelector<HTMLButtonElement>(`[aria-controls="${CSS.escape(listPaneId)}"]`)
    ;(trigger?.getClientRects().length ? trigger : fallback)?.focus({ preventScroll: true })
  }
  const closeRightEditor = (): void => { closeInstruction(false); closeSettings(false) }
  const openInstruction = (id: string): void => {
    if (id !== activeFileId) saveInstruction.current?.()
    closeSettings(false)
    dismissDrawer.current?.()
    setFileSelection({ id, owner: store.getInstructionPool, contextId })
  }
  const fileInspector = activeFile && <InstructionFileInspector key={activeFileId} store={store} t={t} config={activeFile}
    leaveSave={saveInstruction} renderInstructionSettings={props.renderInstructionSettings} onClose={closeInstruction} />
  const selected = rows.find(row => row.key === expanded)
  useEffect(() => {
    if (expanded === undefined && entries[0]) select(entries[0].key)
  })
  const list = useRef<HTMLUListElement>(null)
  const selectedButton = useRef<HTMLButtonElement>(null)
  const detailHeading = useRef<HTMLHeadingElement>(null)
  const workspaceHeading = useRef<HTMLHeadingElement>(null)
  const lastButton = useRef<HTMLButtonElement | null>(null)
  const focus = useRef<'list' | 'detail'>()
  const saveSelected = useRef<() => void>()
  const scrollRestored = useRef(false)
  useLayoutEffect(() => {
    if (diagnosticTarget === undefined) handledDiagnostic.current = undefined
    else if (diagnosticKey !== undefined && handledDiagnostic.current !== diagnosticTarget) {
      closeRightEditor()
      if (expanded !== diagnosticKey) select(diagnosticKey)
      else {
        handledDiagnostic.current = diagnosticTarget
        if (diagnosticTarget.actionId === undefined || (detailHeading.current && getComputedStyle(detailHeading.current).visibility === 'hidden')) {
          focus.current = 'detail'
        }
      }
    }
    if (list.current?.getClientRects().length && !scrollRestored.current && entries.length > 0) {
      list.current.scrollTop = props.browse?.rulesScroll ?? 0
      scrollRestored.current = true
    }
    if (focus.current === 'detail' && detailHeading.current) {
      if (getComputedStyle(detailHeading.current).visibility === 'hidden') selectedButton.current?.focus()
      else detailHeading.current.focus({ preventScroll: true })
      focus.current = undefined
    } else if (focus.current === 'list') {
      (lastButton.current?.isConnected && lastButton.current.getClientRects().length ? lastButton.current : workspaceHeading.current)?.focus({ preventScroll: true })
      focus.current = undefined
    }
  })
  const changeModuleScope = (value: string, ruleKey?: string): void => {
    const nextModule = value.startsWith('module:') ? value.slice('module:'.length) : undefined
    const nextAll = value !== 'active'
    if (nextModule !== undefined) closeRightEditor()
    const leavesRule = selected !== undefined && nextModule !== undefined && selected.moduleId !== nextModule
    if (leavesRule || (ruleKey !== undefined && selected?.entry.key !== ruleKey)) saveSelected.current?.()
    if (!showList || ruleKey !== undefined) {
      focus.current = ruleKey === undefined ? 'list' : 'detail'
      lastButton.current = null
    }
    if (props.browse) {
      props.browse.moduleFilter = nextModule
      props.browse.allModules = nextAll
      props.browse.sidebar = 'rules'
    }
    if (!props.browse?.publish) {
      setModuleFilter(nextModule)
      setAllModules(nextAll)
      setLocalSidebar('rules')
    }
    if (nextModule !== undefined && ruleKey !== undefined) {
      select(configIdentityKey({ moduleId: nextModule, configId: ruleKey }))
    } else if (leavesRule) select(undefined)
    else props.browse?.publish?.()
  }
  const setSidebar = (next: WorkspaceSidebar): void => {
    if (next === sidebar) return
    if (props.browse) {
      props.browse.sidebar = next
      props.browse.publish?.()
    }
    if (!props.browse?.publish) setLocalSidebar(next)
  }
  const openList = (): void => {
    saveSelected.current?.()
    lastButton.current = selectedButton.current
    focus.current = 'list'
    setSidebar('rules')
  }
  const closeList = (restoreFocus: boolean): void => {
    setSidebar('hidden')
    if (restoreFocus) nav.current?.querySelector<HTMLButtonElement>('[aria-pressed=true]')?.focus({ preventScroll: true })
  }
  const withEnableFocus = async (run: () => Promise<unknown>): Promise<void> => {
    if (getEnableState().busy || order.busy) return
    const action = document.activeElement
    const actionPanel = document.getElementById(modulePaneId)
    try { await run() } finally {
      requestAnimationFrame(() => {
        if (document.activeElement !== document.body || !(action instanceof HTMLElement)) return
        if (action.getClientRects().length) action.focus({ preventScroll: true })
        else if (!action.isConnected) {
          const fallback = actionPanel ? actionPanel.querySelector('input') : workspaceHeading.current
          if (fallback?.getClientRects().length) fallback.focus({ preventScroll: true })
        }
      })
    }
  }
  const enableFeedback = (modulePending || enableError !== undefined || enableRefreshFailed || enablePublication?.pending === true) && <div className={css.modulePickerFeedback}>
    {modulePending && <p role="status">{t('rules.moduleChanging')}</p>}
    {enableError && <p role="alert" className={css.error}>{t('moduleSwitcher.notice.enableFailed', { reason: enableError })}</p>}
    {enableRefreshFailed && <p role="alert" className={css.error}>{t('rules.moduleListRefreshFailed')}</p>}
    {enableRefreshFailed && enablePublication?.pending !== true &&
      <Button variant="outline" shape="pill" size="sm" disabled={modulePending || order.busy}
        aria-label={t('rules.refreshModules')} title={t('rules.refreshModules')} onClick={() => { void withEnableFocus(retryEnable) }}>{t('canvas.refresh')}</Button>}
    <PublicationNotice publication={enablePublication} pendingLabel={t('publication.pending')} retryLabel={t('publication.retry')} retryButtonLabel={t('publication.retryButton')}
      disabled={modulePending || order.busy}
      onRetry={() => { void withEnableFocus(retryEnable) }} />
  </div>
  const refreshExclusivePeers = (id: string, rule: RuleDefinition): void => {
    if (!enabledIds.has(id) || rule.groupScope !== 'cross-module' || rule.exclusive !== true || !rule.group) return
    const active = new Map(ownersRef.current.map(owner => [owner.moduleId, owner.editor]))
    for (const [peerId, draft] of store.editorDrafts.rules) {
      if (peerId === id || !enabledIds.has(peerId) || !draft.loaded
        || !draft.saved.some(saved => saved.group === rule.group && saved.groupScope === 'cross-module' && saved.exclusive)) continue
      const editor = active.get(peerId)
      if (editor) void editor.load(true)
      else {
        draft.loaded = false
        store.publishDrafts(peerId)
      }
    }
  }
  const diagnosticsLabel = t(diagnosticTarget && props.onReturnToDiagnostics ? 'diagnostics.return' : 'rules.sidebarDiagnostics')
  const libraryLabel = t(libraryOpen ? 'rules.hideLibrary' : 'rules.showLibrary')
  return <CanvasChoiceContext.Provider value={t}><section className={css.workspaceContainer} aria-label={t('rules.list')}>
    {diagnosticTarget && diagnosticKey === undefined && (diagnosticOwner === undefined || diagnosticOwner.draft.loaded || diagnosticOwner.draft.error) &&
      <p role="status">{t('diagnostics.targetUnavailable')}</p>}
    <div ref={workspace} className={css.ruleWorkspace} data-rule-open={selected !== undefined || files.length > 0 || undefined} data-list-open={panelOpen || undefined} data-canvas-workspace
      onClick={event => {
        if ((!dismissDrawer.current && !activeSettings) || event.defaultPrevented || !(event.target instanceof Element)) return
        const target = event.target
        if (!event.currentTarget.contains(target) || target.closest('dialog, [role="dialog"], [role="menu"], [popover], [data-rule-node], [data-module-settings-inspector]')
          || !target.closest('button, input, select, textarea, summary, a[href]')) return
        if (!target.closest('[data-rule-drawer], [data-rule-drawer-trigger]')) dismissDrawer.current?.()
        if (!target.closest('[data-open-module-settings]')) closeSettings(false)
      }}>
    <div ref={nav} className={css.moduleScope} data-canvas-obstacle="top" role="group" aria-label={t('rules.sidebar')}>
      <HintTooltip label={enableFeedback ? `${t('rules.sidebarModules')} · ${t('rules.moduleFeedback')}` : t('rules.sidebarModules')}>
        <button type="button" aria-label={t('rules.sidebarModules')} aria-description={enableFeedback ? t('rules.moduleFeedback') : undefined}
          aria-pressed={sidebar === 'modules'} aria-controls={modulePaneId} onClick={() => setSidebar(sidebar === 'modules' ? 'hidden' : 'modules')}>
          <BlocksIcon />{enableFeedback && <span className={css.modulePickerIndicator} aria-hidden="true">!</span>}
        </button>
      </HintTooltip>
      <HintTooltip label={t('rules.sidebarRules')}>
        <button type="button" aria-label={t('rules.sidebarRules')} aria-pressed={showList} aria-controls={listPaneId}
          onClick={event => {
            if (showList) { event.stopPropagation(); closeList(false) }
            else openList()
          }}><ListChecksIcon /></button>
      </HintTooltip>
      <HintTooltip label={libraryLabel}>
        <button type="button" ref={libraryToggle} disabled={!selected?.draft.meta} aria-pressed={libraryOpen && Boolean(selected?.draft.meta)}
          aria-label={libraryLabel} title={!selected?.draft.meta ? t('rules.nodeLibrary') : undefined}
          aria-controls={selected?.draft.meta ? libraryId : undefined} onClick={() => setSidebar(libraryOpen ? 'hidden' : 'library')}><LibraryBigIcon /></button>
      </HintTooltip>
      <HintTooltip label={t('rules.sidebarHide')}>
        <button type="button" aria-label={t('rules.sidebarHide')} aria-pressed={sidebar === 'hidden'}
          onClick={event => { event.stopPropagation(); setSidebar('hidden') }}><PanelLeftCloseIcon /></button>
      </HintTooltip>
      <HintTooltip label={diagnosticsLabel}>
        <button type="button" aria-label={diagnosticsLabel} aria-pressed={sidebar === 'diagnostics'} aria-controls={diagnosticPaneId} onClick={() => {
          if (diagnosticTarget && props.onReturnToDiagnostics) {
            saveSelected.current?.()
            closeRightEditor()
            props.onReturnToDiagnostics()
          } else setSidebar(sidebar === 'diagnostics' ? 'hidden' : 'diagnostics')
        }}><ActivityIcon /></button>
      </HintTooltip>
    </div>
    <aside id={modulePaneId} className={css.ruleListPane} data-canvas-obstacle="left" hidden={sidebar !== 'modules'} aria-label={t('rules.sidebarModules')}>
      <ModuleBrowser store={store} t={t} open={sidebar === 'modules'} scope={moduleFilter ? `module:${moduleFilter}` : allModules ? 'all' : 'active'}
        editingModule={selected?.moduleId} onBrowse={(id, key) => changeModuleScope(`module:${id}`, key)} feedback={enableFeedback} />
    </aside>
    <aside id={diagnosticPaneId} className={css.ruleListPane} data-canvas-obstacle="left" hidden={sidebar !== 'diagnostics'} aria-label={t('rules.sidebarDiagnostics')}>
      {sidebar === 'diagnostics' && <><h2 className={css.workspaceHeading}>{t('rules.sidebarDiagnostics')}</h2>{props.renderDiagnostics?.()}</>}
    </aside>
    <div id={listPaneId} className={css.ruleListPane} data-canvas-obstacle="left" hidden={!showList}>
    <div className={css.ruleListHeader}>
      <h2 ref={workspaceHeading} tabIndex={-1} className={css.workspaceHeading}>{t('rules.list')}</h2>
      {create.toolbar}
      <Button icon aria-label={t('rules.closePanel', { name: t('rules.list') })}
        onClick={event => { event.stopPropagation(); closeList(true) }}><IconCloseFillRegular /></Button>
    </div>
    <div className={css.ruleSearchBar}>
      <SearchInput inline aria-label={t('rules.search')} placeholder={t('rules.search')} value={props.keyword ?? filter} onChange={event => changeFilter(event.target.value)} />
      <div className={css.ruleBatchActions} role="group" aria-label={t('rules.batchActions')}>
        <button type="button" data-batch="enable" disabled={batchDisabled} aria-label={t('rules.enableVisible')} title={t('rules.enableVisible')}
          onClick={() => batchSetEnabled(true)}>{t('configs.batch.enableVisible')}</button>
        <button type="button" data-batch="disable" disabled={batchDisabled} aria-label={t('rules.disableVisible')} title={t('rules.disableVisible')}
          onClick={() => batchSetEnabled(false)}>{t('configs.batch.disableVisible')}</button>
      </div>
    </div>
    <div className={css.ruleFilters}>
      <select className={css.ruleLayerFilter} aria-label={t('rules.layerFilter')} value={view}
        onChange={event => props.onViewFilterChange?.(event.currentTarget.value)}>
        <option value="all">{t('rules.all')}</option>
        <option value="context-activation">{t('rules.worldBook')}</option>
        {store.meta.layers.map(layer => <option key={layer} value={layer}>{translateLabel(t, LAYER_LABEL_KEYS, layer)}</option>)}
      </select>
      <div className={css.browseScopes} role="group" aria-label={t('rules.browseScope')}>
        <button type="button" title={t('rules.participatingModules')} aria-pressed={!moduleFilter && !allModules} onClick={() => changeModuleScope('active')}>{t('canvas.participating')}</button>
        <button type="button" aria-label={t('rules.allModules')} aria-pressed={!moduleFilter && allModules} onClick={() => changeModuleScope('all')}>{t('configs.view.all')}</button>
      </div>
    </div>
    {owners.map(({ moduleId: id, draft, editor }) => {
      return (draft.error || hasRuleFields(draft)) && <div key={id}>
        {draft.error && <div className={css.row}>
          <span>{t('rules.source', { module: id })}</span>
          <p role="alert" className={css.error}>{draft.remote ? t('rules.conflict') : draft.error}</p>
          <Button variant="outline" shape="pill" disabled={draft.busy !== undefined} aria-label={t(editor.retryKind === 'save' ? 'rules.retrySave' : 'workspace.retry')}
            title={t(editor.retryKind === 'save' ? 'rules.retrySave' : 'workspace.retry')} onClick={() => { void editor.retry() }}>{t(editor.retryKind === 'save' ? 'rules.retrySaveButton' : 'rules.reloadButton')}</Button>
          {(rulesDirty(draft) || draft.remote) && <Button variant="outline" shape="pill" disabled={draft.busy !== undefined}
            aria-label={t('triggers.discard')} title={t('triggers.discard')} onClick={() => setDiscard(id)}>{t('rules.discardButton')}</Button>}
        </div>}
        {hasRuleFields(draft) && <p role="alert" className={css.error}>{t('rules.source', { module: id })} · {t('rules.fieldsPending')}</p>}
      </div>
    })}
    {order.error && <p role="alert" className={css.error}>{order.error}</p>}
    <div role="status" className={ui.visuallyHidden}>{orderFeedback}</div>
    <PublicationNotice publication={order.publication} pendingLabel={t('publication.pending')} retryLabel={t('publication.retry')} retryButtonLabel={t('publication.retryButton')}
      disabled={order.busy} onRetry={() => { void order.retryPublication() }} />
    {props.createdHidden && <Button variant="outline" shape="pill" onClick={props.onShowCreated}>{t('rules.showCreated')}</Button>}
    <ul className={css.ruleList} ref={list} onScroll={event => { if (props.browse) props.browse.rulesScroll = event.currentTarget.scrollTop }}>
    {entries.map(row => {
        const { entry, moduleId: id, key, draft, editor } = row
        const orderEntry = orderByIdentity.get(row.identity)?.entry
        const pendingWinner = draft.activationPending === entry.value.id
        const selectableWinner = enabledIds.has(id) && entry.value.groupScope === 'cross-module' && entry.value.exclusive === true && Boolean(entry.value.group)
        const name = entry.value.name || entry.value.id
        return <li key={key} data-module-id={id}>
          <button type="button" title={`${name} · ${id}`} aria-label={t('rules.editNamed', { name })} className={css.ruleChoice} ref={selected?.key === key ? selectedButton : undefined} aria-current={selected?.key === key || undefined}
            onClick={event => {
              closeRightEditor()
              if (key !== expanded) saveSelected.current?.()
              lastButton.current = event.currentTarget
              focus.current = 'detail'
              select(key)
            }}>
            <strong>{name}</strong>
          </button>
          {showList && selectableWinner && <button type="button" className={css.ruleWinner}
            disabled={readOnly(id) || modulePending || order.busy || (pendingWinner ? draft.busy !== undefined : needsOrderBlock(draft))}
            aria-label={pendingWinner ? t('rules.resumeWinner') : t('rules.selectWinner', { id: entry.value.id })}
            title={pendingWinner ? t('rules.resumeWinner') : t('rules.selectWinner', { id: entry.value.id })}
            onClick={event => {
              event.stopPropagation()
              const rule = entry.value
              if (!pendingWinner && rule.enabled === false) editor.patch(entry.key, { ...rule, enabled: true })
              const result = pendingWinner ? editor.retry() : editor.submit({ activateRuleId: rule.id })
              void result.then(() => refreshExclusivePeers(id, rule))
            }}>{pendingWinner ? '↻' : '✓'}</button>}
          {showList && moveButtons(row.identity, orderEntry, `${id} / ${name}`)}
        </li>
      })}
    </ul>
    {entries.length === 0 && moduleSettings.length === 0 && owners.every(owner => owner.draft.loaded) && <p>{t('rules.noMatch')}</p>}
    {props.beforeCards}
    {moduleSettings.length > 0 && <ul className={css.moduleSettingsList}>
      {moduleSettings.flatMap(item => item.layers.map(layer => <li key={configIdentityKey({ moduleId: item.moduleId, configId: layer })}>
        <button className={css.ruleChoice} type="button" data-open-module-settings
          aria-current={activeSettings?.moduleId === item.moduleId && activeSettings.layer === layer || undefined}
          onClick={event => {
            closeInstruction(false)
            dismissDrawer.current?.()
            settingsTrigger.current = event.currentTarget
            setSettingsSelection({ moduleId: item.moduleId, layer, owner: store.editorDrafts })
          }}>
          <strong>{item.name}</strong><small>{translateLabel(t, LAYER_LABEL_KEYS, layer)}</small>
        </button>
      </li>))}
    </ul>}
    </div>
    {!selected && files.length > 0 && <div className={css.ruleDetail}>
      <InstructionCanvas t={t} files={files} activeId={activeFileId} onSelect={openInstruction} onPaneClick={closeRightEditor} />
      {fileInspector}
    </div>}
    {!selected && files.length === 0 && !panelOpen && <div className={css.emptyCanvas}
      onClick={event => { if (event.target === event.currentTarget) closeSettings(false) }}>
      <h2>{t('rules.noOpenRule')}</h2>
      <Button variant="outline" aria-label={t('rules.list')} aria-controls={listPaneId} onClick={openList}>{t('rules.sidebarRules')}</Button>
    </div>}
    {selected && <div className={css.ruleDetail}>
      <h2 ref={detailHeading} tabIndex={-1} className={css.canvasAccessibleHeading}>{selected.moduleId} / {selected.entry.value.id}</h2>
      <RuleCard key={selected.key} t={t} entry={selected.entry} draft={selected.draft} editor={selected.editor} meta={store.meta} source={selected.moduleId} moduleId={selected.moduleId} disabled={readOnly(selected.moduleId)}
        dismissDrawer={dismissDrawer} instructionFiles={files} activeInstructionId={activeFileId} onSelectInstruction={openInstruction}
        onCloseInstruction={closeRightEditor} hideNodeInspector={activeSettings !== undefined}
        moduleName={modules.find(module => module.id === selected.moduleId)?.name || selected.moduleId} moduleEnabled={enabledIds.has(selected.moduleId)} modulesEnabled={fields.modulesEnabled}
        onDuplicate={() => duplicate(selected, selected.entry.value)} leaveSave={saveSelected} nodeBrowse={nodeBrowse} canvasBrowse={props.browse?.ruleCanvas} onBrowseChange={props.browse?.publish}
        libraryOpen={libraryOpen} libraryId={libraryId} onCloseLibrary={() => {
          setSidebar('hidden')
          libraryToggle.current?.focus({ preventScroll: true })
        }}
        onCanvasInteract={closeRightEditor}
        diagnosticFocusToken={diagnosticKey === selected.key ? diagnosticTarget : undefined}
        diagnosticActionId={diagnosticKey === selected.key ? diagnosticTarget?.actionId : undefined}
        onRuleEdit={props.onRuleEdit}
        onActivate={() => refreshExclusivePeers(selected.moduleId, selected.entry.value)}
        expandedRows={store.editorDrafts.expanded}
        renderSettings={selected.entry.value.layer !== undefined && props.hasLayerSettings?.(selected.entry.value.layer, selected.moduleId) && props.renderLayerSettings ? (rule, module) => props.renderLayerSettings!(rule.layer!, { id: rule.id, layer: rule.layer }, module, create.openToolsForModule) : undefined} />
      {fileInspector}
    </div>}
    {activeSettings && settingsModule && <aside key={configIdentityKey({ moduleId: activeSettings.moduleId, configId: activeSettings.layer })}
      className={css.moduleSettingsInspector} data-canvas-obstacle="right" data-module-settings-inspector={settingsModule.id} data-layer-settings={activeSettings.layer}
      aria-labelledby={settingsTitleId} onKeyDown={event => {
        if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
          || !(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return
        event.preventDefault()
        event.stopPropagation()
        closeSettings(true)
      }}>
      <header className={css.inspectorHeading}>
        <div>
          <h2 id={settingsTitleId} ref={settingsHeading} tabIndex={-1}>{settingsModule.name || settingsModule.id}</h2>
          <small>{translateLabel(t, LAYER_LABEL_KEYS, activeSettings.layer)}</small>
        </div>
        <Button icon aria-label={t('rules.closePanel', { name: t('form.navigation.settings') })} onClick={() => closeSettings(true)}><IconCloseFillRegular /></Button>
      </header>
      <div className={css.inspectorBody}>{props.renderModuleSettings?.(settingsModule.id, activeSettings.layer, create.openToolsForModule)}</div>
    </aside>}
    </div>
    {create.dialogs}
    {discard && <ConfirmDialog title={t('triggers.discard')} description={t('triggers.discardHint')} confirmLabel={t('triggers.discard')} cancelLabel={t('triggers.cancel')} onCancel={() => setDiscard(undefined)} onConfirm={() => { owners.find(owner => owner.moduleId === discard)?.editor.discard(); setDiscard(undefined) }} />}
  </section></CanvasChoiceContext.Provider>
}
