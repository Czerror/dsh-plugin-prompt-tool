/** 内置模板选择弹窗：按注入层分组展示；传入 layer 时只显示该层模板。 */
import { type ReactNode } from 'react'
import styles from './PromptUi.module.css'
import type { PromptConfigTemplateEntry } from './PromptConfigsEditor.tsx'

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
  onClose: () => void
}): ReactNode {
  const { templates, layer, onPick, onClose } = props
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
      <div className={styles.templateModal} role="dialog" aria-modal="true" aria-label="选择内置模板" onClick={(event) => event.stopPropagation()}>
        <div className={styles.templateModalHead}>
          <strong>选择内置模板{layer !== undefined ? `（${TEMPLATE_LAYER_TITLES[layer] ?? layer}）` : ''}</strong>
          <button type="button" className={styles.pillButton} aria-label="关闭模板选择" onClick={onClose}>×</button>
        </div>
        <div className={styles.templateModalList}>
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
