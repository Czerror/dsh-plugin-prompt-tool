import { useState, type ReactNode } from 'react'
import { bridgePost, errorMessage } from './prompt-tool-bridge.ts'
import { PromptConfigCard } from './PromptConfigCard.tsx'
import type { EngineMeta, PromptConfigDraft, ValidationErrorEntry } from './prompt-tool-types.ts'
import styles from './PromptUi.module.css'

interface ValidateResult {
  ok: boolean
  valid: boolean
  errors?: ValidationErrorEntry[]
  message?: string
}

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
  /** 空状态追加提示（如「当前预设模板该层无配置」）。 */
  emptyHint?: string
  onPatchConfigs: (configs: PromptConfigDraft[]) => void
  onSaveConfigs: (configs: PromptConfigDraft[]) => void
  onNotice: (kind: 'ok' | 'error', message: string) => void
}

const layerOf = (config: PromptConfigDraft): string => config.layer ?? 'pre-step'

/** 在全局数组中按同层位置交换；未指定 layer 时也保持“同层内移动”语义。 */
function moveWithinLayer(
  all: PromptConfigDraft[],
  globalIndex: number,
  delta: -1 | 1,
  layer?: string,
): PromptConfigDraft[] {
  const layerIndices = all.flatMap((config, index) =>
    (layer === undefined || layerOf(config) === layer) ? [index] : [],
  )
  const position = layerIndices.indexOf(globalIndex)
  const target = position + delta
  if (position < 0 || target < 0 || target >= layerIndices.length) return all
  const targetIndex = layerIndices[target]!
  const next = [...all]
  const current = next[globalIndex]
  const targetCard = next[targetIndex]
  // 引擎按 order 升序渲染（executor pre-step / layers 同规则）：层内移动必须同步
  // 交换 order，否则拖拽后实际注入顺序不变（显示与引擎脱节 = 排序混乱）。
  if (current === undefined || targetCard === undefined) return all
  next[globalIndex] = { ...targetCard, order: current.order ?? 0 }
  next[targetIndex] = { ...current, order: targetCard.order ?? 0 }
  return next
}

/** 共享的提示词配置列表：校验、保存、脏检测、复制、删除、层内移动。 */
export function PromptConfigList(props: PromptConfigListProps): ReactNode {
  const { meta, configs, savedConfigs, layer, scope, extraActions, emptyHint, onPatchConfigs, onSaveConfigs, onNotice } = props
  const [expanded, setExpanded] = useState<string | undefined>(undefined)
  const [errors, setErrors] = useState<ValidationErrorEntry[]>([])
  const [validating, setValidating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [filter, setFilter] = useState('')
  /** 合并过滤下拉：全部 / 世界书（策略）/ 各注入层级。外部 layer prop 传入时固定该层。 */
  const [viewFilter, setViewFilter] = useState<string>('all')

  const effectiveLayer = layer ?? (viewFilter !== 'all' && viewFilter !== 'world-book' ? viewFilter : undefined)
  const visible = effectiveLayer === undefined
    ? configs
    : configs.filter((config) => layerOf(config) === effectiveLayer)
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
    const index = meta.layers.indexOf(layerOf(config))
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

  const dirty = JSON.stringify(configs) !== JSON.stringify(savedConfigs)

  const runValidate = async (target: PromptConfigDraft[]): Promise<boolean> => {
    setValidating(true)
    try {
      const res = await bridgePost<ValidateResult>('/configs-validate', { promptConfigs: target })
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

  const patchAt = (globalIndex: number, patch: Partial<PromptConfigDraft>) => {
    onPatchConfigs(configs.map((config, index) => index === globalIndex ? { ...config, ...patch } : config))
  }

  const removeAt = (globalIndex: number) => {
    const removedId = configs[globalIndex]?.id
    if (removedId === undefined) return
    // 删除确认由卡片头部「删除 → 确认删除」两段式承担（宿主 webview 禁 window.confirm，不依赖原生弹窗）。
    onPatchConfigs(configs.filter((_, index) => index !== globalIndex))
    if (expanded === removedId) setExpanded(undefined)
    onNotice('ok', '已删除')
  }

  const duplicateAt = (globalIndex: number) => {
    const source = configs[globalIndex]
    if (source === undefined) return
    let id = `${source.id}-copy`
    let suffix = 2
    while (configs.some((config) => config.id === id)) {
      id = `${source.id}-copy${suffix}`
      suffix += 1
    }
    const clone = JSON.parse(JSON.stringify(source)) as PromptConfigDraft
    clone.id = id
    onPatchConfigs([...configs, clone])
    setExpanded(id)
    onNotice('ok', '已复制')
  }

  const renderCard = (config: PromptConfigDraft) => {
    const globalIndex = configs.indexOf(config)
    const layerIndices = configs.flatMap((candidate, index) =>
      (layer === undefined || layerOf(candidate) === layer) ? [index] : [],
    )
    const position = layerIndices.indexOf(globalIndex)
    const isOpen = expanded === config.id
    return (
      <PromptConfigCard
        key={config.id}
        meta={meta}
        config={config}
        expanded={isOpen}
        onToggleExpanded={() => {
          setExpanded(isOpen ? undefined : config.id)
        }}
        onToggleEnabled={(enabled) => patchAt(globalIndex, { enabled })}
        onPatch={(patch) => patchAt(globalIndex, patch)}
        actions={{
          canMoveUp: position > 0,
          canMoveDown: position >= 0 && position < layerIndices.length - 1,
          onMoveUp: () => onPatchConfigs(moveWithinLayer(configs, globalIndex, -1, layer)),
          onMoveDown: () => onPatchConfigs(moveWithinLayer(configs, globalIndex, 1, layer)),
          onDuplicate: () => duplicateAt(globalIndex),
          onDelete: () => removeAt(globalIndex),
        }}
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

      {scoped.length > 0 && (
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
              onChange={(event) => setViewFilter(event.target.value)}
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
      )}

      {errors.length > 0 && (
        <div className={styles.configErrorBox}>
          {errors.map((error, index) => (
            <div key={`${error.index}-${index}`} className={styles.configErrorLine}>[{error.index}] {error.id || '(缺 id)'}：{error.message}</div>
          ))}
        </div>
      )}

      {scoped.length === 0 ? (
        <div className={styles.emptyState}><span className={styles.emptyGlyph} aria-hidden="true">⌁</span><div><h3>{scope === 'subagent' ? '还没有子代理可见的配置' : layer === undefined ? '还没有自定义配置' : '本层还没有自定义配置'}</h3><p>{scope === 'subagent' ? '从上方「新建」插入一条（插入后可在卡片「消息受众」下拉自由切换仅主会话/公用/仅子代理），或到主设置「配置」从目录导入。' : layer === undefined ? '从上方模板插入一条，或从本地目录导入；默认四条内置配置不受影响。' : '请到主设置「配置」从模板插入或从目录导入。'}</p>{emptyHint !== undefined && <p className={styles.readOnly}>{emptyHint}</p>}</div></div>
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
