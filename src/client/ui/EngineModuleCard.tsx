import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { HintTooltip } from './HintTooltip.tsx'
import styles from './controls.module.css'
/** 引擎模块可折叠卡片：与模块列表（PromptConfigList）同款形态——
 *  configCard + configToggle + chevron，点击展开 configForm 编辑组合行 config
 *  （经 params 参数桥扁平键落 preset.yml）。归类于配置列表下（beforeCards）。
 *  layer：能力影响的 UI 行为分类（pre-step / system-section / tool-pipeline），
 *  由统一模块列表按插入点组合展示；不参与运行时 hook 排序。 */
export function EngineModuleCard(props: {
  name: string
  meta: string
  layer?: string
  children?: ReactNode
  onDelete?: () => void
  /** 纯开关卡：开关直接渲染在 header 顶层（右侧），卡片不展开、不折叠。 */
  topSwitch?: {
    id: string
    label: string
    hint: string
    checked: boolean
    disabled?: boolean
    onToggle: () => void
  }
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const compact = props.topSwitch !== undefined
  return (
    <article className={clsx(styles.configCard, styles.moduleCard)} data-module-card="true">
      <header className={styles.configHeader}>
        <button type="button" className={styles.configToggle} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          <span className={styles.configTitle}>
            <span className={styles.configTitleRow}>
              <span className={styles.configName}>{props.name}</span>
              {props.layer !== undefined && <span className={styles.configChip}>{props.layer}</span>}
            </span>
            <span className={styles.configMeta}>{props.meta}</span>
          </span>
          {!compact && <IconChevronDownOutline14 className={clsx(styles.chevron, expanded && styles.chevronOpen)} />}
        </button>
        {(props.topSwitch !== undefined || props.onDelete !== undefined) && (
          <span className={styles.configHeaderActions}>
            {props.topSwitch !== undefined && <HintTooltip label={props.topSwitch.hint}>
              <label className={styles.configEnable} htmlFor={props.topSwitch.id}>
                <input
                  id={props.topSwitch.id}
                  type="checkbox"
                  checked={props.topSwitch.checked}
                  disabled={props.topSwitch.disabled}
                  aria-label={props.topSwitch.label}
                  onChange={props.topSwitch.onToggle}
                />
                <span className={styles.switch} aria-hidden="true"><i /></span>
              </label>
            </HintTooltip>}
            {props.onDelete !== undefined && (confirmingDelete ? (
              <>
                <button type="button" className={styles.pillButton} data-danger onClick={props.onDelete}>确认删除</button>
                <button type="button" className={styles.pillButton} data-variant="secondary" onClick={() => setConfirmingDelete(false)}>取消</button>
              </>
            ) : (
              <HintTooltip label={`删除 ${props.name}`}>
                <button type="button" className={styles.pillButton} data-danger aria-label={`删除引擎能力 ${props.name}`}
                  onClick={() => setConfirmingDelete(true)}><IconTrashOutline16 /></button>
              </HintTooltip>
            ))}
          </span>
        )}
      </header>
      {expanded && !compact && <div className={styles.configForm}>{props.children}</div>}
    </article>
  )
}
