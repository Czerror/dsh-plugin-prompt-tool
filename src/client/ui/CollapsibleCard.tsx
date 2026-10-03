/** 通用折叠卡片：设置区块统一折叠入口（除模块列表外全部卡片化）。 */
import { useId, useState, type HTMLAttributes, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutlineRegular } from './icons.tsx'
import styles from './controls.module.css'

export function CollapsibleCard(props: Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  id: string
  title: string
  meta?: string
  children: ReactNode
  defaultOpen?: boolean
  expanded?: boolean
  onToggle?: (expanded: boolean) => void
  actions?: ReactNode
  bodyClassName?: string
}): ReactNode {
  const { id, title, meta, children, defaultOpen, expanded, onToggle, actions, bodyClassName, className, ...attributes } = props
  const [localOpen, setOpen] = useState(defaultOpen ?? false)
  const open = expanded ?? localOpen
  const panelId = useId()
  return (
    <article {...attributes} id={id} className={clsx(styles.configCard, open && styles.configCardOpen, className)}>
      <header className={styles.configHeader}>
        <button type="button" className={styles.configToggle} aria-expanded={open} aria-controls={panelId} onClick={() => { if (expanded === undefined) setOpen(!open); onToggle?.(!open) }}>
          <span className={styles.configTitle}>
            <span className={styles.configName}>{title}</span>
            {meta !== undefined && <span className={styles.configMeta}>{meta}</span>}
          </span>
          <IconChevronDownOutlineRegular className={clsx(styles.chevron, open && styles.chevronOpen)} />
        </button>
        {actions !== undefined && <span className={styles.configHeaderActions}>{actions}</span>}
      </header>
      <div id={panelId} hidden={!open} className={bodyClassName ?? styles.configForm}>{open && children}</div>
    </article>
  )
}
