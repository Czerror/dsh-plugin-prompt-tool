import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { RuleDefinition } from '../../../shared/rules.ts'
import type { ModuleConfigOrderEntry, ModuleConfigOrderSnapshot } from '../../../shared/module-config-order.ts'
import { configIdentityKey } from '../../../shared/module-config-order.ts'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import { usePromptToolFields } from '../../data/use-prompt-tool-fields.ts'
import { useModuleRuleEditors, useRuleEditor, type ModuleRuleEditor } from '../../data/use-rule-editor.ts'
import { hasRuleFields, rulesDirty } from '../../data/rule-drafts.ts'
import { bridgeCall } from '../../data/bridge-client.ts'
import { instructionFileIdOf } from '../../data/prompt-config-content.ts'
import type { PromptConfigDraft } from '../../prompt-tool-types.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { SearchInput } from '../../ui/SearchInput.tsx'
import { Button } from '../../ui/Button.tsx'
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx'
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
  const [order, setOrder] = useState<ModuleConfigOrderSnapshot>()
  // 卡片准入的第一优先级是存储根 config.yml 的启用表：未启用的模块不建编辑器、不读 rules/*.yml。
  // 排序快照与当前编辑目标只决定「已启用模块里显示哪些卡」，越过不了这道门。
  const enabledIds = new Set((store.meta.modules ?? []).filter(module => module.enabled === true).map(module => module.id))
  const owners = useModuleRuleEditors(store, [moduleId, ...order?.entries.map(entry => entry.moduleId) ?? []].filter(id => enabledIds.has(id)))
  const revisions = JSON.stringify(owners.map(owner => [owner.moduleId, owner.draft.revisions?.settings]))
  const [sorting, setSorting] = useState(false), [orderError, setOrderError] = useState(''), [discard, setDiscard] = useState<string>()
  const dragId = useRef<string>(), epoch = useRef(0), sortBusy = useRef(false), lastCreated = useRef<string>()
  const readOnly = (id: string): boolean => !fields.modulesEnabled || id === moduleId && store.moduleFacts?.editable !== true
  const sortDisabled = sorting || owners.some(owner => owner.draft.busy !== undefined || rulesDirty(owner.draft) || owner.draft.remote !== undefined)
  const query = (props.keyword ?? filter).trim().toLowerCase(), view = props.viewFilter ?? 'all'
  const changeFilter = (value: string): void => { setFilter(value); props.onKeywordChange?.(value); if (props.browse) props.browse.filter = value }
  const toggle = (key: string): void => { const next = expanded === key ? undefined : key; setExpanded(next); if (props.browse) props.browse.expanded = next }
  const readOrder = useCallback(async (): Promise<void> => {
    const generation = epoch.current
    const result = await bridgeCall('moduleConfigOrder')
    if (generation !== epoch.current) return
    if (result.ok) { setOrder(result.value); setOrderError('') }
    else setOrderError(result.message ?? t('moduleOrder.unavailable'))
  }, [moduleId, t])
  useEffect(() => { epoch.current++; setOrder(undefined); setExpanded(props.browse?.expanded); return () => { epoch.current++ } }, [moduleId])
  useEffect(() => { void readOrder() }, [revisions, store.meta.modules, readOrder])
  useEffect(() => {
    if (props.createdConfigId === lastCreated.current) return
    const created = draft.entries.find(entry => entry.value.id === props.createdConfigId && !entry.deleted)
    if (created) { lastCreated.current = props.createdConfigId; setExpanded(configIdentityKey({ moduleId, configId: created.key })) }
  }, [props.createdConfigId, draft.entries])
  const saveOrder = async (sourceId: string, targetId: string): Promise<void> => {
    if (sortBusy.current || sortDisabled || order === undefined || sourceId === targetId) return
    const from = order.entries.findIndex(item => configIdentityKey(item) === sourceId), to = order.entries.findIndex(item => configIdentityKey(item) === targetId)
    if (from < 0 || to < 0 || !samePosition(order.entries[from]!, order.entries[to]!)) return
    const entries = [...order.entries]
    ;[entries[from], entries[to]] = [entries[to]!, entries[from]!]
    const generation = epoch.current
    sortBusy.current = true; setSorting(true)
    try {
      const result = await bridgeCall('moduleConfigOrder', { expectedRevision: order.revision, entries: entries.map(({ moduleId, configId }) => ({ moduleId, configId })) })
      if (generation !== epoch.current) return
      // 失败后重读：拖拽用的 revision 已过期，不重读会反复 409、要手动刷页；提示文案以重读结果为准。
      if (!result.ok) { await readOrder(); return }
      setOrder(result.value); setOrderError(''); await Promise.all(owners.map(owner => owner.editor.load(true)))
    } finally { sortBusy.current = false; if (generation === epoch.current) setSorting(false) }
  }
  const rank = new Map(order?.entries.map(entry => [configIdentityKey(entry), entry.sequence]) ?? [])
  const entries = owners.flatMap(owner => owner.draft.entries.map(entry => ({ ...owner, entry,
    key: configIdentityKey({ moduleId: owner.moduleId, configId: entry.key }),
    identity: configIdentityKey({ moduleId: owner.moduleId, configId: entry.previousId ?? entry.value.id }),
  }))).filter(({ entry }) => !entry.deleted && scopeVisible(entry.value, props.scope ?? 'main'))
    .filter(({ entry, moduleId: id }) => (view === 'all' || view === 'world-book' && entry.value.then.some(action => asTriggerRecord(action.config).strategy === 'world-book') || entry.value.layer === view)
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
    const visible = order?.entries.filter(item => entries.some(row => row.identity === configIdentityKey(item))) ?? []
    return visible.filter(item => samePosition(entry, item))
  }
  const moveButtons = (entry: ModuleConfigOrderEntry): ReactNode => {
    const peers = orderPeers(entry), index = peers.findIndex(item => configIdentityKey(item) === configIdentityKey(entry))
    return <span className={css.row}>
      {[-1, 1].map(delta => <Button key={delta} variant="outline" shape="pill" icon aria-label={t(delta < 0 ? 'rules.moveUp' : 'rules.moveDown', { id: entry.configId })}
        disabled={sortDisabled || !!query || peers[index + delta] === undefined}
        onClick={() => { const target = peers[index + delta]; if (target) void saveOrder(configIdentityKey(entry), configIdentityKey(target)) }}>{delta < 0 ? '↑' : '↓'}</Button>)}
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
      <MenuSelect compact className={css.control} ariaLabel={t('rules.layerFilter')} value={view} options={[{ value: 'all', label: t('rules.all') }, { value: 'world-book', label: t('rules.worldBook') }, ...store.meta.layers.map(layer => ({ value: layer, label: translateLabel(t, LAYER_LABEL_KEYS, layer) }))]} onChange={value => props.onViewFilterChange?.(value)} />
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
    {orderError && <p role="alert" className={css.error}>{orderError}</p>}
    {props.createdHidden && <Button variant="outline" shape="pill" onClick={props.onShowCreated}>{t('rules.showCreated')}</Button>}
    {instructionCards}
    {props.beforeCards}
    {entries.map(row => {
        const { entry, draft, editor, moduleId: id, key } = row
        const orderEntry = order?.entries.find(item => configIdentityKey(item) === row.identity)
        return <div key={key} data-module-id={id} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (orderEntry && dragId.current) void saveOrder(dragId.current, configIdentityKey(orderEntry)); dragId.current = undefined }}>
          <RuleCard t={t} entry={entry} draft={draft} editor={editor} meta={store.meta} source={id} disabled={readOnly(id)} expanded={expanded === key} onToggle={() => toggle(key)} onDuplicate={() => duplicate(row, entry.value)}
            expandedRows={store.editorDrafts.expanded}
            headerActions={orderEntry && <><button type="button" className={ui.dragHandle} disabled={sortDisabled || !!query} draggable={!sortDisabled && !query} aria-label={t('card.dragHint')} aria-keyshortcuts="ArrowUp ArrowDown"
              onDragStart={event => { dragId.current = configIdentityKey(orderEntry); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', dragId.current) }} onDragEnd={() => { dragId.current = undefined }}
              onKeyDown={event => { if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return; event.preventDefault(); const peers = orderPeers(orderEntry), index = peers.findIndex(item => configIdentityKey(item) === configIdentityKey(orderEntry)); const target = peers[index + (event.key === 'ArrowUp' ? -1 : 1)]; if (target) void saveOrder(configIdentityKey(orderEntry), configIdentityKey(target)) }}>⋮⋮</button>{moveButtons(orderEntry)}</>}
            renderSettings={id === moduleId && entry.value.layer !== undefined && props.hasLayerSettings?.(entry.value.layer) && props.renderLayerSettings ? rule => props.renderLayerSettings!(rule.layer!, { id: rule.id, layer: rule.layer }) : undefined} />
        </div>
      })}
    {entries.length === 0 && (query !== '' || view !== 'all') && owners.every(owner => owner.draft.loaded) && <p>{t('rules.noMatch')}</p>}
    {discard && <ConfirmDialog title={t('triggers.discard')} description={t('triggers.discardHint')} confirmLabel={t('triggers.discard')} cancelLabel={t('triggers.cancel')} onCancel={() => setDiscard(undefined)} onConfirm={() => { owners.find(owner => owner.moduleId === discard)?.editor.discard(); setDiscard(undefined) }} />}
  </section>
}
