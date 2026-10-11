import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { RuleDefinition } from '../../../shared/rules.ts'
import type { RuleAction } from '../../../shared/rules.ts'
import type { ModuleConfigOrderEntry } from '../../../shared/module-config-order.ts'
import { configIdentityKey } from '../../../shared/module-config-order.ts'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import { usePromptToolFields } from '../../data/use-prompt-tool-fields.ts'
import { useModuleRuleEditors, useRuleEditor, type ModuleRuleEditor } from '../../data/use-rule-editor.ts'
import { useModuleConfigOrder } from '../../data/use-module-config-order.ts'
import { hasRuleFields, rulesDirty } from '../../data/rule-drafts.ts'
import { instructionFileIdOf } from '../../data/prompt-config-content.ts'
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
import ui from '../../ui/controls.module.css'
import css from './rules.module.css'

export interface RulesWorkspaceProps {
  store: PromptToolStore; t: PromptToolTranslate; scope?: 'main' | 'subagent'
  browse?: { filter: string; expanded?: string }
  createdHidden?: boolean; onShowCreated?: () => void; createdConfigId?: string
  beforeCards?: ReactNode; toolbarActions?: ReactNode
  viewFilter?: string; onViewFilterChange?: (value: string) => void
  keyword?: string; onKeywordChange?: (value: string) => void
  renderLayerSettings?: (layer: string, config: PromptConfigDraft) => ReactNode
  renderInstructionSettings?: (config: PromptConfigDraft) => ReactNode
  hasLayerSettings?: (layer: string) => boolean
  matchesLayerSettings?: (layer: string, keyword: string) => boolean
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
const samePosition = (a: ModuleConfigOrderEntry, b: ModuleConfigOrderEntry): boolean => a.layer === b.layer && a.position === b.position
  && (!(a.layer === 'system-section' || a.layer === 'runtime-context') || a.order === b.order)

/** 两个受众页共用各模块规则草稿；排序只写身份，指令文件只走原文件通道。 */
export function RulesWorkspace(props: RulesWorkspaceProps): ReactNode {
  const { store, t } = props, fields = usePromptToolFields(store, value => value)
  const { moduleId, draft } = useRuleEditor(store)
  const [expanded, setExpanded] = useState<string | undefined>(props.browse?.expanded)
  const [filter, setFilter] = useState(props.browse?.filter ?? '')
  // 卡片准入的第一优先级是存储根 config.yml 的启用表：未启用的模块不建编辑器、不读 rules/*.yml。
  // 排序快照与当前编辑目标只决定「已启用模块里显示哪些卡」，越过不了这道门。
  const enabledIds = new Set((store.meta.modules ?? []).filter(module => module.enabled === true).map(module => module.id))
  // 排序请求生命周期归 useModuleConfigOrder（全仓唯一一份实现）；页面只提供「保存成功后要刷新哪些编辑器」。
  const ownersRef = useRef<ModuleRuleEditor[]>([])
  const order = useModuleConfigOrder(t, async () => (await Promise.all(ownersRef.current.map(owner => owner.editor.load(true)))).every(Boolean))
  const owners = useModuleRuleEditors(store, [moduleId, ...order.snapshot?.entries.map(entry => entry.moduleId) ?? []].filter(id => enabledIds.has(id)))
  ownersRef.current = owners
  const revisions = JSON.stringify(owners.map(owner => [owner.moduleId, owner.draft.revisions?.settings]))
  const [discard, setDiscard] = useState<string>()
  const dragId = useRef<string>(), lastCreated = useRef<string>()
  const readOnly = (id: string): boolean => !fields.modulesEnabled || id === moduleId && store.moduleFacts?.editable !== true
  const sortDisabled = order.busy || owners.some(owner => owner.draft.busy !== undefined || rulesDirty(owner.draft) || owner.draft.remote !== undefined)
  const query = (props.keyword ?? filter).trim().toLowerCase(), view = props.viewFilter ?? 'all'
  const changeFilter = (value: string): void => { setFilter(value); props.onKeywordChange?.(value); if (props.browse) props.browse.filter = value }
  const toggle = (key: string): void => { const next = expanded === key ? undefined : key; setExpanded(next); if (props.browse) props.browse.expanded = next }
  useEffect(() => { order.reset(); setExpanded(props.browse?.expanded) }, [moduleId, order.reset])
  useEffect(() => { void order.load() }, [revisions, store.meta.modules, order.load])
  useEffect(() => {
    if (props.createdConfigId === lastCreated.current) return
    const created = draft.entries.find(entry => entry.value.id === props.createdConfigId && !entry.deleted)
    if (created) { lastCreated.current = props.createdConfigId; setExpanded(configIdentityKey({ moduleId, configId: created.key })) }
  }, [props.createdConfigId, draft.entries])
  const saveOrder = async (sourceId: string, targetId: string): Promise<void> => {
    const cards = order.configs, entries = order.snapshot?.entries
    if (order.busy || sortDisabled || entries === undefined || sourceId === targetId) return
    const from = cards.findIndex(card => card.id === sourceId), to = cards.findIndex(card => card.id === targetId)
    if (from < 0 || to < 0 || !samePosition(entries[from]!, entries[to]!)) return
    const next = [...cards]
    ;[next[from], next[to]] = [next[to]!, next[from]!]
    await order.save(next)
  }
  const rank = new Map(order.snapshot?.entries.map(entry => [configIdentityKey(entry), entry.sequence]) ?? [])
  const entries = owners.flatMap(owner => owner.draft.entries.map(entry => ({ ...owner, entry,
    key: configIdentityKey({ moduleId: owner.moduleId, configId: entry.key }),
    identity: configIdentityKey({ moduleId: owner.moduleId, configId: entry.previousId ?? entry.value.id }),
  }))).filter(({ entry }) => !entry.deleted && scopeVisible(entry.value, props.scope ?? 'main'))
    .filter(({ entry, moduleId: id }) => (view === 'all' || view === 'context-activation' && hasContextActivation([...entry.value.then, ...entry.value.else ?? []]) || entry.value.layer === view)
      && (!query || JSON.stringify(entry.value).toLowerCase().includes(query) || id === moduleId && entry.value.layer !== undefined && props.matchesLayerSettings?.(entry.value.layer, query)))
    .sort((a, b) => (rank.get(a.identity) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.identity) ?? Number.MAX_SAFE_INTEGER))
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
    return visible.filter(item => samePosition(entry, item))
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
          onClick={() => { const target = peers[index + delta]; if (target) void saveOrder(configIdentityKey(entry), configIdentityKey(target)) }}>{delta < 0 ? '↑' : '↓'}</Button>
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
  const instructionCards = fields.promptConfigs.filter(config => instructionFileIdOf(config) !== undefined).map(config => <PromptConfigCard key={config.id} t={t} meta={store.meta} config={config} expanded={expanded === config.id} canMoveUp={false} canMoveDown={false}
    renderLayerSettings={props.renderInstructionSettings === undefined ? undefined : (_layer, config) => props.renderInstructionSettings!(config)}
    onToggleExpanded={() => toggle(config.id)} onToggleEnabled={() => {}} onPatch={(id, patch) => store.patch({ promptConfigs: store.getFields().promptConfigs.map(item => item.id === id ? { ...item, ...patch } : item) })}
    onMoveUp={() => {}} onMoveDown={() => {}} onDuplicate={() => {}} onDelete={() => {}}
    onSaveInstructionFile={id => { void store.persistInstructionFiles([id]) }} onReloadInstructionFile={id => store.reloadInstructionFile(id).then(() => {})}
    onPatchInstructionPolicy={store.instructionPolicy.error === undefined ? (id, override) => { void store.updateInstructionPolicy(id, override) } : undefined} />)
  return <section className={css.workspace} aria-label={t('rules.list')}>
    <div className={ui.listFilterRow} data-module-toolbar>
      <SearchInput inline aria-label={t('rules.search')} placeholder={t('rules.search')} value={props.keyword ?? filter} onChange={event => changeFilter(event.target.value)} />
      <MenuSelect compact className={css.control} ariaLabel={t('rules.layerFilter')} value={view} options={[{ value: 'all', label: t('rules.all') }, { value: 'context-activation', label: t('rules.worldBook') }, ...store.meta.layers.map(layer => ({ value: layer, label: translateLabel(t, LAYER_LABEL_KEYS, layer) }))]} onChange={value => props.onViewFilterChange?.(value)} />
      {props.toolbarActions}
      <span className={ui.batchControls}>
        <Button shape="pill" variant="outline" data-batch="enable" disabled={batchDisabled} onClick={() => batchSetEnabled(true)}>{t('configs.batch.enableVisible')}</Button>
        <Button shape="pill" variant="outline" data-danger data-batch="disable" disabled={batchDisabled} onClick={() => batchSetEnabled(false)}>{t('configs.batch.disableVisible')}</Button>
      </span>
    </div>
    {owners.map(({ moduleId: id, draft, editor }) => {
      const retrySave = draft.loaded && rulesDirty(draft) && draft.remote === undefined
      return (draft.error || hasRuleFields(draft)) && <div key={id}>
        {draft.error && <div className={css.row}>
          <span>{t('rules.source', { module: id })}</span>
          <p role="alert" className={css.error}>{draft.remote ? t('rules.conflict') : draft.error}</p>
          <Button variant="outline" shape="pill" disabled={draft.busy !== undefined} onClick={() => { void (draft.publicationPending ? editor.retryPublication() : retrySave ? editor.submit() : editor.load(true)) }}>{t(!draft.publicationPending && retrySave ? 'rules.retrySave' : 'workspace.retry')}</Button>
          {(rulesDirty(draft) || draft.remote) && <Button variant="outline" shape="pill" disabled={draft.busy !== undefined} onClick={() => setDiscard(id)}>{t('triggers.discard')}</Button>}
        </div>}
        {hasRuleFields(draft) && <p role="alert" className={css.error}>{t('rules.source', { module: id })} · {t('rules.fieldsPending')}</p>}
      </div>
    })}
    {order.error && <p role="alert" className={css.error}>{order.error}</p>}
    {props.createdHidden && <Button variant="outline" shape="pill" onClick={props.onShowCreated}>{t('rules.showCreated')}</Button>}
    {instructionCards}
    {props.beforeCards}
    {entries.map(row => {
        const { entry, draft, editor, moduleId: id, key } = row
        const orderEntry = order.snapshot?.entries.find(item => configIdentityKey(item) === row.identity)
        return <div key={key} data-module-id={id} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (orderEntry && dragId.current) void saveOrder(dragId.current, configIdentityKey(orderEntry)); dragId.current = undefined }}>
          <RuleCard t={t} entry={entry} draft={draft} editor={editor} meta={store.meta} source={id} disabled={readOnly(id)} expanded={expanded === key} onToggle={() => toggle(key)} onDuplicate={() => duplicate(row, entry.value)}
            expandedRows={store.editorDrafts.expanded}
            headerActions={orderEntry && <><HintTooltip label={slotPinned(orderEntry) ? t('rules.orderPinnedHint') : t('card.dragHint')}><button type="button" className={ui.dragHandle} disabled={sortDisabled || !!query} draggable={!sortDisabled && !query} aria-label={t('card.dragHint')} aria-keyshortcuts="ArrowUp ArrowDown"
              onDragStart={event => { dragId.current = configIdentityKey(orderEntry); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', dragId.current) }} onDragEnd={() => { dragId.current = undefined }}
              onKeyDown={event => { if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return; event.preventDefault(); const peers = orderPeers(orderEntry), index = peers.findIndex(item => configIdentityKey(item) === configIdentityKey(orderEntry)); const target = peers[index + (event.key === 'ArrowUp' ? -1 : 1)]; if (target) void saveOrder(configIdentityKey(orderEntry), configIdentityKey(target)) }}>⋮⋮</button></HintTooltip>{moveButtons(orderEntry)}</>}
            renderSettings={id === moduleId && entry.value.layer !== undefined && props.hasLayerSettings?.(entry.value.layer) && props.renderLayerSettings ? rule => props.renderLayerSettings!(rule.layer!, { id: rule.id, layer: rule.layer }) : undefined} />
        </div>
      })}
    {entries.length === 0 && (query !== '' || view !== 'all') && owners.every(owner => owner.draft.loaded) && <p>{t('rules.noMatch')}</p>}
    {discard && <ConfirmDialog title={t('triggers.discard')} description={t('triggers.discardHint')} confirmLabel={t('triggers.discard')} cancelLabel={t('triggers.cancel')} onCancel={() => setDiscard(undefined)} onConfirm={() => { owners.find(owner => owner.moduleId === discard)?.editor.discard(); setDiscard(undefined) }} />}
  </section>
}
