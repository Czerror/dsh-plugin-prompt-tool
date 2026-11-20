import { useId, useRef, useState, type ReactNode } from 'react'
import { Button } from './Button.tsx'
import { CanvasChoiceDialog } from './CanvasChoice.tsx'
import type { PromptToolLocaleKey, PromptToolTranslate } from '../locales.ts'
import css from './CanvasChoice.module.css'
import styles from './controls.module.css'
import type { PromptConfigTemplateEntry } from '../prompt-tool-types.ts'

/** 模板分组标题（模板库按官方批次命名，与配置卡的注入层标签分开）。 */
const TEMPLATE_LAYER_LABEL_KEYS: Record<string, PromptToolLocaleKey> = {
  'pre-step': 'templates.layer.pre-step',
  'system-section': 'templates.layer.system-section',
  'runtime-context': 'templates.layer.runtime-context',
  'agent-request': 'templates.layer.agent-request',
  'llm-stream': 'templates.layer.llm-stream',
  'tool-pipeline': 'templates.layer.tool-pipeline',
  'turn-stop': 'templates.layer.turn-stop',
  'subagent-start': 'templates.layer.subagent-start',
  'subagent-end': 'templates.layer.subagent-end',
}

export function TemplatePicker(props: {
  t: PromptToolTranslate
  templates: PromptConfigTemplateEntry[]
  onPick: (entry: PromptConfigTemplateEntry) => void
  /** 可选：自定义工具模板（「工具」分组；点击经 onPickTool 回调工具定义）。 */
  toolTemplates?: Array<{ file: string; spec: Record<string, unknown> }>
  onPickTool?: (spec: Record<string, unknown>) => void
  onClose: () => void
}): ReactNode {
  const { t, templates, onPick, toolTemplates = [], onPickTool, onClose } = props
  const id = useId()
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const layerTitle = (value: string): string => {
    const key = TEMPLATE_LAYER_LABEL_KEYS[value]
    return key === undefined ? value : t(key)
  }
  const visible = templates.filter(({ file, spec }) => {
    const layer = spec.layer ?? 'pre-step'
    return `${file} ${spec.name ?? ''} ${spec.id} ${layer} ${layerTitle(layer)}`.toLowerCase().includes(needle)
  })
  const toolsTitle = t('templates.group.tools')
  const visibleTools = toolTemplates.filter(({ file, spec }) =>
    `${file} ${spec.name ?? ''} ${spec.id ?? ''} ${toolsTitle}`.toLowerCase().includes(needle))
  const groups = new Map<string, PromptConfigTemplateEntry[]>()
  for (const template of visible) {
    const key = template.spec.layer ?? 'pre-step'
    const items = groups.get(key)
    if (items === undefined) groups.set(key, [template])
    else items.push(template)
  }

  return (
    <CanvasChoiceDialog t={t} title={t('templates.aria')} query={query} onQueryChange={setQuery} onClose={onClose}
      onAccept={() => {
        if (visible.length + visibleTools.length !== 1) return
        if (visible[0]) onPick(visible[0])
        else if (visibleTools[0]) onPickTool?.(visibleTools[0].spec)
      }}>
        {visible.length === 0 && visibleTools.length === 0 && <p role="status">{t('choice.noMatch')}</p>}
        {[...groups.entries()].map(([groupLayer, items]) => (
          <section key={groupLayer} className={css.group} aria-labelledby={`${id}-${groupLayer}`}>
            <h3 id={`${id}-${groupLayer}`}>{layerTitle(groupLayer)}</h3>
            {items.map((template) => (
              <button key={template.file} type="button" className={styles.templateModalItem} onClick={() => onPick(template)}>
                <strong>{template.file}</strong>
                <small>{template.spec.name ?? template.spec.id}</small>
              </button>
            ))}
          </section>
        ))}
        {visibleTools.length > 0 && (
          <section className={css.group} aria-labelledby={`${id}-tools`}>
            <h3 id={`${id}-tools`}>{toolsTitle}</h3>
            {visibleTools.map((template) => (
              <button key={template.file} type="button" className={styles.templateModalItem}
                onClick={() => onPickTool?.(template.spec)}>
                <strong>{template.file}</strong>
                <small>{String(template.spec.name ?? template.spec.id ?? '')}</small>
              </button>
            ))}
          </section>
        )}
    </CanvasChoiceDialog>
  )
}

