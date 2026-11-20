import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
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
import { ruleFacts, type RuleFacts } from '../../data/rule-facts.ts'
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
import { useAnchoredPopoverStyle } from '../../ui/anchored-popover.ts'
import { useDismissOnOutsidePointer } from '../../ui/outside-pointer.ts'
import { errorMessage } from '../../data/bridge-client.ts'
import type { ModuleActionResult } from '../../data/module-actions.ts'
import { IconChevronDownOutlineRegular, IconFolderOpenOutlineRegular } from '../../ui/icons.tsx'
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

type ModuleSummary = NonNullable<ModuleFactsPort['meta']['modules']>[number]

function ModuleScopePicker({ value, modules, editingModule, open, setOpen, onChange, onEnable, enableDisabled, feedback, t }: {
  value: string; modules: readonly ModuleSummary[]; editingModule?: string; open: boolean; setOpen: (open: boolean) => void
  onChange: (value: string) => void; onEnable: (id: string, enabled: boolean) => void
  enableDisabled: (module: ModuleSummary) => boolean; feedback: ReactNode; t: PromptToolTranslate
}): ReactNode {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const native = typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype
  const anchored = native && CSS.supports('position-area: block-end span-inline-end')
  const position = useAnchoredPopoverStyle({ open: open && !anchored, anchorRef: trigger, panelRef: panel })
  useDismissOnOutsidePointer(trigger, open && !native, setOpen, panel)
  useLayoutEffect(() => {
    const element = panel.current
    if (!native || !element) return
    const sync = () => setOpen(element.matches(':popover-open'))
    element.addEventListener('toggle', sync)
    return () => element.removeEventListener('toggle', sync)
  }, [native, setOpen])
  useLayoutEffect(() => {
    if (open) panel.current?.querySelector('input')?.focus()
    else setQuery('')
  }, [open])
  const close = (): void => {
    if (native) panel.current?.hidePopover()
    else setOpen(false)
    trigger.current?.focus({ preventScroll: true })
  }
  const needle = query.trim().toLowerCase()
  const scopes = [
    { value: 'active', label: t('rules.participatingModules') },
    { value: 'all', label: t('rules.allModules') },
  ]
  const matched = !open ? [] : needle ? modules.filter(module => `${module.name ?? ''} ${module.id}`.toLowerCase().includes(needle)) : modules
  const currentModule = modules.find(module => `module:${module.id}` === value)
  const current = (currentModule?.name || currentModule?.id) ?? scopes.find(scope => scope.value === value)?.label
  const choose = (next: string): void => {
    if (value !== next) onChange(next)
    close()
  }
  return <>
    <button ref={trigger} className={css.modulePicker} type="button" aria-controls={id} aria-expanded={open}
      aria-label={`${t('rules.browseScope')} · ${current ?? ''}${!open && feedback ? ` · ${t('rules.moduleFeedback')}` : ''}`}
      {...(native ? { popovertarget: id } : { onClick: () => setOpen(!open) })}>
      <IconFolderOpenOutlineRegular /><strong>{current}</strong>
      {!open && feedback && <span className={css.modulePickerIndicator} aria-hidden="true">!</span>}
      <IconChevronDownOutlineRegular />
    </button>
    <div ref={panel} id={id} className={css.modulePickerPanel} {...(native ? { popover: 'auto' } : { hidden: !open })}
      data-position-fallback={!anchored || undefined} style={anchored ? undefined : position ?? undefined} onKeyDown={event => {
        if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
        event.stopPropagation()
        event.preventDefault()
        close()
      }}>
      <SearchInput aria-label={t('rules.moduleSearch')} placeholder={t('rules.moduleSearch')} value={query}
        onChange={event => setQuery(event.currentTarget.value)} onKeyDown={event => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing || !needle) return
          const exactId = matched.find(module => module.id.toLowerCase() === needle)
          const target = exactId ?? (matched.length === 1 ? matched[0] : undefined)
          if (!target) return
          event.preventDefault()
          choose(`module:${target.id}`)
        }} />
      {open && feedback}
      {open && <div className={css.modulePickerItems}>
        {!needle && <div className={css.modulePickerGroup}>
          <h3>{t('rules.browseScope')}</h3>
          {scopes.map(scope => <button key={scope.value} className={css.modulePickerChoice} type="button"
            aria-current={value === scope.value || undefined} onClick={() => choose(scope.value)}>
            <span><strong>{scope.label}</strong></span>
          </button>)}
        </div>}
        {matched.length > 0 && <div className={css.modulePickerGroup}>
          <h3>{t('rules.installedModules')}</h3>
          {matched.map(module => {
            const name = module.name || module.id
            const option = `module:${module.id}`
            const enabled = module.enabled === true
            return <div key={module.id} className={css.modulePickerRow} data-enabled={enabled}>
              <button className={css.modulePickerChoice} type="button" aria-current={value === option || undefined}
                onClick={() => choose(option)}>
                <span><strong>{name}</strong>{module.id !== name && <small>{module.id}</small>}
                  {editingModule === module.id && <small className={css.modulePickerEditing}>{t('rules.editingModule')}</small>}
                </span>
              </button>
              <small className={css.modulePickerState}>{t(enabled ? 'moduleSwitcher.enabled' : 'rules.moduleDisabled')}</small>
              <Switch checked={enabled} disabled={enableDisabled(module)} label={t('rules.moduleSwitchLabel', { name })}
                onChange={next => onEnable(module.id, next)} />
            </div>
          })}
        </div>}
        {needle && matched.length === 0 && <p role="status">{t('rules.noMatch')}</p>}
      </div>}
    </div>
  </>
}

