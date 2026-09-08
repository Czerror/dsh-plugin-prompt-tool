import type { ReactNode } from 'react'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { StatusDot, type StatusDotTone } from './StatusDot.tsx'
import css from './StatusBadge.module.css'

/** 状态色调：成功 / 中性 / 失败；同时驱动共享 StatusDot 与官方 Tag 胶囊。 */
export type StatusBadgeTone = StatusDotTone

/** 只读状态徽章：共享 StatusDot + 官方 Tag，跨 feature 复用的唯一状态呈现形态。 */
export function StatusBadge(props: { tone: StatusBadgeTone; label: ReactNode; ariaLabel?: string }): ReactNode {
  return (
    <span className={css.badge} aria-label={props.ariaLabel}>
      <StatusDot tone={props.tone} />
      <Tag tone={props.tone}>{props.label}</Tag>
    </span>
  )
}
