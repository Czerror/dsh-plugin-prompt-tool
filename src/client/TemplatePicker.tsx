/** 内置模板选择弹窗：按注入层分组展示；传入 layer 时只显示该层模板。 */
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import styles from './PromptUi.module.css'
import type { PromptConfigTemplateEntry } from './prompt-tool-types.ts'

export const TEMPLATE_LAYER_TITLES: Record<string, string> = {
  'pre-step': '消息批层',
  'system-section': '系统段层',
  'runtime-context': '运行上下文',
  'agent-request': '调用配置层',
  'llm-stream': '模型流层',
  'tool-pipeline': '工具管线层',
}

export function TemplatePicker(props: {
  templates: PromptConfigTemplateEntry[]
  /** 传入 layer 时只显示该层模板（无分组标题）；不传按层分组展示全部。 */
  layer?: string
  onPick: (entry: PromptConfigTemplateEntry) => void
  /** 可选：「模板变量（Variables）」固定入口——点击不插入配置，由宿主展开模板变量卡片。 */
  onPickVariables?: () => void
  onClose: () => void
}): ReactNode {
  const { templates, layer, onPick, onPickVariables, onClose } = props
  const dialogRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  // 打开时记录触发元素并聚焦弹窗首控件；关闭时还原焦点（焦点陷阱闭环）。
  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.querySelector<HTMLElement>('button')?.focus()
    return () => { restoreRef.current?.focus() }
  }, [])

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const dialog = dialogRef.current
    if (dialog === null) return
    const focusables = [...dialog.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )].filter((element) => !element.hasAttribute('disabled'))
    if (focusables.length === 0) return
    const first = focusables[0]!
    const last = focusables[focusables.length - 1]!
    const active = document.activeElement
    if (event.shiftKey) {
      if (active === first || !dialog.contains(active)) {
        event.preventDefault()
        last.focus()
      }
    } else if (active === last || !dialog.contains(active)) {
      event.preventDefault()
      first.focus()
    }
  }

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
  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div
        ref={dialogRef}
        className={styles.templateModal}
        role="dialog"
        aria-modal="true"
        aria-label="选择内置模板"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onDialogKeyDown}
      >
        <div className={styles.templateModalHead}>
          <strong>选择内置模板{layer !== undefined ? `（${TEMPLATE_LAYER_TITLES[layer] ?? layer}）` : ''}</strong>
          <button type="button" className={styles.pillButton} aria-label="关闭模板选择" onClick={onClose}>×</button>
        </div>
        <div className={styles.templateModalList}>
          {onPickVariables !== undefined && (
            <div className={styles.templateGroup}>
              <strong className={styles.templateGroupTitle}>变量</strong>
              <button type="button" className={styles.templateModalItem} onClick={onPickVariables}>
                <strong>Variables</strong>
                <small>{'模板变量（预设级 {{key}} 插值）'}</small>
              </button>
            </div>
          )}
          {visible.length === 0 && <p className={styles.configFieldHint}>本层暂无内置模板。</p>}
          {[...groups.entries()].map(([groupLayer, items]) => (
            <div key={groupLayer} className={styles.templateGroup}>
              {layer === undefined && <strong className={styles.templateGroupTitle}>{TEMPLATE_LAYER_TITLES[groupLayer] ?? groupLayer}</strong>}
              {items.map((template) => (
                <button key={template.file} type="button" className={styles.templateModalItem} onClick={() => onPick(template)}>
                  <strong>{template.file}</strong>
                  <small>{template.spec.name ?? template.spec.id}</small>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
