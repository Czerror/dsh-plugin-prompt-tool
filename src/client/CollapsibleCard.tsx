/** 通用折叠卡片：设置区块统一折叠入口（除模块列表外全部卡片化）。 */
import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './PromptUi.module.css'

export function CollapsibleCard(props: {
  id: string
  title: string
  meta?: string
  children: ReactNode
  defaultOpen?: boolean
}): ReactNode {
  const [open, setOpen] = useState(props.defaultOpen ?? false)
  return (
    <article className={clsx(styles.configCard, open && styles.configCardOpen)}>
      <header className={styles.configHeader}>
        <button type="button" className={styles.configToggle} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <span className={styles.configTitle}>
            <span className={styles.configName}>{props.title}</span>
            {props.meta !== undefined && <span className={styles.configMeta}>{props.meta}</span>}
          </span>
          <IconChevronDownOutline14 className={clsx(styles.chevron, open && styles.chevronOpen)} />
        </button>
      </header>
      {open && <div className={styles.configForm}>{props.children}</div>}
    </article>
  )
}