/** 目标选择的候选行：候选**只列可写模块**，由调用方按共享判据过滤后传入。 */
export interface TemplateTargetListEntry {
  id: string
  name?: string
  /** 是否在装配集合（存储根启用表）里；仅作展示，可写性已由过滤保证。 */
  enabled?: boolean
}

/**
 * 待创建模块的 id 预览：目录名**已存在**就说明服务端会加后缀（`blank` → `blank-2`）。
 * 判据是「已存在的模块目录」全集（含未启用），不是候选列表——复制源模板本身不会出现在
 * 候选里，但它可能已经（或历史上曾经）作为模块目录存在于用户根下，只看候选就会预览错一位。
 * 预览仍不承诺结果（多级后缀/不在 /meta 时偏乐观），文案里已写「以服务端结果为准」。
 */
export const newModuleIdPreview = (templateId: string, existingIds: readonly string[]): string =>
  existingIds.includes(templateId) ? `${templateId}-2` : templateId

/**
 * 选完模板后的**唯一**追加步骤：目标模块（已存在 / 新建空白模块）。
 *
 * 这里是「一步」的边界：对话框只回两种结果——选中某个已存在模块的 id，或让调用方用**既有**
 * 新建动作建一个新模块（`onCreate` 返回新模块 id，失败返回 undefined）。
 * 主语一律来自所选目标，不引入任何「当前模块」语义。
 */
export function TemplateTargetPicker(props: {
  t: PromptToolTranslate
  /** 候选：**只列可写模块**（调用方按共享判据过滤后传入）。 */
  modules: readonly TemplateTargetListEntry[]
  /** 已存在的模块目录 id 全集（含未启用）：只影响新建 id 预览，不影响可选性。 */
  existingIds?: readonly string[]
  /** 新建空白模块的复制源模板 id（只用于展示预览；真实名字由服务端定）。 */
  newModuleTemplate: string
  /** 选中已存在模块：主语就是它，创建动作立刻带上这个 id。 */
  onPick: (moduleId: string, newlyCreated?: boolean) => void
  /** 新建空白模块：走既有新建动作，返回新模块 id（失败 undefined，对话框内就地报错）。 */
  onCreate?: () => Promise<string | undefined>
  onClose: () => void
}): ReactNode {
  const { t, modules, onPick, onCreate, onClose } = props
  const id = useId()
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const visible = modules.filter(module => `${module.name ?? ''} ${module.id}`.toLowerCase().includes(needle))
  const submitting = useRef(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const submitNew = async (): Promise<void> => {
    if (onCreate === undefined || submitting.current) return
    submitting.current = true
    setBusy(true); setFailed(false)
    try {
      const created = await onCreate()
      if (created === undefined) { setFailed(true); return }
      onPick(created, true)
    } catch {
      setFailed(true)
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  const select = (moduleId: string): void => {
    if (!submitting.current) onPick(moduleId)
  }
  return <CanvasChoiceDialog t={t} title={t('rules.create.title')} query={query} onQueryChange={setQuery} onClose={onClose}
    onAccept={() => { if (visible.length === 1) select(visible[0]!.id) }}>
    <div className={css.group}>
      {visible.length === 0 && <p role="status">{t(modules.length === 0 ? 'rules.create.none' : 'choice.noMatch')}</p>}
      {visible.map(module => <button key={module.id} type="button" className={styles.templateModalItem} data-template-target={module.id}
        disabled={busy} onClick={() => select(module.id)}>
        <strong>{module.name ?? module.id}</strong>
        <small>{module.id}</small>
      </button>)}
    </div>
    <section className={css.group} aria-labelledby={id} data-template-new-module>
      <h3 id={id}>{t('rules.create.new')}</h3>
      <p className={styles.configFieldHint}>{t('rules.create.newHint', { id: newModuleIdPreview(props.newModuleTemplate, props.existingIds ?? modules.map((module) => module.id)) })}</p>
      {failed && <p role="alert" className={styles.confirmError}>{t('rules.create.failed')}</p>}
      <div className={styles.dialogFooter}>
        <Button shape="pill" variant="outline" onClick={onClose}>{t('rules.create.cancel')}</Button>
        <Button shape="pill" variant="primary" data-template-new-submit disabled={onCreate === undefined || busy}
          onClick={() => { void submitNew() }}>{t('rules.create.submit')}</Button>
      </div>
    </section>
  </CanvasChoiceDialog>
}
