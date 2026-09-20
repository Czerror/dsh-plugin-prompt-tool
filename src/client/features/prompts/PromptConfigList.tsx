import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { scrollToCreatedCard, cssEscapeId } from '../../ui/reveal-card.ts'
import { bridgeCall, errorMessage } from '../../data/bridge-client.ts'
import { instructionFileIdOf } from '../../data/prompt-config-content.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { ToggleRow } from '../../ui/ToggleRow.tsx'
import { PromptConfigCard } from './PromptConfigCard.tsx'
import { moveToView, moveWithinLayer, promptConfigLayer, viewOrderedIds } from './prompt-config-order.ts'
import { displayLayers, LAYER_LABEL_KEYS, translateLabel } from './prompt-config-policy.ts'
import type { EngineMeta, PromptConfigDraft, ValidationErrorEntry } from '../../prompt-tool-types.ts'
import type { InstructionPolicyFileOverride, InstructionPolicySnapshot } from '../../../shared/instructions.ts'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './prompts.module.css'

const styles = { ...sharedCss, ...featureCss }

export interface PromptConfigListProps {
  t: PromptToolTranslate
  meta: EngineMeta
  configs: PromptConfigDraft[]
  browse?: { filter: string; expanded?: string; feedback?: { kind: 'ok' | 'error'; message: string } }
  fieldDrafts?: ComponentProps<typeof PromptConfigCard>['fieldDrafts']
  draftScope?: string
  commonCards?: ReactNode
  notice?: string
  noticeKind?: 'ok' | 'error'
  readOnlyReason?: string
  onCreate?: () => void
  onChoosePreset?: () => void
  createdHidden?: boolean
  onShowCreated?: () => void
  /** 传入 layer 时只展示该层配置；不传展示全部配置。 */
  layer?: string
  /** 传入 scope 时按 audience 作用域过滤：main = 非仅子代理（主会话可见）；subagent = 非仅主会话（子代理可见；缺省公用两边都可见）。 */
  scope?: 'main' | 'subagent'
  /** 列表工具栏追加操作（如「新建模板」）。 */
  extraActions?: ReactNode
  /** 列表头部之后、配置卡片之前渲染的固定卡片（如模板变量——归类于配置列表下）。 */
  beforeCards?: ReactNode
  /** 模块卡（引擎能力、自定义工具）：视觉上排在层级配置卡之前；世界书视图不渲染。 */
  moduleCards?: ReactNode
  /** 工具栏中的非提示词配置操作（如能力创建）。 */
  toolbarActions?: ReactNode
  /** 受控层筛选（全部/世界书/层级）；未传时内部 state 兜底（子代理页等独立实例）。 */
  viewFilter?: string
  onViewFilterChange?: (value: string) => void
  /** 只响应明确的创建动作；后台读取已有配置不抢占筛选或展开状态。 */
  createdConfigId?: string
  /** 空状态追加提示（如「当前预设模板该层无配置」）。 */
  emptyHint?: string
  onPatchConfigs: (configs: PromptConfigDraft[]) => void
  onSaveConfigs: (configs: PromptConfigDraft[]) => Promise<boolean>
  onSaveInstructions?: () => Promise<boolean>
  instructionPolicy?: InstructionPolicySnapshot
  onToggleInstructionSource?: (enabled: boolean) => Promise<boolean>
  /** 指令文件卡：显式写盘与重新读取（不经预设保存路径）。 */
  onSaveInstructionFile?: (fileId: string) => void
  onReloadInstructionFile?: (fileId: string) => void
  /** 指令文件卡的行为策略改动（独立策略存储）。 */
  onPatchInstructionPolicy?: (fileId: string, override: InstructionPolicyFileOverride) => void
  onNotice: (kind: 'ok' | 'error', message: string) => void
}

