import { useId, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './controls.module.css'
/** 模型路由、人设和子代理参数共用的可折叠卡片。 */
export function EngineModuleCard(props: {
  name: string
  meta: string
  layer?: string
  children?: ReactNode
  defaultExpanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
}): ReactNode {
  const [expanded, setExpanded] = useState(props.defaultExpanded ?? false)
  const panelId = useId()
  const title = <span className={styles.configTitle}>
    <span className={styles.configTitleRow}>
      <span className={styles.configName}>{props.name}</span>
      {props.layer !== undefined && <span className={styles.configChip}>{props.layer}</span>}
    </span>
    <span className={styles.configMeta}>{props.meta}</span>
  </span>
  return (
    <article className={clsx(styles.configCard, styles.moduleCard, expanded && styles.configCardOpen)}>
      <header className={styles.configHeader}>
        <button type="button" className={styles.configToggle} aria-expanded={expanded} aria-controls={panelId} onClick={() => {
          setExpanded(!expanded)
          props.onExpandedChange?.(!expanded)
        }}>
          {title}<IconChevronDownOutlineRegular className={clsx(styles.chevron, expanded && styles.chevronOpen)} />
        </button>
      </header>
      <div id={panelId} hidden={!expanded} className={styles.configForm}>{expanded && props.children}</div>
    </article>
  )
}
