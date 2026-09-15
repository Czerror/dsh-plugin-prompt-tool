import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { bridgeCall, errorMessage } from '../../data/bridge-client.ts'
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
  const [expanded, setExpanded] = useState<string | undefined>(undefined)
  const [errors, setErrors] = useState<ValidationErrorEntry[]>([])
  const [validating, setValidating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savingSource, setSavingSource] = useState(false)
  const [filter, setFilter] = useState('')
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
    // 只展开新建的卡：不改动用户的层级筛选与搜索词。
    setExpanded(created.id)
  }, [props.createdConfigId])

  const effectiveLayer = layer ?? (viewFilter !== 'all' && viewFilter !== 'world-book' ? viewFilter : undefined)
  const allLayers = displayLayers([...meta.layers, ...configs.map(promptConfigLayer)])
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
  // 显示顺序 = 引擎注入顺序：按（层序, order, 声明序）稳定排序，跨层全量视图
  // 也一致；order 相同时保持数组原序（同值稳定）。
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
    const visibleIds = new Set(ordered.map((config) => config.id))
    onPatchConfigs(configs.map((config) => visibleIds.has(config.id) ? { ...config, enabled } : config))
  }

  const runValidate = async (target: PromptConfigDraft[]): Promise<boolean> => {
    setValidating(true)
    try {
      const res = await bridgeCall('configsValidate', { promptConfigs: target })
      if (!res.ok) {
        onNotice('error', t('configs.notice.validateFailed', { reason: res.message ?? 'settings bridge unavailable' }))
        return false
      }
      setErrors(res.value.valid ? [] : res.value.errors ?? [])
      return res.value.valid
    } catch (error) {
      onNotice('error', t('configs.notice.validateFailed', { reason: errorMessage(error) }))
      return false
    } finally {
      setValidating(false)
    }
  }

  const save = async (): Promise<boolean> => {
    setSaving(true)
    try {
      if (!await runValidate(configs)) return false
      setErrors([])
      const saved = await onSaveConfigs(configs)
      if (saved) onNotice('ok', t('configs.notice.saved', { count: configs.length }))
      return saved
    } catch (error) {
      onNotice('error', t('configs.notice.saveFailed', { reason: errorMessage(error) }))
      return false
    } finally {
      setSaving(false)
    }
  }

  // 显示顺序（层序/order/声明序）一次计算：position map 供每张卡判断上移/下移，
  // 此前每张卡各自调 viewOrderedIds（O(n log n) × n）。
  // 世界书筛选视图：移动/排序只作用于可见子集（strategy=world-book），
  // 避免与不可见配置交换顺序。
  const viewStrategy = viewFilter === 'world-book' ? 'world-book' : undefined
  const viewIds = useMemo(
    () => viewOrderedIds(configs, effectiveLayer, allLayers, viewStrategy),
    [configs, effectiveLayer, allLayers, viewStrategy],
  )
  const positionOf = useMemo(() => new Map(viewIds.map((id, at) => [id, at])), [viewIds])

  /** 卡片稳定回调（memo 生效前提）：经 liveRef 读最新列表状态，回调引用跨渲染不变。 */
  const liveRef = useRef({ configs, layer: effectiveLayer, metaLayers: allLayers, strategy: viewStrategy, dragId, dropTarget })
  liveRef.current = { configs, layer: effectiveLayer, metaLayers: allLayers, strategy: viewStrategy, dragId, dropTarget }
  const handleToggleExpanded = useCallback((id: string) => {
    setExpanded((current) => current === id ? undefined : id)
  }, [])
  const handleToggleEnabled = useCallback((id: string, enabled: boolean) => {
    const index = liveRef.current.configs.findIndex((item) => item.id === id)
    if (index >= 0) onPatchConfigs(liveRef.current.configs.map((item, at) => at === index ? { ...item, enabled } : item))
  }, [onPatchConfigs])
  const handlePatch = useCallback((id: string, patch: Partial<PromptConfigDraft>) => {
    const index = liveRef.current.configs.findIndex((item) => item.id === id)
    if (index >= 0) onPatchConfigs(liveRef.current.configs.map((item, at) => at === index ? { ...item, ...patch } : item))
  }, [onPatchConfigs])
  const handleMove = useCallback((id: string, delta: -1 | 1) => {
    const { configs: current, layer: currentLayer, metaLayers, strategy } = liveRef.current
    const index = current.findIndex((item) => item.id === id)
    if (index >= 0) onPatchConfigs(moveWithinLayer(current, index, delta, currentLayer, metaLayers, strategy))
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
    onNotice('ok', t('configs.notice.copied'))
  }, [onNotice, onPatchConfigs, t])
  const handleDelete = useCallback((id: string) => {
    const current = liveRef.current.configs
    onPatchConfigs(current.filter((item) => item.id !== id))
    setExpanded((value) => value === id ? undefined : value)
    onNotice('ok', t('configs.notice.deleted'))
  }, [onNotice, onPatchConfigs, t])
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
    const { configs: current, layer: currentLayer, metaLayers, strategy, dragId: source, dropTarget: target } = liveRef.current
    if (source !== undefined && target !== undefined && source !== id) {
      onPatchConfigs(moveToView(current, source, target.id, target.before, currentLayer, metaLayers, strategy))
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
    const position = positionOf.get(config.id) ?? -1
    return (
      <PromptConfigCard
        key={config.id}
        t={t}
        meta={meta}
        config={config}
        expanded={expanded === config.id}
        canMoveUp={position > 0}
        canMoveDown={position >= 0 && position < viewIds.length - 1}
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
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onDragEnd={handleDragEnd}
      />
    )
  }

  return (
    <section className={styles.section} aria-labelledby="prompt-tool-configs-heading">
      <div className={styles.sectionHeading}>
      <div><h2 id="prompt-tool-configs-heading">{layer === undefined ? t('configs.heading.all') : t('configs.heading.layer')}</h2><p>{t('configs.meta', { total: scoped.length, enabled: scoped.filter((config) => config.enabled !== false).length })}</p></div>
        <div className={styles.sectionActions} data-module-toolbar="true">
          {extraActions}
          {toolbarActions}
          <button type="button" className={styles.pillButton} disabled={validating} onClick={() => void runValidate(configs)}>{validating && <span className={styles.spinner} aria-hidden="true" />}{validating ? t('configs.validating') : t('configs.validate')}</button>
          <button type="button" className={styles.primaryPill} disabled={saving || validating} onClick={save}>{saving && <span className={styles.spinner} aria-hidden="true" />}{saving ? t('configs.saving') : t('configs.save')}</button>
        </div>
      </div>

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
      <div className={styles.listFilterRow}>
        <input
          className={styles.listFilter}
          value={filter}
          aria-label={t('configs.filter.aria')}
          placeholder={t('configs.filter.placeholder')}
          spellCheck={false}
          onChange={(event) => setFilter(event.target.value)}
        />
        {layer === undefined && (
          <MenuSelect
            className={styles.listFilter}
            value={viewFilter}
            ariaLabel={t('configs.view.aria')}
            options={[
              { value: 'all', label: t('configs.view.all') },
              { value: 'world-book', label: t('configs.view.worldBook') },
              ...allLayers.map((item) => ({ value: item, label: t('configs.view.layer', { layer: translateLabel(t, LAYER_LABEL_KEYS, item) }) })),
            ]}
            onChange={changeViewFilter}
          />
        )}
        <span className={styles.batchControls}>
          <button type="button" className={styles.pillButton} disabled={ordered.length === 0}
            onClick={() => batchSetEnabled(true)}>{t('configs.batch.enable')}</button>
          <button type="button" className={styles.pillButton} disabled={ordered.length === 0}
            onClick={() => batchSetEnabled(false)}>{t('configs.batch.disable')}</button>
        </span>
      </div>

      {errors.length > 0 && (
        <div className={styles.configErrorBox}>
          {errors.map((error, index) => (
            <div key={`${error.index}-${index}`} className={styles.configErrorLine}>[{error.index}] {error.id || t('configs.error.missingId')}：{error.message}</div>
          ))}
        </div>
      )}

      {/* 配置列表下的置顶固定卡片（人设、模板变量等单例配置，不参与层过滤）。 */}
      {beforeCards}

      {/* 模块卡（引擎能力、自定义工具）：与层级配置卡同款列表间距（configList），
          只调整视觉排序，层级配置卡仍按（层序, order, 声明序）注入。 */}
      {moduleCards !== undefined && <div className={styles.configList} hidden={viewFilter === 'world-book'}>{moduleCards}</div>}

      {moduleCards === undefined ? (
        scoped.length === 0 ? (
          <div className={styles.emptyState}><span className={styles.emptyGlyph} aria-hidden="true">⌁</span><div><h3>{scope === 'subagent' ? t('configs.empty.subagent.title') : effectiveLayer === undefined ? t('configs.empty.all.title') : t('configs.empty.layer.title')}</h3><p>{scope === 'subagent' ? t('configs.empty.subagent.desc') : effectiveLayer === undefined ? t('configs.empty.all.desc') : t('configs.empty.layer.desc')}</p>{emptyHint !== undefined && <p className={styles.readOnly}>{emptyHint}</p>}</div></div>
        ) : filtered.length === 0 && keyword.length > 0 ? (
          <p className={styles.readOnly} role="status">{t('configs.noMatch', { keyword: filter.trim() })}</p>
        ) : (
          <div className={styles.configList}>
            {ordered.map((config) => renderCard(config))}
          </div>
        )
      ) : (
        <>
          {filtered.length === 0 && keyword.length > 0 && <p className={styles.readOnly} role="status">{t('configs.noMatch.modules', { keyword: filter.trim() })}</p>}
          <div className={styles.configList}>
            {ordered.map((config) => renderCard(config))}
          </div>
        </>
      )}

    </section>
  )
}