/** 共享的提示词配置列表：校验、保存、脏检测、复制、删除、层内移动。 */
export function PromptConfigList(props: PromptConfigListProps): ReactNode {
  const { t, meta, configs, layer, scope, extraActions, beforeCards, moduleCards, toolbarActions, viewFilter: viewFilterProp, onViewFilterChange, emptyHint, onPatchConfigs, onSaveConfigs, onSaveInstructionFile, onReloadInstructionFile, onPatchInstructionPolicy, onNotice } = props
  const [expanded, setExpanded] = useState<string | undefined>(props.browse?.expanded)
  const [errors, setErrors] = useState<ValidationErrorEntry[]>([])
  const [validating, setValidating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savingSource, setSavingSource] = useState(false)
  const [filter, setFilter] = useState(props.browse?.filter ?? '')
  const changeFilter = (value: string): void => {
    if (props.browse !== undefined) props.browse.filter = value
    setFilter(value)
  }
  const [createdId, setCreatedId] = useState<string>()
  const busyRef = useRef(false)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; message: string } | undefined>(props.browse?.feedback)
  const lastNotice = useRef(props.notice)
  const report = (kind: 'ok' | 'error', message: string): void => {
    setFeedback({ kind, message })
    onNotice(kind, message)
  }
  useEffect(() => {
    if (props.notice && props.notice !== lastNotice.current) setFeedback({ kind: props.noticeKind ?? 'ok', message: props.notice })
    lastNotice.current = props.notice
  }, [props.notice, props.noticeKind])
  useEffect(() => {
    if (props.browse !== undefined) props.browse.feedback = feedback
  }, [feedback, props.browse])
  useEffect(() => {
    if (props.browse !== undefined) props.browse.expanded = expanded
  }, [expanded, props.browse])
  useEffect(() => {
    if (expanded !== undefined && !configs.some((config) => config.id === expanded)) setExpanded(undefined)
  }, [configs, expanded])
  /** 拖拽排序状态：源卡片 id + 落点（目标 id + 前/后）。 */
  const [dragId, setDragId] = useState<string | undefined>(undefined)
  const [dropTarget, setDropTarget] = useState<{ id: string; before: boolean } | undefined>(undefined)
  /** 过滤下拉：全部 / 世界书（策略）/ 各注入层级。外部 layer prop 传入时固定该层。 */
  const [innerViewFilter, setInnerViewFilter] = useState<string>('all')
  const viewFilter = viewFilterProp ?? innerViewFilter
  const changeViewFilter = (value: string): void => {
    if (onViewFilterChange !== undefined) onViewFilterChange(value)
    else setInnerViewFilter(value)
  }
  useEffect(() => {
    const created = configs.find((config) => config.id === props.createdConfigId)
    if (created === undefined) return
    setCreatedId(created.id)
    // 只展开并定位新建的卡：不改动用户的层级筛选与搜索词。
    setExpanded(created.id)
    return scrollToCreatedCard(`[data-config-id="${cssEscapeId(created.id)}"]`)
  }, [props.createdConfigId])

  const effectiveLayer = layer ?? (viewFilter !== 'all' && viewFilter !== 'world-book' ? viewFilter : undefined)
  const allLayers = displayLayers(meta.layerOrder, [...meta.layers, ...configs.map(promptConfigLayer)])
  const visible = effectiveLayer === undefined
    ? configs
    : configs.filter((config) => promptConfigLayer(config) === effectiveLayer)
  const scoped = scope === undefined
    ? visible
    : visible.filter((config) => {
      const mode = config.audience
      return scope === 'main' ? mode !== 'subagent' : mode !== 'main'
    })
  const byStrategy = viewFilter !== 'world-book'
    ? scoped
    : scoped.filter((config) => config.strategy === 'world-book')
  const keyword = filter.trim().toLowerCase()
  const filtered = keyword.length === 0
    ? byStrategy
    : byStrategy.filter((config) =>
      [config.id, config.name ?? '', config.strategy ?? ''].join(' ').toLowerCase().includes(keyword))
  // 插入点分组只用于阅读；order 仅在同一插入点内比较。
  const layerRank = (config: PromptConfigDraft): number => {
    const index = allLayers.indexOf(promptConfigLayer(config))
    return index < 0 ? allLayers.length : index
  }
  const ordered = filtered
    .map((config, index) => ({ config, index }))
    .sort((a, b) => {
      const byLayer = layerRank(a.config) - layerRank(b.config)
      if (byLayer !== 0) return byLayer
      const byOrder = (a.config.order ?? 0) - (b.config.order ?? 0)
      if (byOrder !== 0) return byOrder
      return a.index - b.index
    })
    .map((entry) => entry.config)
  /** 按过滤后可见配置一次性启用/禁用（批量开关）。 */
  const batchSetEnabled = (enabled: boolean): void => {
    if (props.readOnlyReason !== undefined) return
    const visibleIds = new Set(ordered.map((config) => config.id))
    onPatchConfigs(configs.map((config) => visibleIds.has(config.id) ? { ...config, enabled } : config))
  }

  const runValidate = async (target: PromptConfigDraft[], announceSuccess = true): Promise<boolean> => {
    setValidating(true)
    try {
      const res = await bridgeCall('configsValidate', { promptConfigs: target })
      if (!res.ok) {
        report('error', t('configs.notice.validateFailed', { reason: res.message ?? 'settings bridge unavailable' }))
        return false
      }
      setErrors(res.value.valid ? [] : res.value.errors ?? [])
      if (!res.value.valid || announceSuccess) report(res.value.valid ? 'ok' : 'error', res.value.valid ? t('configs.notice.valid') : t('configs.notice.validateFailed', { reason: (res.value.errors ?? []).map((error) => error.message).join('；') }))
      return res.value.valid
    } catch (error) {
      report('error', t('configs.notice.validateFailed', { reason: errorMessage(error) }))
      return false
    } finally {
      setValidating(false)
    }
  }

  const save = async (): Promise<boolean> => {
    if (busyRef.current || (props.readOnlyReason !== undefined && props.onSaveInstructions === undefined)) return false
    busyRef.current = true
    setSaving(true)
    try {
      if (props.readOnlyReason !== undefined) {
        const saved = await props.onSaveInstructions!()
        report(saved ? 'ok' : 'error', t(saved ? 'configs.notice.savedSnapshot' : 'configs.notice.saveIncomplete'))
        return saved
      }
      if (!await runValidate(configs, false)) return false
      setErrors([])
      const saved = await onSaveConfigs(configs)
      if (saved) report('ok', t('configs.notice.savedSnapshot'))
      else setFeedback({ kind: 'error', message: t('configs.notice.saveIncomplete') })
      return saved
    } catch (error) {
      report('error', t('configs.notice.saveFailed', { reason: errorMessage(error) }))
      return false
    } finally {
      setSaving(false)
      busyRef.current = false
    }
  }

  // 显示顺序（层序/order/声明序）一次计算：position map 供每张卡判断上移/下移，
  // 此前每张卡各自调 viewOrderedIds（O(n log n) × n）。
  // 世界书筛选视图：移动/排序只作用于可见子集（strategy=world-book），
  // 避免与不可见配置交换顺序。
  const viewStrategy = viewFilter === 'world-book' ? 'world-book' : undefined
  const viewIds = useMemo(
    () => viewOrderedIds(configs, effectiveLayer, allLayers, viewStrategy, ordered.map((config) => config.id)),
    [configs, effectiveLayer, allLayers, viewStrategy, ordered],
  )

  /** 卡片稳定回调（memo 生效前提）：经 liveRef 读最新列表状态，回调引用跨渲染不变。 */
  const liveRef = useRef({ configs, layer: effectiveLayer, metaLayers: allLayers, strategy: viewStrategy, dragId, dropTarget, viewIds, keyword, readOnly: props.readOnlyReason !== undefined })
  liveRef.current = { configs, layer: effectiveLayer, metaLayers: allLayers, strategy: viewStrategy, dragId, dropTarget, viewIds, keyword, readOnly: props.readOnlyReason !== undefined }
  const handleToggleExpanded = useCallback((id: string) => {
    setExpanded((current) => current === id ? undefined : id)
  }, [])
  const handleToggleEnabled = useCallback((id: string, enabled: boolean) => {
    const index = liveRef.current.configs.findIndex((item) => item.id === id)
    if (index >= 0) onPatchConfigs(liveRef.current.configs.map((item, at) => at === index ? { ...item, enabled } : item))
  }, [onPatchConfigs])
  const handlePatch = useCallback((id: string, patch: Partial<PromptConfigDraft>) => {
    if (patch.id !== undefined && patch.id !== id) {
      const prefix = `${props.draftScope}:${id}:`
      const previousFields = [...(props.fieldDrafts ?? [])] // Map迭代器会看到新键；改名必须使用旧条目的快照。
      for (const [key, field] of previousFields) if (key.startsWith(prefix)) {
        props.fieldDrafts?.set(`${props.draftScope}:${patch.id}:${key.slice(prefix.length)}`, field)
        props.fieldDrafts?.delete(key)
      }
    }
    const index = liveRef.current.configs.findIndex((item) => item.id === id)
    if (index >= 0) onPatchConfigs(liveRef.current.configs.map((item, at) => at === index ? { ...item, ...patch } : item))
  }, [onPatchConfigs, props.draftScope, props.fieldDrafts])
  const handleMove = useCallback((id: string, delta: -1 | 1) => {
    const { configs: current, layer: currentLayer, metaLayers, strategy, viewIds: ids, keyword: query, readOnly } = liveRef.current
    if (query || readOnly) return
    const index = current.findIndex((item) => item.id === id)
    if (index >= 0) onPatchConfigs(moveWithinLayer(current, index, delta, currentLayer, metaLayers, strategy, ids))
  }, [onPatchConfigs])
  const handleDuplicate = useCallback((id: string) => {
    const current = liveRef.current.configs
    const source = current.find((item) => item.id === id)
    if (source === undefined) return
    let nextId = `${source.id}-copy`
    let suffix = 2
    while (current.some((item) => item.id === nextId)) {
      nextId = `${source.id}-copy${suffix}`
      suffix += 1
    }
    const clone = JSON.parse(JSON.stringify(source)) as PromptConfigDraft
    clone.id = nextId
    onPatchConfigs([...current, clone])
    setExpanded(nextId)
    setCreatedId(nextId)
    onNotice('ok', t('configs.notice.copied'))
  }, [onNotice, onPatchConfigs, t])
  const handleDelete = useCallback((id: string) => {
    const current = liveRef.current.configs
    const ids = liveRef.current.viewIds
    const index = ids.indexOf(id)
    const nextId = ids[index + 1] ?? ids[index - 1]
    const prefix = `${props.draftScope}:${id}:`
    for (const key of props.fieldDrafts?.keys() ?? []) {
      if (key.startsWith(prefix)) props.fieldDrafts?.delete(key)
    }
    onPatchConfigs(current.filter((item) => item.id !== id))
    setExpanded((value) => value === id ? undefined : value)
    onNotice('ok', t('configs.notice.deleted'))
    requestAnimationFrame(() => {
      const target = nextId === undefined ? document.querySelector<HTMLElement>('[data-module-toolbar] button') : document.querySelector<HTMLElement>(`[data-config-id="${cssEscapeId(nextId)}"] button[aria-expanded]`)
      target?.focus()
    })
  }, [onNotice, onPatchConfigs, props.draftScope, props.fieldDrafts, t])
  const handleDragStart = useCallback((id: string, event: React.DragEvent<HTMLElement>) => {
    setDragId(id)
    event.dataTransfer.effectAllowed = 'move'
  }, [])
  const handleDragOver = useCallback((id: string, event: React.DragEvent<HTMLElement>) => {
    event.preventDefault()
    const { dragId: currentDrag } = liveRef.current
    if (currentDrag === undefined || currentDrag === id) return
    const rect = event.currentTarget.getBoundingClientRect()
    setDropTarget({ id, before: event.clientY < rect.top + rect.height / 2 })
  }, [])
  const handleDrop = useCallback((id: string, event: React.DragEvent<HTMLElement>) => {
    event.preventDefault()
    const { configs: current, layer: currentLayer, metaLayers, strategy, dragId: source, dropTarget: target, viewIds: ids, keyword: query, readOnly } = liveRef.current
    if (query || readOnly) return
    if (source !== undefined && target !== undefined && source !== id) {
      onPatchConfigs(moveToView(current, source, target.id, target.before, currentLayer, metaLayers, strategy, ids))
    }
    setDragId(undefined)
    setDropTarget(undefined)
  }, [onPatchConfigs])
  const handleDragEnd = useCallback(() => {
    setDragId(undefined)
    setDropTarget(undefined)
  }, [])
  const handleMoveUp = useCallback((id: string) => handleMove(id, -1), [handleMove])
  const handleMoveDown = useCallback((id: string) => handleMove(id, 1), [handleMove])

  const renderCard = (config: PromptConfigDraft) => {
    const layerIds = ordered.filter((item) => promptConfigLayer(item) === promptConfigLayer(config)).map((item) => item.id)
    const position = layerIds.indexOf(config.id)
    const sorting = keyword.length === 0 && props.readOnlyReason === undefined
    return (
      <PromptConfigCard
        key={config.id}
        t={t}
        meta={meta}
        config={config}
        fieldDrafts={props.fieldDrafts}
        draftScope={props.draftScope}
        disabled={props.readOnlyReason !== undefined && instructionFileIdOf(config) === undefined}
        readOnlyReason={instructionFileIdOf(config) !== undefined ? undefined : props.readOnlyReason}
        expanded={expanded === config.id}
        canMoveUp={sorting && position > 0}
        canMoveDown={sorting && position >= 0 && position < layerIds.length - 1}
        dragging={dragId === config.id}
        dropBefore={dropTarget?.id === config.id && dropTarget.before}
        dropAfter={dropTarget?.id === config.id && !dropTarget.before}
        onToggleExpanded={handleToggleExpanded}
        onToggleEnabled={handleToggleEnabled}
        onPatch={handlePatch}
        onMoveUp={handleMoveUp}
        onMoveDown={handleMoveDown}
        onDuplicate={handleDuplicate}
        onDelete={handleDelete}
        onSaveInstructionFile={onSaveInstructionFile}
        onReloadInstructionFile={onReloadInstructionFile}
        onPatchInstructionPolicy={onPatchInstructionPolicy}
        onDragStart={sorting ? handleDragStart : undefined}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onDragEnd={handleDragEnd}
      />
    )
  }

  const clearFilters = (): void => {
    changeFilter('')
    changeViewFilter('all')
  }
  const hiddenCreated = props.createdHidden === true || (createdId !== undefined && configs.some((config) => config.id === createdId) && !ordered.some((config) => config.id === createdId))
  const filteredView = keyword.length > 0 || viewFilter !== 'all'

  return (
    <section className={styles.section} aria-labelledby="prompt-tool-configs-heading">
      <div className={styles.pageActions} data-workspace-sticky>
        <div className={styles.sectionHeading}>
          <div><h3 id="prompt-tool-configs-heading">{layer === undefined ? t('configs.heading.all') : t('configs.heading.layer')}</h3><p>{t('configs.meta', { total: scoped.length, enabled: scoped.filter((config) => config.enabled !== false).length })}</p></div>
          <div className={styles.sectionActions} data-module-toolbar="true">
            {extraActions}
            {toolbarActions}
            <button type="button" className={styles.pillButton} disabled={validating || saving} onClick={() => void runValidate(configs)}>{validating && <span className={styles.spinner} aria-hidden="true" />}{validating ? t('configs.validating') : t('configs.validate')}</button>
            <button type="button" className={styles.primaryPill} disabled={saving || validating || (props.readOnlyReason !== undefined && props.onSaveInstructions === undefined)} onClick={save}>{saving && <span className={styles.spinner} aria-hidden="true" />}{saving ? t('configs.saving') : t('configs.save')}</button>
          </div>
        </div>
        <div className={styles.listFilterRow}>
          <input type="search" className={styles.listFilter} value={filter}
            aria-label={t('configs.filter.aria')} placeholder={t('configs.filter.placeholder')}
            spellCheck={false} onChange={(event) => changeFilter(event.target.value)} />
          {layer === undefined && <MenuSelect className={styles.listFilter} value={viewFilter} ariaLabel={t('configs.view.aria')}
            options={[
              { value: 'all', label: t('configs.view.all') },
              { value: 'world-book', label: t('configs.view.worldBook'), group: t('configs.view.strategy') },
              ...allLayers.map((item) => ({ value: item, label: t('configs.view.layer', { layer: translateLabel(t, LAYER_LABEL_KEYS, item) }), group: t('configs.view.insertion') })),
            ]} onChange={changeViewFilter} />}
          <span className={styles.batchControls}>
            <button type="button" className={styles.pillButton} disabled={ordered.length === 0 || props.readOnlyReason !== undefined}
              onClick={() => batchSetEnabled(true)}>{t('configs.batch.enableVisible', { count: ordered.length })}</button>
            <button type="button" className={styles.pillButton} disabled={ordered.length === 0 || props.readOnlyReason !== undefined}
              onClick={() => batchSetEnabled(false)}>{t('configs.batch.disableVisible', { count: ordered.length })}</button>
          </span>
        </div>
        <p className={styles.actionHint}>{t('configs.saveScope')}</p>
        {props.readOnlyReason !== undefined && <p className={styles.actionHint}>{props.readOnlyReason} <button type="button" className={styles.pillButton} onClick={props.onChoosePreset}>{t('configs.chooseEditable')}</button></p>}
        {keyword.length > 0 && <p className={styles.actionHint}>{t('configs.searchSorting')}</p>}
        {feedback !== undefined && <p className={feedback.kind === 'error' ? styles.noticeError : styles.actionFeedback} role="status">{feedback.message}</p>}
        {hiddenCreated && <p className={styles.actionHint}>{t('configs.createdHidden')} <button type="button" className={styles.pillButton} onClick={() => {
          clearFilters()
          props.onShowCreated?.()
          if (createdId !== undefined) scrollToCreatedCard(`[data-config-id="${cssEscapeId(createdId)}"]`)
        }}>{t('configs.showAll')}</button></p>}
        {errors.length > 0 && <div className={styles.configErrorBox}>
          {errors.map((error, index) => <div key={`${error.index}-${index}`} className={styles.configErrorLine}>[{error.index}] {error.id || t('configs.error.missingId')}：{error.message}</div>)}
        </div>}
      </div>

      {props.commonCards}
      {props.instructionPolicy !== undefined && props.onToggleInstructionSource !== undefined && (
        <ToggleRow
          id="prompt-tool-instruction-source"
          label={t('instructions.source.label')}
          checked={props.instructionPolicy.policy.enabled}
          disabled={savingSource || props.instructionPolicy.error !== undefined}
          hint={[
            props.instructionPolicy.error !== undefined
              ? t('instructions.source.unavailable', { reason: props.instructionPolicy.error })
              : t(props.instructionPolicy.policy.enabled ? 'instructions.source.enabled' : 'instructions.source.disabled'),
            ...(configs.some((config) => config.contentOwnerConflict === true) ? [t('instructions.source.ownerConflict')] : []),
          ].join('；')}
          onChange={async (enabled) => {
            if (savingSource || props.instructionPolicy?.error !== undefined) return false
            setSavingSource(true)
            try {
              return await props.onToggleInstructionSource!(enabled)
            } catch (error) {
              onNotice('error', t('configs.notice.saveFailed', { reason: errorMessage(error) }))
              return false
            } finally {
              setSavingSource(false)
            }
          }}
        />
      )}
      {/* 配置列表下的置顶固定卡片（人设、模板变量等单例配置，不参与层过滤与搜索）。 */}
      {beforeCards}

      {/* 模块卡（引擎能力、自定义工具）：与层级配置卡同款列表间距（configList），
          这里只定义展示分组，不建立插入点间运行顺序。 */}
      {moduleCards !== undefined && <div className={styles.configList} hidden={viewFilter === 'world-book'}>{moduleCards}</div>}

      {ordered.length === 0 ? filteredView ? (
        <p className={styles.readOnly}>{t('configs.noMatch', { keyword: filter.trim() || translateLabel(t, LAYER_LABEL_KEYS, viewFilter) })} <button type="button" className={styles.pillButton} onClick={clearFilters}>{t('configs.clearFilters')}</button></p>
      ) : (
        <div className={styles.emptyState}><span className={styles.emptyGlyph} aria-hidden="true">⌁</span><div>
          <h3>{scope === 'subagent' ? t('configs.empty.subagent.title') : t('configs.empty.all.title')}</h3>
          <p>{scope === 'subagent' ? t('configs.empty.subagent.desc') : t('configs.empty.all.desc')}</p>
          {emptyHint !== undefined && <p className={styles.readOnly}>{emptyHint}</p>}
          {props.readOnlyReason === undefined && props.onCreate !== undefined && <button type="button" className={styles.pillButton} onClick={props.onCreate}>{t('configs.createFirst')}</button>}
          {props.readOnlyReason !== undefined && props.onChoosePreset !== undefined && <button type="button" className={styles.pillButton} onClick={props.onChoosePreset}>{t('configs.chooseEditable')}</button>}
        </div></div>
      ) : <div className={styles.configList}>{ordered.map((config) => renderCard(config))}</div>}

    </section>
  )
}
