import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { RuleDefinition } from '../../../shared/rules.ts'
import type { RuleAction } from '../../../shared/rules.ts'
import { MODULE_CAPABILITIES, isModuleCapabilityDeclared } from '../../../shared/engine-capabilities.ts'
import type { ModuleConfigOrderEntry } from '../../../shared/module-config-order.ts'
import { configIdentityKey } from '../../../shared/module-config-order.ts'
import type { DraftsPort, InstructionFilesPort, ModuleActionsPort, ModuleFactsPort, NoticePort, RuleEditingPort } from '../../data/store-ports.ts'
import { usePromptToolFields } from '../../data/use-prompt-tool-fields.ts'
import { useModuleRuleEditors, type ModuleRuleEditor } from '../../data/use-rule-editor.ts'
import { BLANK_MODULE_TEMPLATE, canEditModule, moduleDeclares, writableModuleTargets } from '../../data/module-subject.ts'
import { useModuleConfigOrder } from '../../data/use-module-config-order.ts'
import { reorderToView, sameConfigPosition } from '../../data/prompt-config-order.ts'
import { hasRuleFields, rulesDirty } from '../../data/rule-drafts.ts'
import { instructionFileIdOf } from '../../data/prompt-config-content.ts'
import type { LayerCardView } from '../../data/layer-cards.ts'
import type { PromptConfigDraft } from '../../prompt-tool-types.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { SearchInput } from '../../ui/SearchInput.tsx'
import { Button } from '../../ui/Button.tsx'
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { PromptConfigCard } from './PromptConfigCard.tsx'
import { LAYER_LABEL_KEYS, translateLabel } from './prompt-config-policy.ts'
import { asTriggerRecord } from './RuleJsonField.tsx'
import { RuleCard } from './RuleCard.tsx'
import { useTemplateCreate } from './useTemplatePicker.tsx'
import { TemplateTargetPicker } from '../../ui/TemplatePicker.tsx'
import type { ModuleCreateItem } from '../modules/EngineModuleList.tsx'
import ui from '../../ui/controls.module.css'
import css from './rules.module.css'

