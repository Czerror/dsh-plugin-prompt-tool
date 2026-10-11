/** 内置模板选择浮层：body 顶层 portal，并持续跟随触发按钮。 */
import { useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Button } from './Button.tsx'
import { DialogSurface } from './DialogSurface.tsx'
import { useDismissOnOutsidePointer } from './outside-pointer.ts'
import type { PromptToolLocaleKey, PromptToolTranslate } from '../locales.ts'
import { useAnchoredPopoverStyle } from './anchored-popover.ts'
import { useDialogFocus } from './dialog-focus.ts'
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
  anchorRef: RefObject<HTMLElement | null>
  templates: PromptConfigTemplateEntry[]
  /** 传入 layer 时只显示该层模板（无分组标题）；不传按层分组展示全部。 */
  layer?: string
  onPick: (entry: PromptConfigTemplateEntry) => void
  /** 可选：自定义工具模板（「工具」分组；点击经 onPickTool 回调工具定义）。 */
  toolTemplates?: Array<{ file: string; spec: Record<string, unknown> }>
  onPickTool?: (spec: Record<string, unknown>) => void
  /** 可选：「模板变量（Variables）」固定入口——点击不插入配置，由宿主展开模板变量卡片。 */
  onPickVariables?: () => void
  onClose: () => void
}): ReactNode {
  const { t, anchorRef, templates, layer, onPick, toolTemplates, onPickTool, onPickVariables, onClose } = props
  const layerTitle = (value: string): string => {
    const key = TEMPLATE_LAYER_LABEL_KEYS[value]
    return key === undefined ? value : t(key)
  }
  const { dialogRef, onDialogKeyDown } = useDialogFocus<HTMLDivElement>(true, onClose)
  const portalRef = dialogRef as RefObject<HTMLElement | null>
  const position = useAnchoredPopoverStyle({
    open: true,
    anchorRef,
    panelRef: portalRef,
    gap: 8,
    margin: 12,
  })
  useDismissOnOutsidePointer(anchorRef, true, (open) => { if (!open) onClose() }, portalRef)

  const visible = layer === undefined
    ? templates
    : templates.filter((template) => (template.spec.layer ?? 'pre-step') === layer)
  const groups = new Map<string, PromptConfigTemplateEntry[]>()
  for (const template of visible) {
    const key = template.spec.layer ?? 'pre-step'
    const items = groups.get(key)
    if (items === undefined) groups.set(key, [template])
    else items.push(template)
  }

  const surface = (
    <div
      ref={dialogRef}
      className={styles.templatePopover}
      style={position ?? { visibility: 'hidden' }}
      role="dialog"
      aria-label={t('templates.aria')}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={onDialogKeyDown}
    >
      <div className={styles.templateModalHead}>
        <strong>{layer !== undefined ? t('templates.title', { layer: layerTitle(layer) }) : t('templates.aria')}</strong>
        <Button variant="ghost" size="sm" className={styles.dialogClose} aria-label={t('templates.closeAria')} onClick={onClose}>×</Button>
      </div>
      <div className={styles.templateModalList}>
        {onPickVariables !== undefined && (
          <div className={styles.templateGroup}>
            <strong className={styles.templateGroupTitle}>{t('templates.group.variables')}</strong>
            <button type="button" className={styles.templateModalItem} onClick={onPickVariables}>
              <strong>Variables</strong>
              <small>{t('templates.variables.hint')}</small>
            </button>
          </div>
        )}
        {visible.length === 0 && (toolTemplates?.length ?? 0) === 0
          && <p className={styles.configFieldHint}>{t('templates.empty')}</p>}
        {[...groups.entries()].map(([groupLayer, items]) => (
          <div key={groupLayer} className={styles.templateGroup}>
            {layer === undefined && <strong className={styles.templateGroupTitle}>{layerTitle(groupLayer)}</strong>}
            {items.map((template) => (
              <button key={template.file} type="button" className={styles.templateModalItem} onClick={() => onPick(template)}>
                <strong>{template.file}</strong>
                <small>{template.spec.name ?? template.spec.id}</small>
              </button>
            ))}
          </div>
        ))}
        {toolTemplates !== undefined && toolTemplates.length > 0 && (
          <div className={styles.templateGroup}>
            <strong className={styles.templateGroupTitle}>{t('templates.group.tools')}</strong>
            {toolTemplates.map((template) => (
              <button key={template.file} type="button" className={styles.templateModalItem}
                onClick={() => onPickTool?.(template.spec)}>
                <strong>{template.file}</strong>
                <small>{String(template.spec.name ?? template.spec.id ?? '')}</small>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
  return typeof document === 'undefined' || document.body === null ? surface : createPortal(surface, document.body)
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
 * 判据是「已存在的模块目录」全集（含未启用），不是候选列表——包内空白模板会被种子化进用户
 * 模块根且默认未启用，只看候选就会永远预览错一位。预览仍不承诺结果（多级后缀/不在 /meta 时偏乐观），
 * 文案里已写「以服务端结果为准」。
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
  /** 浮层锚点＝页级「添加」按钮；缺省时居中模态。 */
  anchorRef?: RefObject<HTMLElement | null>
  /** 候选：**只列可写模块**（调用方按共享判据过滤后传入）。 */
  modules: readonly TemplateTargetListEntry[]
  /** 已存在的模块目录 id 全集（含未启用）：只影响新建 id 预览，不影响可选性。 */
  existingIds?: readonly string[]
  /** 新建空白模块的复制源模板 id（只用于展示预览；真实名字由服务端定）。 */
  newModuleTemplate: string
  /** 选中已存在模块：主语就是它，创建动作立刻带上这个 id。 */
  onPick: (moduleId: string) => void
  /** 新建空白模块：走既有新建动作，返回新模块 id（失败 undefined，对话框内就地报错）。 */
  onCreate?: () => Promise<string | undefined>
  onClose: () => void
}): ReactNode {
  const { t, modules, onPick, onCreate, onClose } = props
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const submitNew = async (): Promise<void> => {
    if (onCreate === undefined || busy) return
    setBusy(true); setFailed(false)
    const created = await onCreate()
    setBusy(false)
    if (created === undefined) { setFailed(true); return }
    // 建好即写进它：这就是「新建空白模块」的收口（创建 + 写入，仍是一步语义）。
    onPick(created)
  }
  return <DialogSurface title={t('rules.create.title')} ariaLabel={t('rules.create.title')}
    closeLabel={t('rules.create.cancel')} anchorRef={props.anchorRef} onClose={onClose}>
    {modules.length === 0 && <p className={styles.configFieldHint}>{t('rules.create.none')}</p>}
    {modules.map(module => <button key={module.id} type="button" className={styles.templateModalItem} data-template-target={module.id}
      onClick={() => onPick(module.id)}>
      <strong>{module.name ?? module.id}</strong>
      <small>{module.id}</small>
    </button>)}
    <div className={styles.templateGroup} data-template-new-module>
      <strong className={styles.templateGroupTitle}>{t('rules.create.new')}</strong>
      <p className={styles.configFieldHint}>{t('rules.create.newHint', { id: newModuleIdPreview(props.newModuleTemplate, props.existingIds ?? modules.map((module) => module.id)) })}</p>
      {failed && <p role="alert" className={styles.confirmError}>{t('rules.create.failed')}</p>}
      <div className={styles.dialogFooter}>
        <Button shape="pill" variant="outline" onClick={onClose}>{t('rules.create.cancel')}</Button>
        <Button shape="pill" variant="primary" data-template-new-submit disabled={onCreate === undefined || busy}
          onClick={() => { void submitNew() }}>{t('rules.create.submit')}</Button>
      </div>
    </div>
  </DialogSurface>
}
