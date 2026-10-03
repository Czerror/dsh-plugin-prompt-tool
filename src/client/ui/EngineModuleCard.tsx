import { useId, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutlineRegular } from './icons.tsx'
import styles from './controls.module.css'
/** 独立展示使用折叠卡；层设置内直接展示具名字段区。 */
export function EngineModuleCard(props: {
  name: string
  meta: string
  layer?: string
  embedded?: boolean
  children?: ReactNode
  defaultExpanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
}): ReactNode {
  const [expanded, setExpanded] = useState(props.defaultExpanded ?? false)
  const panelId = useId()
  if (props.embedded) return (
    <section className={styles.moduleEmbedded} aria-labelledby={`${panelId}-title`}>
      <header className={styles.moduleEmbeddedHeader}>
        <h4 id={`${panelId}-title`} className={styles.moduleEmbeddedTitle}>{props.name}</h4>
        <span className={styles.configMeta}>{props.meta}</span>
      </header>
      <div className={styles.moduleEmbeddedBody}>{props.children}</div>
    </section>
  )
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
