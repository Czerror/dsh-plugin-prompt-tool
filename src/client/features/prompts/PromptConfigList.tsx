import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { bridgeCall, errorMessage } from '../../data/bridge-client.ts'
import { PromptConfigCard } from './PromptConfigCard.tsx'
import { moveToView, moveWithinLayer, promptConfigLayer, viewOrderedIds } from './prompt-config-order.ts'
import type { EngineMeta, PromptConfigDraft, ValidationErrorEntry } from '../../prompt-tool-types.ts'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './prompts.module.css'

const styles = { ...sharedCss, ...featureCss }

export interface PromptConfigListProps {
  meta: EngineMeta
  configs: PromptConfigDraft[]
  savedConfigs: PromptConfigDraft[]
  /** 传入 layer 时只展示该层配置；不传展示全部配置。 */
  layer?: string
  /** 传入 scope 时按 audience 作用域过滤：main = 非仅子代理（主会话可见）；subagent = 非仅主会话（子代理可见；缺省公用两边都可见）。 */
  scope?: 'main' | 'subagent'
  /** 列表工具栏追加操作（如「新建模板」）。 */
  extraActions?: ReactNode
  /** 列表头部之后、配置卡片之前渲染的固定卡片（如模板变量——归类于配置列表下）。 */
  beforeCards?: ReactNode
  /** 受控层筛选（全部/世界书/层级）；未传时内部 state 兜底（子代理页等独立实例）。 */
  viewFilter?: string
  onViewFilterChange?: (value: string) => void
  /** 空状态追加提示（如「当前预设模板该层无配置」）。 */
  emptyHint?: string
  onPatchConfigs: (configs: PromptConfigDraft[]) => void
  onSaveConfigs: (configs: PromptConfigDraft[]) => void
  onNotice: (kind: 'ok' | 'error', message: string) => void
}

