import type { ReactNode } from 'react'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './StatusBadge.module.css'

/** 状态色调：成功 / 信息 / 中性 / 失败；同时驱动圆点与官方 Tag 胶囊。 */
export type StatusBadgeTone = 'success' | 'info' | 'neutral' | 'danger'

/** 只读状态徽章：8px 圆点 + 官方 Tag，跨 feature 复用的唯一状态呈现形态。 */
export function StatusBadge(props: { tone: StatusBadgeTone; label: ReactNode; ariaLabel?: string }): ReactNode {
  return (
    <span className={css.badge} aria-label={props.ariaLabel}>
      <i className={css.dot} data-tone={props.tone} aria-hidden="true" />
      <Tag tone={props.tone}>{props.label}</Tag>
    </span>
  )
}
