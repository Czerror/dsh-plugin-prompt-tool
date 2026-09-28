import type { ReactNode } from 'react'
import clsx from 'clsx'
import { StatusDot, type StatusDotTone } from './StatusDot.tsx'
import css from './StatusBadge.module.css'

/** 状态色调同时驱动共享 StatusDot 与状态胶囊。 */
export type StatusBadgeTone = StatusDotTone

/** 只读状态徽章：跨 feature 复用的状态呈现。 */
export function StatusBadge(props: {
  tone: StatusBadgeTone
  label: ReactNode
  ariaLabel?: string
  className?: string
}): ReactNode {
  return (
    <span className={clsx(css.badge, props.className)} aria-label={props.ariaLabel}>
      <StatusDot tone={props.tone} />
      <span className={css.tag} data-tone={props.tone}>{props.label}</span>
    </span>
  )
}