/** 共享的提示词配置列表：校验、保存、脏检测、复制、删除、层内移动。 */
export function PromptConfigList(props: PromptConfigListProps): ReactNode {
  const { meta, configs, savedConfigs, layer, scope, extraActions, beforeCards, viewFilter: viewFilterProp, onViewFilterChange, emptyHint, onPatchConfigs, onSaveConfigs, onNotice } = props
  const [expanded, setExpanded] = useState<string | undefined>(undefined)
  const [errors, setErrors] = useState<ValidationErrorEntry[]>([])
  const [validating, setValidating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [filter, setFilter] = useState('')
  /** 拖拽排序状态：源卡片 id + 落点（目标 id + 前/后）。 */
  const [dragId, setDragId] = useState<string | undefined>(undefined)
  const [dropTarget, setDropTarget] = useState<{ id: string; before: boolean } | undefined>(undefined)
  /** 合并过滤下拉：全部 / 世界书（策略）/ 各注入层级。外部 layer prop 传入时固定该层。 */
  const [innerViewFilter, setInnerViewFilter] = useState<string>('all')
  const viewFilter = viewFilterProp ?? innerViewFilter
  const changeViewFilter = (value: string): void => {
    if (onViewFilterChange !== undefined) onViewFilterChange(value)
    else setInnerViewFilter(value)
  }

  const effectiveLayer = layer ?? (viewFilter !== 'all' && viewFilter !== 'world-book' ? viewFilter : undefined)
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
    const index = meta.layers.indexOf(promptConfigLayer(config))
    return index < 0 ? meta.layers.length : index
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

  // patch 路径从不原地 mutate（均生成新数组），引用比较即可判断脏；省掉每次渲染全量序列化大数组。
  const dirty = configs !== savedConfigs

  const runValidate = async (target: PromptConfigDraft[]): Promise<boolean> => {
    setValidating(true)
    try {
      const res = await bridgeCall('configsValidate', { promptConfigs: target })
      if (!res.ok) {
        onNotice('error', '校验请求失败：' + (res.message ?? 'settings bridge unavailable'))
        return false
      }
      setErrors(res.value.valid ? [] : res.value.errors ?? [])
      return res.value.valid
    } catch (error) {
      onNotice('error', '校验请求失败：' + errorMessage(error))
      return false
    } finally {
      setValidating(false)
    }
  }

  const save = async () => {
    setSaving(true)
    const valid = await runValidate(configs)
    if (valid) {
      setErrors([])
      onSaveConfigs(configs)
      onNotice('ok', `已校验并保存（${configs.length} 条）`)
    }
    setSaving(false)
  }

  const discard = () => {
    onPatchConfigs(savedConfigs)
    setErrors([])
    setExpanded(undefined)
  }

  // 显示顺序（层序/order/声明序）一次计算：position map 供每张卡判断上移/下移，
  // 此前每张卡各自调 viewOrderedIds（O(n log n) × n）。
  // 世界书筛选视图：移动/排序只作用于可见子集（strategy=world-book），
  // 避免与不可见配置交换顺序。
  const viewStrategy = viewFilter === 'world-book' ? 'world-book' : undefined
  const viewIds = useMemo(
    () => viewOrderedIds(configs, layer, meta.layers, viewStrategy),
    [configs, layer, meta.layers, viewStrategy],
  )
  const positionOf = useMemo(() => new Map(viewIds.map((id, at) => [id, at])), [viewIds])

  /** 卡片稳定回调（memo 生效前提）：经 liveRef 读最新列表状态，回调引用跨渲染不变。 */
  const liveRef = useRef({ configs, layer, metaLayers: meta.layers, strategy: viewStrategy, dragId, dropTarget })
  liveRef.current = { configs, layer, metaLayers: meta.layers, strategy: viewStrategy, dragId, dropTarget }
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
    onNotice('ok', '已复制')
  }, [onNotice, onPatchConfigs])
  const handleDelete = useCallback((id: string) => {
    const current = liveRef.current.configs
    onPatchConfigs(current.filter((item) => item.id !== id))
    setExpanded((value) => value === id ? undefined : value)
    onNotice('ok', '已删除')
  }, [onNotice, onPatchConfigs])
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
      <div><h2 id="prompt-tool-configs-heading">{layer === undefined ? '模块列表' : '本层配置'}</h2><p>{scoped.length} 条配置 · {scoped.filter((config) => config.enabled !== false).length} 条启用；上下移动控制同层顺序。</p></div>
        <div className={styles.sectionActions}>
          {extraActions}
          <button type="button" className={styles.pillButton} disabled={validating} onClick={() => void runValidate(configs)}>{validating && <span className={styles.spinner} aria-hidden="true" />}{validating ? '校验中…' : '校验'}</button>
          <button type="button" className={styles.primaryPill} disabled={saving || validating} onClick={() => void save()}>{saving && <span className={styles.spinner} aria-hidden="true" />}{saving ? '保存中…' : '保存'}</button>
        </div>
      </div>

      <div className={styles.listFilterRow}>
        <input
          className={styles.listFilter}
          value={filter}
          aria-label="过滤模块列表"
          placeholder="过滤：按 id / 名称…"
          spellCheck={false}
          onChange={(event) => setFilter(event.target.value)}
        />
        {layer === undefined && (
          <select
            className={styles.listFilter}
            value={viewFilter}
            aria-label="按层级或策略过滤"
            onChange={(event) => changeViewFilter(event.target.value)}
          >
            <option value="all">全部</option>
            <option value="world-book">世界书</option>
            {meta.layers.map((item) => (
              <option key={item} value={item}>层级：{item}</option>
            ))}
          </select>
        )}
        <span className={styles.batchControls}>
          <button type="button" className={styles.pillButton} disabled={ordered.length === 0}
            onClick={() => batchSetEnabled(true)}>启用</button>
          <button type="button" className={styles.pillButton} disabled={ordered.length === 0}
            onClick={() => batchSetEnabled(false)}>禁用</button>
        </span>
      </div>

      {errors.length > 0 && (
        <div className={styles.configErrorBox}>
          {errors.map((error, index) => (
            <div key={`${error.index}-${index}`} className={styles.configErrorLine}>[{error.index}] {error.id || '(缺 id)'}：{error.message}</div>
          ))}
        </div>
      )}

      {/* 归类于配置列表下的固定卡片（模板变量：可折叠 / 可删除 / 可新建）。 */}
      {beforeCards}

      {scoped.length === 0 ? (
        <div className={styles.emptyState}><span className={styles.emptyGlyph} aria-hidden="true">⌁</span><div><h3>{scope === 'subagent' ? '还没有子代理可见的配置' : effectiveLayer === undefined ? '还没有自定义配置' : '本层还没有自定义配置'}</h3><p>{scope === 'subagent' ? '从上方「新建」插入一条（插入后可在卡片「消息受众」下拉自由切换仅主会话/公用/仅子代理），或到主设置「配置」从目录导入。' : effectiveLayer === undefined ? '从上方模板插入一条，或从本地目录导入；默认四条内置配置不受影响。' : '请到主设置「配置」从模板插入或从目录导入。'}</p>{emptyHint !== undefined && <p className={styles.readOnly}>{emptyHint}</p>}</div></div>
      ) : filtered.length === 0 ? (
        <p className={styles.readOnly} role="status">没有匹配「{filter.trim()}」的配置。</p>
      ) : (
        <div className={styles.configList}>
          {ordered.map((config) => renderCard(config))}
        </div>
      )}

      <div className={styles.feedback} aria-live="polite">
        {dirty && <p className={styles.readOnly}>模块列表有未保存修改。</p>}
      </div>

      <footer className={`${styles.actions} ${dirty ? styles.actionsVisible : ''}`} aria-live="polite">
        <span>{dirty ? '有未保存修改' : ''}</span>
        <div>
          <button type="button" className={styles.pillButton} data-variant="secondary" disabled={saving || !dirty} onClick={discard}>放弃修改</button>
          <button type="button" className={styles.save} disabled={saving || validating || !dirty} onClick={() => void save()}>{saving && <span className={styles.spinner} aria-hidden="true" />}{saving ? '保存中…' : '保存全部'}</button>
        </div>
      </footer>
    </section>
  )
}
