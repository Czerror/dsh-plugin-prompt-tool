import { useEffect, useState, type ReactNode } from 'react'
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
  /** 外部聚焦请求：变化时展开对应卡片并滚动到可视区（来自 Anchored Standard 模块行的编辑入口）。 */
  focusId?: string
  /** 聚焦请求序号：同 id 重复请求时递增以重新触发（依赖数组含此值）。 */
  focusTick?: number
  /** 列表工具栏追加操作（如「新建模板」）。 */
  extraActions?: ReactNode
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
  next[globalIndex] = next[targetIndex]!
  next[targetIndex] = current!
  return next
}

/** 共享的提示词配置列表：校验、保存、脏检测、复制、删除、层内移动。 */
export function PromptConfigList(props: PromptConfigListProps): ReactNode {
  const { meta, configs, savedConfigs, layer, focusId, focusTick, extraActions, onPatchConfigs, onSaveConfigs, onNotice } = props
  const [expanded, setExpanded] = useState<string | undefined>(undefined)
  const [errors, setErrors] = useState<ValidationErrorEntry[]>([])
  const [validating, setValidating] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (focusId === undefined) return
    setExpanded(focusId)
    requestAnimationFrame(() => {
      document.getElementById(`pt-config-card-${focusId}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    })
  }, [focusId, focusTick])

  const visible = layer === undefined
    ? configs
    : configs.filter((config) => layerOf(config) === layer)

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
      onNotice('ok', `提示词配置已校验并保存（${configs.length} 条）`)
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
    onPatchConfigs(configs.filter((_, index) => index !== globalIndex))
    if (expanded === removedId) setExpanded(undefined)
    onNotice('ok', '已删除提示词配置（记得保存）')
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
    onNotice('ok', '已复制提示词配置（记得保存）')
  }

  const renderCard = (config: PromptConfigDraft, forceOpen: boolean) => {
    const globalIndex = configs.indexOf(config)
    const layerIndices = configs.flatMap((candidate, index) =>
      (layer === undefined || layerOf(candidate) === layer) ? [index] : [],
    )
    const position = layerIndices.indexOf(globalIndex)
    const isOpen = forceOpen || expanded === config.id
    return (
      <PromptConfigCard
        key={config.id}
        meta={meta}
        config={config}
        expanded={isOpen}
        onToggleExpanded={() => {
          if (forceOpen) return
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
        <div><h2 id="prompt-tool-configs-heading">{layer === undefined ? '配置列表' : '本层提示词配置'}</h2><p>{visible.length} 条配置 · {visible.filter((config) => config.enabled !== false).length} 条启用；上下移动控制同层顺序。</p></div>
        <div className={styles.sectionActions}>
          {extraActions}
          <button type="button" className={styles.pillButton} disabled={validating} onClick={() => void runValidate(configs)}>{validating ? '校验中…' : '校验'}</button>
          <button type="button" className={styles.primaryPill} disabled={saving || validating} onClick={() => void save()}>{saving ? '保存中…' : '保存提示词配置'}</button>
        </div>
      </div>

      {errors.length > 0 && (
        <div className={styles.configErrorBox}>
          {errors.map((error, index) => (
            <div key={`${error.index}-${index}`} className={styles.configErrorLine}>[{error.index}] {error.id || '(缺 id)'}：{error.message}</div>
          ))}
        </div>
      )}

      {visible.length === 0 ? (
        <div className={styles.emptyState}><span className={styles.emptyGlyph} aria-hidden="true">⌁</span><div><h3>{layer === undefined ? '还没有自定义提示词配置' : '本层还没有自定义配置'}</h3><p>{layer === undefined ? '从上方模板插入一条，或从本地目录导入；默认四条内置配置不受影响。' : '请到主设置「提示词配置」从模板插入或从目录导入。'}</p></div></div>
      ) : (
        <div className={styles.configList}>
          {visible.map((config) => renderCard(config, false))}
        </div>
      )}

      <div className={styles.feedback} aria-live="polite">
        {dirty && <p className={styles.readOnly}>配置列表有未保存修改。</p>}
      </div>

      <footer className={`${styles.actions} ${dirty ? styles.actionsVisible : ''}`} aria-live="polite">
        <span>{dirty ? '有未保存修改' : ''}</span>
        <div>
          <button type="button" className={styles.discard} disabled={saving || !dirty} onClick={discard}>放弃修改</button>
          <button type="button" className={styles.save} disabled={saving || validating || !dirty} onClick={() => void save()}>{saving ? '保存中…' : '保存全部'}</button>
        </div>
      </footer>
    </section>
  )
}