export interface RulesWorkspaceProps {
  store: ModuleFactsPort & DraftsPort & RuleEditingPort & InstructionFilesPort & NoticePort & ModuleActionsPort
  t: PromptToolTranslate
  browse?: { filter: string; expanded?: string; allModules?: boolean; moduleFilter?: string; rulesScroll?: number; ruleNodes?: Map<string, string>; ruleCanvas?: Map<string, { scale: number; x: number; y: number; positions: Record<string, { x: number; y: number }> }>; combination?: boolean; diagnosticTarget?: RuleDiagnosticTarget; publish?: () => void }
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

  const [localExpanded, setExpanded] = useState<string | undefined>(props.browse?.expanded)
  const [listOpen, setListOpen] = useState(false)
  const listPaneId = useId()
  const listToggle = useRef<HTMLButtonElement>(null)
  const [libraryOpen, setLibraryOpen] = useState(true)
  const libraryId = useId()
  const libraryToggle = useRef<HTMLButtonElement>(null)
  const [localAllModules, setAllModules] = useState(props.browse?.allModules ?? false)
  const [modulePickerOpen, setModulePickerOpen] = useState(false)
  const [localModuleFilter, setModuleFilter] = useState(props.browse?.moduleFilter)
  const [localCombination, setCombination] = useState(props.browse?.combination ?? false)
  const expanded = props.browse?.publish ? props.browse.expanded : localExpanded
  const allModules = props.browse?.publish ? props.browse.allModules === true : localAllModules
  const combination = props.browse?.publish ? props.browse.combination === true : localCombination
  const [modulePending, setModulePending] = useState<string | null>()
  const moduleWrite = useRef(false)
  const [enablePublication, setEnablePublication] = useState<{ pending: boolean; error?: string }>()
  const [enableError, setEnableError] = useState<string>()
  const [enableRefreshFailed, setEnableRefreshFailed] = useState(false)
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
  const order = useModuleConfigOrder(t, async () => (await Promise.all(ownersRef.current.map(owner => owner.editor.load(true)))).every(Boolean))
  const owners = useModuleRuleEditors(store, ownerIds)
  const diagnosticOwner = owners.find(owner => owner.moduleId === diagnosticTarget?.moduleId)
  const diagnosticEntry = diagnosticOwner?.draft.entries.find(entry => !entry.deleted && (entry.previousId ?? entry.value.id) === diagnosticTarget?.ruleId)
  const diagnosticKey = diagnosticEntry && diagnosticOwner && configIdentityKey({ moduleId: diagnosticOwner.moduleId, configId: diagnosticEntry.key })
  const handledDiagnostic = useRef<RuleDiagnosticTarget>()
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
  const entries = owners.flatMap(owner => (owner.moduleId === pinnedModule
    ? owner.draft.entries.filter(entry => entry.key === editingKey)
    : owner.draft.entries).map(entry => ({ ...owner, entry,
    key: configIdentityKey({ moduleId: owner.moduleId, configId: entry.key }),
    identity: configIdentityKey({ moduleId: owner.moduleId, configId: entry.previousId ?? entry.value.id }),
    facts: factsFor(entry.value),
  }))).filter(({ entry }) => !entry.deleted)
    .filter(({ entry, moduleId: id, key, facts }) => expanded === key || diagnosticKey === key || (view === 'all' || view === 'context-activation' && facts.contextActivation || entry.value.layer === view)
      && (!query || id.toLowerCase().includes(query) || searchableRule(entry.value).includes(query) || entry.value.layer !== undefined && props.layerCards?.(entry.value.layer, id)?.some((card) => card.searchText.includes(query))))
    .sort((a, b) => (orderByIdentity.get(a.identity)?.sequence ?? Number.MAX_SAFE_INTEGER) - (orderByIdentity.get(b.identity)?.sequence ?? Number.MAX_SAFE_INTEGER))
  const moduleSettings = enabledModules.flatMap(module => {
    if (moduleFilter && module.id !== moduleFilter) return []
    const owner = owners.find(item => item.moduleId === module.id)
    if (moduleDeclares(store.meta.modules, module.id, 'rules') !== false && (!owner?.draft.loaded || owner.draft.error)) return []
    const layers = new Set((owner?.draft.entries ?? []).filter(entry => !entry.deleted)
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
  const batchEntries = pinnedModule === undefined ? entries : entries.filter(row => row.moduleId !== pinnedModule)
  const batchOwners = new Set(batchEntries.map(row => row.editor))
  const batchDisabled = batchEntries.length === 0 || owners.some(({ moduleId: id, draft, editor }) => batchOwners.has(editor)
    && (readOnly(id) || !draft.loaded || draft.busy !== undefined || hasRuleFields(draft) || draft.remote !== undefined))
  const batchSetEnabled = (enabled: boolean): void => {
    if (batchDisabled) return
    for (const { entry, editor } of batchEntries) {
      if ((entry.value.enabled !== false) !== enabled) editor.patch(entry.key, { ...entry.value, enabled })
    }
    props.onRuleEdit?.()
    for (const editor of batchOwners) void editor.submit()
  }
  const visibleIdentities = new Set(batchEntries.map(row => row.identity))
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
  // 指令文件卡是全局段（不属于任何模块）：设置区的主语由装配层按每个启用模块给出（参数按模块存储）。
  const instructionCards = fields.instructionCards.map(config => <PromptConfigCard key={config.id} t={t} meta={store.meta} config={config} expanded={expanded === config.id} canMoveUp={false} canMoveDown={false}
    renderLayerSettings={props.renderInstructionSettings === undefined ? undefined : (_layer, card) => props.renderInstructionSettings!(card)}
    onToggleExpanded={() => toggle(config.id)} onToggleEnabled={() => {}} onPatch={(_id, patch) => { const fileId = instructionFileIdOf(config); if (fileId !== undefined && typeof patch.text === 'string') store.patchInstructionText(fileId, patch.text) }}
    onMoveUp={() => {}} onMoveDown={() => {}} onDuplicate={() => {}} onDelete={() => {}}
    onSaveInstructionFile={id => { void store.persistInstructionFiles([id]) }} onReloadInstructionFile={id => store.reloadInstructionFile(id).then(() => {})}
    onPatchInstructionPolicy={store.instructionPolicy.error === undefined ? (id, override) => { void store.updateInstructionPolicy(id, override) } : undefined} />)
  const selected = entries.find(row => row.key === expanded)
  useEffect(() => {
    if (expanded === undefined && !combination && entries[0]) select(entries[0].key)
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
      if (expanded !== diagnosticKey) select(diagnosticKey)
      else {
        handledDiagnostic.current = diagnosticTarget
        if (diagnosticTarget.actionId === undefined) focus.current = 'detail'
      }
    }
    if (list.current?.getClientRects().length && !scrollRestored.current && entries.length > 0) {
      list.current.scrollTop = props.browse?.rulesScroll ?? 0
      scrollRestored.current = true
    }
    if (focus.current === 'detail' && detailHeading.current) {
      detailHeading.current.focus({ preventScroll: true })
      focus.current = undefined
    } else if (focus.current === 'list') {
      (lastButton.current?.isConnected && lastButton.current.getClientRects().length ? lastButton.current : workspaceHeading.current)?.focus({ preventScroll: true })
      focus.current = undefined
    }
  })
  const changeCombination = (next: boolean): void => {
    if (props.browse) { props.browse.combination = next; if (next) props.browse.moduleFilter = undefined; props.browse.publish?.() }
    if (!props.browse?.publish) setCombination(next)
    if (next) setModuleFilter(undefined)
    if (next) setListOpen(true)
  }
  const changeModuleScope = (value: string): void => {
    const nextModule = value.startsWith('module:') ? value.slice('module:'.length) : undefined
    const nextAll = value !== 'active'
    const leavesRule = selected !== undefined && (nextModule !== undefined ? selected.moduleId !== nextModule : !nextAll && !enabledIds.has(selected.moduleId))
    if (leavesRule) saveSelected.current?.()
    if (props.browse) {
      props.browse.moduleFilter = nextModule
      props.browse.allModules = nextAll
      props.browse.combination = false
    }
    if (!props.browse?.publish) {
      setModuleFilter(nextModule)
      setAllModules(nextAll)
      setCombination(false)
    }
    if (leavesRule) select(undefined)
    else props.browse?.publish?.()
  }
  const showList = listOpen || combination
  const openList = (): void => {
    saveSelected.current?.()
    lastButton.current = selectedButton.current
    focus.current = 'list'
    setListOpen(true)
  }
  const closeList = (): void => {
    if (combination) changeCombination(false)
    setListOpen(false)
    listToggle.current?.focus({ preventScroll: true })
  }
  const enableDisabled = (module: ModuleSummary): boolean =>
    modulePending !== undefined || order.busy || enableRefreshFailed || module.broken !== undefined || module.renderable === false
  const writeEnable = async (id: string | null, run?: () => Promise<ModuleActionResult<unknown>>): Promise<void> => {
    if (moduleWrite.current || order.busy) return
    const action = document.activeElement
    const actionPanel = action?.closest(`.${css.modulePickerPanel}`)
    moduleWrite.current = true
    setModulePending(id)
    setEnableError(undefined)
    const reportFailure = (reason: string): void => {
      if (run === undefined) setEnableError(t('rules.moduleListRefreshFailed'))
      else if (id === null) setEnablePublication({ pending: true, error: reason })
      else setEnableError(t('moduleSwitcher.notice.enableFailed', { reason }))
    }
    try {
      if (run === undefined) {
        const refreshed = await store.moduleActions.refresh()
        setEnableRefreshFailed(!refreshed)
        if (!refreshed) reportFailure('')
        return
      }
      const result = await run()
      if (result.ok) {
        setEnablePublication(result.publication)
        setEnableRefreshFailed(result.refreshError !== undefined)
        if (result.refreshError !== undefined) setEnableError(t('rules.moduleListRefreshFailed'))
      } else reportFailure(result.message ?? result.code ?? t('workspace.retry'))
    } catch (error) {
      reportFailure(errorMessage(error))
    } finally {
      moduleWrite.current = false
      setModulePending(undefined)
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
  const setModuleEnabled = (id: string, enabled: boolean): void => {
    const module = modules.find(item => item.id === id)
    if (!module || enableDisabled(module) || (module.enabled === true) === enabled) return
    void writeEnable(id, () => store.moduleActions.enable(id, enabled))
  }
  const enableFeedback = (modulePending !== undefined || enableError !== undefined || enablePublication?.pending === true) && <div className={css.modulePickerFeedback}>
    {modulePending !== undefined && <p role="status">{t('rules.moduleChanging')}</p>}
    {enableError && <p role="alert" className={css.error}>{enableError}</p>}
    {enableRefreshFailed && enablePublication?.pending !== true &&
      <Button variant="outline" shape="pill" size="sm" disabled={modulePending !== undefined || order.busy}
        onClick={() => { void writeEnable(null) }}>{t('rules.refreshModules')}</Button>}
    <PublicationNotice publication={enablePublication} pendingLabel={t('publication.pending')} retryLabel={t('publication.retry')}
      disabled={modulePending !== undefined || order.busy}
      onRetry={() => { void writeEnable(null, store.moduleActions.retryEnable) }} />
  </div>
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
    <div className={css.ruleWorkspace} data-rule-open={selected !== undefined || undefined} data-list-open={showList || undefined} data-canvas-workspace>
    <div className={css.moduleScope}>
      <ModuleScopePicker t={t} value={moduleFilter ? `module:${moduleFilter}` : allModules ? 'all' : 'active'} onChange={changeModuleScope}
        modules={modules} editingModule={selected?.moduleId} onEnable={setModuleEnabled} enableDisabled={enableDisabled}
        open={modulePickerOpen} setOpen={setModulePickerOpen} feedback={enableFeedback} />
      <Button ref={listToggle} shape="pill" variant="outline" aria-controls={listPaneId} aria-expanded={showList} onClick={showList ? closeList : openList}>
        <span className={css.disclosureMarker} aria-hidden="true" />{t('rules.list')}
      </Button>
      <Button ref={libraryToggle} className={css.libraryToggle} variant="outline" disabled={!selected?.draft.meta}
        aria-label={t(libraryOpen ? 'rules.hideLibrary' : 'rules.showLibrary')}
        title={t(libraryOpen ? 'rules.hideLibrary' : 'rules.showLibrary')}
        aria-controls={selected?.draft.meta ? libraryId : undefined} aria-expanded={Boolean(selected?.draft.meta && libraryOpen)}
        onClick={() => setLibraryOpen(!libraryOpen)}>
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2" /><path d="M6 3v10m2.5-7h3.5m-3.5 3h3.5" /></svg>
      </Button>
    </div>
    <div id={listPaneId} className={css.ruleListPane} hidden={!showList} onKeyDown={event => {
      if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.defaultPrevented) return
      event.stopPropagation()
      closeList()
    }}>
    <div className={css.row}>
      <h2 ref={workspaceHeading} tabIndex={-1} className={css.workspaceHeading}>{t('rules.list')}</h2>
      <Button shape="pill" variant="outline" aria-pressed={combination} onClick={() => changeCombination(!combination)}>{t('rules.combination')}</Button>
    </div>
    <div className={ui.listFilterRow} data-module-toolbar>
      <SearchInput inline aria-label={t('rules.search')} placeholder={t('rules.search')} value={props.keyword ?? filter} onChange={event => changeFilter(event.target.value)} />
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
      {!modulePickerOpen && enableFeedback}
      <fieldset className={css.moduleParticipation}><legend>{t('rules.participatingModules')}</legend>
        {modules.map(module => <div key={module.id} className={css.row}>
          <span>{module.name || module.id}</span>
          <Switch label={t('rules.moduleSwitchLabel', { name: module.name || module.id })} checked={module.enabled === true}
            disabled={enableDisabled(module)} onChange={enabled => setModuleEnabled(module.id, enabled)} />
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
          <details className={css.ruleDisclosure}>
            <summary><span>{entry.value.name || entry.value.id}</span></summary>
            <small>{id} · {entry.value.id} · {entry.value.layer === undefined ? t('rules.module') : translateLabel(t, LAYER_LABEL_KEYS, entry.value.layer)}
              {!enabledIds.has(id) ? ' · ' + t('rules.moduleInactive') : entry.value.enabled === false ? ' · ' + t('rules.identity.disabled') : ''}
              {combination && orderEntry && ' · ' + t('rules.combinationSequence', { sequence: orderEntry.sequence })}</small>
          </details>
          <button type="button" title={entry.value.name || entry.value.id} aria-label={t('rules.editNamed', { name: entry.value.name || entry.value.id })} className={css.ruleChoice} ref={selected?.key === key ? selectedButton : undefined} aria-current={selected?.key === key || undefined}
            onClick={event => {
              if (key !== expanded) saveSelected.current?.()
              if (combination) changeCombination(false)
              lastButton.current = event.currentTarget
              focus.current = 'detail'
              select(key)
              setListOpen(false)
            }}>
            <span aria-hidden="true">↗</span>
          </button>
          {combination && id !== pinnedModule && orderEntry && moveButtons(orderEntry)}
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
    {entries.length === 0 && moduleSettings.length === 0 && owners.every(owner => owner.draft.loaded) && <p>{t('rules.noMatch')}</p>}
    {!combination && <>{instructionCards}
    {props.beforeCards}
    {moduleSettings.map(item => <div key={`module-settings-${item.moduleId}`} className={css.workspace} data-module-settings={item.moduleId}>{props.renderModuleSettings!(item.moduleId, item.layers)}</div>)}</>}
    </div>
    {!selected && <div className={css.emptyCanvas}><h2>{t('rules.structure')}</h2><p>{t('rules.chooseNode')}</p></div>}
    {selected && <div className={css.ruleDetail}>
      <h2 ref={detailHeading} tabIndex={-1} className={css.canvasAccessibleHeading}>{selected.moduleId} / {selected.entry.value.id}</h2>
      <RuleCard key={selected.key} t={t} entry={selected.entry} draft={selected.draft} editor={selected.editor} meta={store.meta} source={selected.moduleId} moduleId={selected.moduleId} disabled={readOnly(selected.moduleId)}
        moduleName={modules.find(module => module.id === selected.moduleId)?.name || selected.moduleId} moduleEnabled={enabledIds.has(selected.moduleId)} modulesEnabled={fields.modulesEnabled}
        expanded onDuplicate={() => duplicate(selected, selected.entry.value)} leaveSave={saveSelected} nodeBrowse={nodeBrowse} canvasBrowse={props.browse?.ruleCanvas} onBrowseChange={props.browse?.publish}
        libraryOpen={libraryOpen} libraryId={libraryId} onCloseLibrary={restoreFocus => {
          setLibraryOpen(false)
          if (restoreFocus) libraryToggle.current?.focus({ preventScroll: true })
        }}
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
