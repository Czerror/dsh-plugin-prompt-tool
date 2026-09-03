import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from '../PromptUi.module.css'
/** 引擎模块可折叠卡片：与模块列表（PromptConfigList）同款形态——
 *  configCard + configToggle + chevron，点击展开 configForm 编辑组合行 config
 *  （经 params 参数桥扁平键落 preset.yml）。归类于配置列表下（beforeCards）。
 *  layer：6 层注入层级归类（pre-step / system-section / tool-pipeline），
 *  参与模块列表层筛选（layerFilter 联动）。 */
export function EngineModuleCard(props: {
  name: string
  meta: string
  layer?: string
  children?: ReactNode
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
  const compact = props.topSwitch !== undefined
  return (
    <article className={styles.configCard}>
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
        {props.topSwitch !== undefined && (
          <span className={styles.configHeaderActions}>
            <label className={styles.configEnable} htmlFor={props.topSwitch.id} title={props.topSwitch.hint}>
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
          </span>
        )}
      </header>
      {expanded && !compact && <div className={styles.configForm}>{props.children}</div>}
    </article>
  )
}
