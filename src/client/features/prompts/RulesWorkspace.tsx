import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { RuleDefinition } from '../../../shared/rules.ts'
import type { ModuleConfigOrderEntry, ModuleConfigOrderSnapshot } from '../../../shared/module-config-order.ts'
import { configIdentityKey } from '../../../shared/module-config-order.ts'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import { usePromptToolFields } from '../../data/use-prompt-tool-fields.ts'
import { useRuleEditor } from '../../data/use-rule-editor.ts'
import { useModuleConfigOrder } from '../../data/use-module-config-order.ts'
import { groupOtherModuleCards } from '../../data/prompt-config-order.ts'
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

/** 两个受众页共用同一规则草稿；排序只写身份，指令文件只走原文件通道。 */
export function RulesWorkspace(props: RulesWorkspaceProps): ReactNode {
  const { store, t } = props, fields = usePromptToolFields(store, value => value)
  const { moduleId, draft, editor } = useRuleEditor(store)
  // 跨模块只读视图：无参 /module-config-order 读的是**运行时装配的**配置卡
  // （服务端 readInputs 默认 ids = enabledModuleIds()，即 config.yml 的 enabled）。
  // 这里只用来展示其它模块的卡并提供切换入口，正文与编辑永远留在当前模块的 draft。
  const others = useModuleConfigOrder(t)
  useEffect(() => {
    if (draft.loaded) void others.load()
    // others.load 是稳定 useCallback；此处只随当前模块与草稿就绪变化重读。
  }, [draft.loaded, moduleId, others.load]) // eslint-disable-line react-hooks/exhaustive-deps
  const [expanded, setExpanded] = useState<string | undefined>(props.browse?.expanded)
  const [filter, setFilter] = useState(props.browse?.filter ?? '')
  const [order, setOrder] = useState<ModuleConfigOrderSnapshot>()
  const [sorting, setSorting] = useState(false), [orderError, setOrderError] = useState(''), [discard, setDiscard] = useState(false)
  const dragId = useRef<string>(), epoch = useRef(0), sortBusy = useRef(false), lastCreated = useRef<string>()
  const readOnly = !fields.modulesEnabled || store.moduleFacts?.editable !== true
  const query = (props.keyword ?? filter).trim().toLowerCase(), view = props.viewFilter ?? 'all'
  const changeFilter = (value: string): void => { setFilter(value); props.onKeywordChange?.(value); if (props.browse) props.browse.filter = value }
  const toggle = (key: string): void => { const next = expanded === key ? undefined : key; setExpanded(next); if (props.browse) props.browse.expanded = next }
  const readOrder = useCallback(async (): Promise<void> => {
    const generation = epoch.current
    const result = await bridgeCall('moduleConfigOrder', { moduleId })
    if (generation !== epoch.current) return
    if (result.ok) { setOrder(result.value); setOrderError('') }
    else setOrderError(result.message ?? t('moduleOrder.unavailable'))
  }, [moduleId, t])
  useEffect(() => { epoch.current++; setOrder(undefined); setExpanded(props.browse?.expanded); return () => { epoch.current++ } }, [moduleId])
  useEffect(() => { if (draft.loaded) void readOrder() }, [draft.loaded, draft.revisions?.settings, readOrder])
  useEffect(() => {
    if (props.createdConfigId === lastCreated.current) return
    const created = draft.entries.find(entry => entry.value.id === props.createdConfigId && !entry.deleted)
    if (created) { lastCreated.current = props.createdConfigId; setExpanded(created.key) }
  }, [props.createdConfigId, draft.entries])
  const saveOrder = async (sourceId: string, targetId: string): Promise<void> => {
    if (sortBusy.current || order === undefined || rulesDirty(draft) || sourceId === targetId) return
    const from = order.entries.findIndex(item => configIdentityKey(item) === sourceId), to = order.entries.findIndex(item => configIdentityKey(item) === targetId)
    if (from < 0 || to < 0 || !samePosition(order.entries[from]!, order.entries[to]!)) return
    const entries = [...order.entries]
    ;[entries[from], entries[to]] = [entries[to]!, entries[from]!]
    const generation = epoch.current
    sortBusy.current = true; setSorting(true)
    try {
      const result = await bridgeCall('moduleConfigOrder', { moduleId, expectedRevision: order.revision, entries: entries.map(({ moduleId, configId }) => ({ moduleId, configId })) })
      if (generation !== epoch.current) return
      if (!result.ok) { setOrderError(result.message ?? t('moduleOrder.unavailable')); return }
      setOrder(result.value); setOrderError(''); await editor.load(true)
    } finally { sortBusy.current = false; if (generation === epoch.current) setSorting(false) }
  }
  const rank = new Map(order?.entries.filter(entry => entry.moduleId === moduleId).map(entry => [entry.configId, entry.sequence]) ?? [])
  const entries = draft.entries.filter(entry => !entry.deleted && scopeVisible(entry.value, props.scope ?? 'main'))
    .filter(entry => (view === 'all' || view === 'world-book' && entry.value.then.some(action => asTriggerRecord(action.config).strategy === 'world-book') || entry.value.layer === view)
      && (!query || JSON.stringify(entry.value).toLowerCase().includes(query) || entry.value.layer !== undefined && props.matchesLayerSettings?.(entry.value.layer, query)))
    .sort((a, b) => (rank.get(a.previousId ?? a.value.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.previousId ?? b.value.id) ?? Number.MAX_SAFE_INTEGER))
  const batchDisabled = readOnly || !draft.loaded || draft.busy !== undefined || hasRuleFields(draft) || draft.remote !== undefined || entries.length === 0
  // 其它已启用模块的卡：按模块分组，只读展示 + 点击切换编辑目标。
  // 分组判据是 entry.moduleId（分组函数里做），排序/批量启用都不涉及它们。
  const otherModuleCards = useMemo(
    () => groupOtherModuleCards(
      others.snapshot?.entries,
      moduleId,
      (id) => store.meta.modules?.find((item) => item.id === id)?.name,
    ),
    [others.snapshot, moduleId, store.meta.modules],
  )
  const retrySave = draft.loaded && rulesDirty(draft) && draft.remote === undefined
  const batchSetEnabled = (enabled: boolean): void => {
    if (batchDisabled) return
    for (const entry of entries) {
      if ((entry.value.enabled !== false) !== enabled) editor.patch(entry.key, { ...entry.value, enabled })
    }
    void editor.submit()
  }
  const orderPeers = (entry: ModuleConfigOrderEntry): ModuleConfigOrderEntry[] => {
    const visible = order?.entries.filter(item => item.moduleId === moduleId && entries.some(row => (row.previousId ?? row.value.id) === item.configId)) ?? []
    return visible.filter(item => samePosition(entry, item))
  }
  const moveButtons = (entry: ModuleConfigOrderEntry): ReactNode => {
    const peers = orderPeers(entry), index = peers.findIndex(item => configIdentityKey(item) === configIdentityKey(entry))
    return <span className={css.row}>
      {[-1, 1].map(delta => <Button key={delta} variant="outline" shape="pill" icon aria-label={t(delta < 0 ? 'rules.moveUp' : 'rules.moveDown', { id: entry.configId })}
        disabled={sorting || !!query || rulesDirty(draft) || peers[index + delta] === undefined}
        onClick={() => { const target = peers[index + delta]; if (target) void saveOrder(configIdentityKey(entry), configIdentityKey(target)) }}>{delta < 0 ? '↑' : '↓'}</Button>)}
    </span>
  }
  const duplicate = (rule: RuleDefinition): void => {
    let id = rule.id + '-copy', suffix = 2
    while (draft.entries.some(entry => !entry.deleted && entry.value.id === id)) id = rule.id + '-copy-' + suffix++
    const clone = structuredClone(rule)
    clone.then = clone.then.map(action => { if (action.kind !== 'inject-text') return action; const { id: _sourceId, ...config } = asTriggerRecord(action.config); return { ...action, config } })
    setExpanded(editor.add({ ...clone, id, enabled: false }))
  }
  const instructionCards = fields.promptConfigs.filter(config => instructionFileIdOf(config) !== undefined).map(config => <PromptConfigCard key={config.id} t={t} meta={store.meta} config={config} expanded={expanded === config.id} canMoveUp={false} canMoveDown={false}
    onToggleExpanded={() => toggle(config.id)} onToggleEnabled={() => {}} onPatch={(id, patch) => store.patch({ promptConfigs: store.getFields().promptConfigs.map(item => item.id === id ? { ...item, ...patch } : item) })}
    onMoveUp={() => {}} onMoveDown={() => {}} onDuplicate={() => {}} onDelete={() => {}}
    onSaveInstructionFile={id => { void store.persistInstructionFiles([id]) }} onReloadInstructionFile={id => store.reloadInstructionFile(id).then(() => {})}
    onPatchInstructionPolicy={store.instructionPolicy.error === undefined ? (id, override) => { void store.updateInstructionPolicy(id, override) } : undefined} />)
  return <section className={css.workspace} aria-label={t('rules.list')}>
    <div className={ui.listFilterRow} data-module-toolbar>
      <SearchInput inline aria-label={t('rules.search')} placeholder={t('rules.search')} value={props.keyword ?? filter} onChange={event => changeFilter(event.target.value)} />
      <MenuSelect compact className={css.control} ariaLabel={t('rules.layer')} value={view} options={[{ value: 'all', label: t('rules.all') }, { value: 'world-book', label: t('rules.worldBook') }, ...store.meta.layers.map(layer => ({ value: layer, label: translateLabel(t, LAYER_LABEL_KEYS, layer) }))]} onChange={value => props.onViewFilterChange?.(value)} />
      {props.toolbarActions}
      <span className={ui.batchControls}>
        <Button shape="pill" variant="outline" data-batch="enable" disabled={batchDisabled} onClick={() => batchSetEnabled(true)}>{t('configs.batch.enableVisible')}</Button>
        <Button shape="pill" variant="outline" data-danger data-batch="disable" disabled={batchDisabled} onClick={() => batchSetEnabled(false)}>{t('configs.batch.disableVisible')}</Button>
      </span>
    </div>
    {draft.error && <div className={css.row}>
      <p role="alert" className={css.error}>{draft.remote ? t('rules.conflict') : draft.error}</p>
      <Button variant="outline" shape="pill" disabled={draft.busy !== undefined} onClick={() => { void (draft.publicationPending ? editor.retryPublication() : retrySave ? editor.submit() : editor.load(true)) }}>{t(!draft.publicationPending && retrySave ? 'rules.retrySave' : 'workspace.retry')}</Button>
      {(rulesDirty(draft) || draft.remote) && <Button variant="outline" shape="pill" disabled={draft.busy !== undefined} onClick={() => setDiscard(true)}>{t('triggers.discard')}</Button>}
    </div>}
    {hasRuleFields(draft) && <p role="alert" className={css.error}>{t('rules.fieldsPending')}</p>}
    {orderError && <p role="alert" className={css.error}>{orderError}</p>}
    {props.createdHidden && <Button variant="outline" shape="pill" onClick={props.onShowCreated}>{t('rules.showCreated')}</Button>}
    {props.scope !== 'subagent' && instructionCards}
    {props.beforeCards}
    {entries.map(entry => {
        const orderEntry = order?.entries.find(item => item.moduleId === moduleId && item.configId === (entry.previousId ?? entry.value.id))
        return <div key={entry.key} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (orderEntry && dragId.current) void saveOrder(dragId.current, configIdentityKey(orderEntry)); dragId.current = undefined }}>
          <RuleCard t={t} entry={entry} draft={draft} editor={editor} meta={store.meta} disabled={readOnly} expanded={expanded === entry.key} onToggle={() => toggle(entry.key)} onDuplicate={() => duplicate(entry.value)}
            headerActions={orderEntry && <><button type="button" className={ui.dragHandle} disabled={sorting || !!query || rulesDirty(draft)} draggable={!sorting && !query && !rulesDirty(draft)} aria-label={t('card.dragHint')} aria-keyshortcuts="ArrowUp ArrowDown"
              onDragStart={event => { dragId.current = configIdentityKey(orderEntry); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', dragId.current) }} onDragEnd={() => { dragId.current = undefined }}
              onKeyDown={event => { if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return; event.preventDefault(); const peers = orderPeers(orderEntry), index = peers.findIndex(item => configIdentityKey(item) === configIdentityKey(orderEntry)); const target = peers[index + (event.key === 'ArrowUp' ? -1 : 1)]; if (target) void saveOrder(configIdentityKey(orderEntry), configIdentityKey(target)) }}>⋮⋮</button>{moveButtons(orderEntry)}</>}
            renderSettings={entry.value.layer !== undefined && props.hasLayerSettings?.(entry.value.layer) && props.renderLayerSettings ? rule => props.renderLayerSettings!(rule.layer!, { id: rule.id, layer: rule.layer }) : undefined} />
        </div>
      })}
    {entries.length === 0 && draft.loaded && <p>{t(query || view !== 'all' ? 'rules.noMatch' : 'rules.empty')}</p>}
    {/* 其它已启用模块：只读展示 + 一键切过去编辑。刻意不渲染 RuleCard 与任何编辑控件——
        「看着能改、点了没反应」比不显示更糟；编辑入口就是右上那个切换。 */}
    {otherModuleCards.length > 0 && <section className={css.workspace} aria-label={t('rules.otherModules')}>
      <h3 className={ui.sectionTitle}>{t('rules.otherModules')}</h3>
      <p className={ui.configFieldHint}>{t('rules.otherModules.hint')}</p>
      {otherModuleCards.map((group) => <div key={group.moduleId}>
        <div className={ui.listFilterRow}>
          <strong>{group.name}</strong>
          <code>{group.moduleId}</code>
          <Button variant="outline" shape="pill" onClick={() => store.setModuleId(group.moduleId)}>{t('rules.switchToModule', { id: group.moduleId })}</Button>
        </div>
        <ul>
          {group.entries.map((item) => <li key={configIdentityKey(item)}>
            <span data-enabled={item.enabled === true ? '' : undefined}>{item.name}</span>
            {' · '}{translateLabel(t, LAYER_LABEL_KEYS, item.layer)}
            {item.enabled !== true && ` · ${t('rules.disabled')}`}
          </li>)}
        </ul>
      </div>)}
    </section>}
    {others.error !== '' && <p role="alert" className={css.error}>{others.error}</p>}
    {discard && <ConfirmDialog title={t('triggers.discard')} description={t('triggers.discardHint')} confirmLabel={t('triggers.discard')} cancelLabel={t('triggers.cancel')} onCancel={() => setDiscard(false)} onConfirm={editor.discard} />}
  </section>
}
