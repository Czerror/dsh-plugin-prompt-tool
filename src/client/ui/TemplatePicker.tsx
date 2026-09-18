/** 内置模板选择浮层：body 顶层 portal，并持续跟随触发按钮。 */
import type { ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Button, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
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