export interface RulesWorkspaceProps {
  store: ModuleFactsPort & DraftsPort & RuleEditingPort & InstructionFilesPort & NoticePort & ModuleActionsPort
  t: PromptToolTranslate; scope?: 'main' | 'subagent'
  browse?: { filter: string; expanded?: string }
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

function hasContextActivation(actions: RuleAction[]): boolean {
  return actions.some(action => asTriggerRecord(action.config).strategy === 'context-activation'
    || Array.isArray(action.then) && hasContextActivation(action.then as RuleAction[])
    || Array.isArray(action.else) && hasContextActivation(action.else as RuleAction[]))
}
function scopeVisible(rule: RuleDefinition, scope: 'main' | 'subagent'): boolean {
  const possible = (value: unknown): boolean => {
    const condition = asTriggerRecord(value), selection = asTriggerRecord(condition.scope)
    if (condition.scope !== undefined) return selection.audience == null || selection.audience === 'all' || selection.audience === scope
    if (Array.isArray(condition.all)) return condition.all.every(possible)
    if (Array.isArray(condition.any)) return condition.any.some(possible)
    return true
  }
  if (!possible(rule.if)) return false
  return rule.then.length === 0 || rule.then.some(action => {
    const audience = action.kind === 'inject-text' ? asTriggerRecord(action.config).audience : action.audience
    return audience == null || audience === 'all' || audience === scope
  })
}

/** 两个受众页共用各模块规则草稿；排序只写身份，指令文件只走原文件通道。
 *  **没有「当前模块」**：每张规则卡的主语是它自己所属的模块（`owners` 的 moduleId）。 */
export function RulesWorkspace(props: RulesWorkspaceProps): ReactNode {
  const { store, t } = props, fields = usePromptToolFields(store, value => value)
  const [expanded, setExpanded] = useState<string | undefined>(props.browse?.expanded)
  const [filter, setFilter] = useState(props.browse?.filter ?? '')
  // 卡片准入的第一优先级是存储根 config.yml 的启用表：未启用的模块不建编辑器、不读 rules/*.yml。
  // 排序快照与任何会话级目标都不参与准入（没有「当前编辑目标」）。
  const enabledModules = (store.meta.modules ?? []).filter(module => module.enabled === true)
  const ownerIds = enabledModules.filter(module => moduleDeclares(store.meta.modules, module.id, 'rules') !== false).map(module => module.id)
  // 排序请求生命周期归 useModuleConfigOrder（全仓唯一一份实现）；页面只提供「保存成功后要刷新哪些编辑器」。
  const ownersRef = useRef<ModuleRuleEditor[]>([])
  const order = useModuleConfigOrder(t, async () => (await Promise.all(ownersRef.current.map(owner => owner.editor.load(true)))).every(Boolean))
  const owners = useModuleRuleEditors(store, ownerIds)
  ownersRef.current = owners
  const revisions = JSON.stringify(owners.map(owner => [owner.moduleId, owner.draft.revisions?.settings]))
  const [discard, setDiscard] = useState<string>()
  const dragId = useRef<string>()
  /** 拖拽落点：身份键 + 指针是否落在卡片上半区（半高判据，恢复 41ce6b36 的原始设计）。 */
  const [dropTarget, setDropTarget] = useState<{ id: string; before: boolean }>()
  // 逐模块可编辑判据：判据来源是该模块自己的事实（/meta 的 modules[].facts）。
  const readOnly = (id: string): boolean => !canEditModule(fields, store.meta.modules, id)
  const sortDisabled = order.busy || owners.some(owner => owner.draft.busy !== undefined || rulesDirty(owner.draft) || owner.draft.remote !== undefined)
  const query = (props.keyword ?? filter).trim().toLowerCase(), view = props.viewFilter ?? 'all'
  const changeFilter = (value: string): void => { setFilter(value); props.onKeywordChange?.(value); if (props.browse) props.browse.filter = value }
  const toggle = (key: string): void => { const next = expanded === key ? undefined : key; setExpanded(next); if (props.browse) props.browse.expanded = next }
  useEffect(() => { order.reset(); setExpanded(props.browse?.expanded) }, [ownerIds.join('\u0000'), order.reset])
  useEffect(() => { void order.load() }, [revisions, store.meta.modules, order.load])
  /**
   * 把源卡移到目标卡前/后：判据（`sameConfigPosition`）与重排（`reorderToView`）都在 data 层，
   * 这里只算可移动集合、调一次保存。跨插入点与跨官方档位的目标不在集合里，重排原样返回。
   */
  const saveOrder = async (sourceId: string, targetId: string, before: boolean): Promise<void> => {
    const cards = order.configs
    if (order.busy || sortDisabled || order.snapshot === undefined || sourceId === targetId) return
    const source = cards.find(card => card.id === sourceId), target = cards.find(card => card.id === targetId)
    if (source === undefined || target === undefined || !sameConfigPosition(source, target)) return
    const movableIds = cards.filter(card => sameConfigPosition(card, source)).map(card => card.id)
    const next = reorderToView(cards, sourceId, targetId, before, movableIds)
    if (next === cards) return
    await order.save(next)
  }
  const rank = new Map(order.snapshot?.entries.map(entry => [configIdentityKey(entry), entry.sequence]) ?? [])
  const entries = owners.flatMap(owner => owner.draft.entries.map(entry => ({ ...owner, entry,
    key: configIdentityKey({ moduleId: owner.moduleId, configId: entry.key }),
    identity: configIdentityKey({ moduleId: owner.moduleId, configId: entry.previousId ?? entry.value.id }),
  }))).filter(({ entry, key }) => !entry.deleted && (expanded === key || scopeVisible(entry.value, props.scope ?? 'main')))
    .filter(({ entry, moduleId: id, key }) => expanded === key || (view === 'all' || view === 'context-activation' && hasContextActivation([...entry.value.then, ...entry.value.else ?? []]) || entry.value.layer === view)
      && (!query || JSON.stringify(entry.value).toLowerCase().includes(query) || entry.value.layer !== undefined && props.layerCards?.(entry.value.layer, id)?.some((card) => card.searchText.includes(query))))
    .sort((a, b) => (rank.get(a.identity) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.identity) ?? Number.MAX_SAFE_INTEGER))
  const moduleSettings = enabledModules.flatMap(module => {
    const owner = owners.find(item => item.moduleId === module.id)
    if (moduleDeclares(store.meta.modules, module.id, 'rules') !== false && (!owner?.draft.loaded || owner.draft.error)) return []
    const layers = new Set((owner?.draft.entries ?? []).filter(entry => !entry.deleted && scopeVisible(entry.value, props.scope ?? 'main'))
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
  const batchDisabled = entries.length === 0 || entries.some(({ moduleId: id, draft }) => readOnly(id) || !draft.loaded || draft.busy !== undefined || hasRuleFields(draft) || draft.remote !== undefined)
  const batchSetEnabled = (enabled: boolean): void => {
    if (batchDisabled) return
    for (const { entry, editor } of entries) {
      if ((entry.value.enabled !== false) !== enabled) editor.patch(entry.key, { ...entry.value, enabled })
    }
    for (const editor of new Set(entries.map(row => row.editor))) void editor.submit()
  }
  const orderPeers = (entry: ModuleConfigOrderEntry): ModuleConfigOrderEntry[] => {
    const visible = order.snapshot?.entries.filter(item => entries.some(row => row.identity === configIdentityKey(item))) ?? []
    return visible.filter(item => sameConfigPosition(entry, item))
  }
  /** 独占官方档位的卡（system-section／runtime-context 每个档位只有一张）没有可交换的 peer：
   *  跨档位先后由宿主装配顺序决定（引擎按 order 分组注册官方段），这里只说明原因，不假装能排。 */
  const slotPinned = (entry: ModuleConfigOrderEntry): boolean =>
    (entry.layer === 'system-section' || entry.layer === 'runtime-context') && orderPeers(entry).length <= 1
  const moveButtons = (entry: ModuleConfigOrderEntry): ReactNode => {
    const peers = orderPeers(entry), index = peers.findIndex(item => configIdentityKey(item) === configIdentityKey(entry))
    const pinned = slotPinned(entry)
    return <span className={css.row}>
      {[-1, 1].map(delta => <HintTooltip key={delta} label={pinned ? t('rules.orderPinnedHint') : t(delta < 0 ? 'rules.moveUp' : 'rules.moveDown', { id: entry.configId })}>
        <Button variant="outline" shape="pill" icon aria-label={t(delta < 0 ? 'rules.moveUp' : 'rules.moveDown', { id: entry.configId })}
          disabled={sortDisabled || !!query || peers[index + delta] === undefined}
          onClick={() => { const target = peers[index + delta]; if (target) void saveOrder(configIdentityKey(entry), configIdentityKey(target), delta < 0) }}>{delta < 0 ? '↑' : '↓'}</Button>
      </HintTooltip>)}
    </span>
  }
  const duplicate = ({ moduleId, draft, editor }: ModuleRuleEditor, rule: RuleDefinition): void => {
    let id = rule.id + '-copy', suffix = 2
    while (draft.entries.some(entry => !entry.deleted && entry.value.id === id)) id = rule.id + '-copy-' + suffix++
    const clone = structuredClone(rule)
    clone.then = clone.then.map(action => { if (action.kind !== 'inject-text') return action; const { id: _sourceId, ...config } = asTriggerRecord(action.config); return { ...action, config } })
    setExpanded(configIdentityKey({ moduleId, configId: editor.add({ ...clone, id, enabled: false }) }))
  }
  // 页级创建编排（T18 唯一入口）：下拉 → 模板浮层 → 只加一步选目标 → 写入所选模块。
  // 主语来自目标选择，不存在「当前模块」；写入只落在该目标模块自己已读回的草稿上。
  // 候选＝**只列可写用户模块**（启用状态与总闸不参与目标判据）；写入前还会再判一次。
  const create = useTemplateCreate({
    store,
    t,
    items: props.createItems ?? [],
    scope: props.scope ?? 'main',
    targets: writableModuleTargets(store.meta.modules).sort((a, b) => a.id.localeCompare(b.id)),
    existingIds: (store.meta.modules ?? []).map(module => module.id),
    onCreated: (moduleId, configKey) => setExpanded(configIdentityKey({ moduleId, configId: configKey })),
  })
  // 指令文件卡是全局段（不属于任何模块）：设置区的主语由装配层按每个启用模块给出（参数按模块存储）。
  const instructionCards = fields.promptConfigs.filter(config => instructionFileIdOf(config) !== undefined).map(config => <PromptConfigCard key={config.id} t={t} meta={store.meta} config={config} expanded={expanded === config.id} canMoveUp={false} canMoveDown={false}
    renderLayerSettings={props.renderInstructionSettings === undefined ? undefined : (_layer, card) => props.renderInstructionSettings!(card)}
    onToggleExpanded={() => toggle(config.id)} onToggleEnabled={() => {}} onPatch={(_id, patch) => { const fileId = instructionFileIdOf(config); if (fileId !== undefined && typeof patch.text === 'string') store.patchInstructionText(fileId, patch.text) }}
    onMoveUp={() => {}} onMoveDown={() => {}} onDuplicate={() => {}} onDelete={() => {}}
    onSaveInstructionFile={id => { void store.persistInstructionFiles([id]) }} onReloadInstructionFile={id => store.reloadInstructionFile(id).then(() => {})}
    onPatchInstructionPolicy={store.instructionPolicy.error === undefined ? (id, override) => { void store.updateInstructionPolicy(id, override) } : undefined} />)
  return <section className={css.workspace} aria-label={t('rules.list')}>
    <div className={ui.listFilterRow} data-module-toolbar>
      <SearchInput inline aria-label={t('rules.search')} placeholder={t('rules.search')} value={props.keyword ?? filter} onChange={event => changeFilter(event.target.value)} />
      <MenuSelect compact className={css.control} ariaLabel={t('rules.layerFilter')} value={view} options={[{ value: 'all', label: t('rules.all') }, { value: 'context-activation', label: t('rules.worldBook') }, ...store.meta.layers.map(layer => ({ value: layer, label: translateLabel(t, LAYER_LABEL_KEYS, layer) }))]} onChange={value => props.onViewFilterChange?.(value)} />
      {create.toolbar}
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
    {props.createdHidden && <Button variant="outline" shape="pill" onClick={props.onShowCreated}>{t('rules.showCreated')}</Button>}
    {instructionCards}
    {props.beforeCards}
    {moduleSettings.map(item => <div key={`module-settings-${props.scope ?? 'main'}-${item.moduleId}`} className={css.workspace} data-module-settings={item.moduleId}>{props.renderModuleSettings!(item.moduleId, item.layers)}</div>)}
    {entries.map(row => {
        const { entry, draft, editor, moduleId: id, key } = row
        const orderEntry = order.snapshot?.entries.find(item => configIdentityKey(item) === row.identity)
        const dropId = orderEntry === undefined ? undefined : configIdentityKey(orderEntry)
        const dropping = dropId !== undefined && dropTarget?.id === dropId ? dropTarget.before : undefined
        return <div key={key} data-module-id={id}
          data-dragging={dropId !== undefined && dragId.current === dropId ? '' : undefined}
          data-drop-before={dropping === true ? '' : undefined} data-drop-after={dropping === false ? '' : undefined}
          onDragOver={event => {
            event.preventDefault()
            if (dropId === undefined) return
            const rect = event.currentTarget.getBoundingClientRect()
            setDropTarget({ id: dropId, before: event.clientY < rect.top + rect.height / 2 })
          }}
          onDragLeave={() => setDropTarget(current => current?.id === dropId ? undefined : current)}
          onDrop={event => {
            event.preventDefault()
            const source = dragId.current
            dragId.current = undefined
            setDropTarget(undefined)
            if (source === undefined || dropId === undefined) return
            // 落点在 drop 时重算：不依赖 onDragOver 那次 setState 的异步生效。
            const rect = event.currentTarget.getBoundingClientRect()
            void saveOrder(source, dropId, event.clientY < rect.top + rect.height / 2)
          }}>
          <RuleCard t={t} entry={entry} draft={draft} editor={editor} meta={store.meta} source={id} moduleId={id} disabled={readOnly(id)} expanded={expanded === key} onToggle={() => toggle(key)} onDuplicate={() => duplicate(row, entry.value)}
            expandedRows={store.editorDrafts.expanded}
            headerActions={orderEntry && <><HintTooltip label={slotPinned(orderEntry) ? t('rules.orderPinnedHint') : t('card.dragHint')}><button type="button" className={ui.dragHandle} disabled={sortDisabled || !!query} draggable={!sortDisabled && !query} aria-label={t('card.dragHint')} aria-keyshortcuts="ArrowUp ArrowDown"
              onDragStart={event => { dragId.current = configIdentityKey(orderEntry); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', dragId.current) }} onDragEnd={() => { dragId.current = undefined }}
              onKeyDown={event => { if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return; event.preventDefault(); const peers = orderPeers(orderEntry), index = peers.findIndex(item => configIdentityKey(item) === configIdentityKey(orderEntry)); const target = peers[index + (event.key === 'ArrowUp' ? -1 : 1)]; if (target) void saveOrder(configIdentityKey(orderEntry), configIdentityKey(target), event.key === 'ArrowUp') }}>⋮⋮</button></HintTooltip>{moveButtons(orderEntry)}</>}
            renderSettings={entry.value.layer !== undefined && props.hasLayerSettings?.(entry.value.layer, id) && props.renderLayerSettings ? (rule, module) => props.renderLayerSettings!(rule.layer!, { id: rule.id, layer: rule.layer }, module, create.openToolsForModule) : undefined} />
        </div>
      })}
    {entries.length === 0 && moduleSettings.length === 0 && (query !== '' || view !== 'all') && owners.every(owner => owner.draft.loaded) && <p>{t('rules.noMatch')}</p>}
    {discard && <ConfirmDialog title={t('triggers.discard')} description={t('triggers.discardHint')} confirmLabel={t('triggers.discard')} cancelLabel={t('triggers.cancel')} onCancel={() => setDiscard(undefined)} onConfirm={() => { owners.find(owner => owner.moduleId === discard)?.editor.discard(); setDiscard(undefined) }} />}
  </section>
}
