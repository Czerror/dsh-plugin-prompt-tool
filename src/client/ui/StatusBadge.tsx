import type { ReactNode } from 'react'
import { StateDot, Tag, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './StatusBadge.module.css'

/** 状态色调：成功 / 中性 / 失败；同时驱动官方 StateDot 与 Tag 胶囊。 */
export type StatusBadgeTone = 'success' | 'neutral' | 'danger'

const DOT_STATE = { success: 'done', neutral: 'idle', danger: 'error' } as const satisfies Record<StatusBadgeTone, StateDotState>

/** 只读状态徽章：官方 StateDot + Tag，跨 feature 复用的唯一状态呈现形态。 */
export function StatusBadge(props: { tone: StatusBadgeTone; label: ReactNode; ariaLabel?: string }): ReactNode {
  return (
    <span className={css.badge} aria-label={props.ariaLabel}>
      <StateDot state={DOT_STATE[props.tone]} size={8} />
      <Tag tone={props.tone}>{props.label}</Tag>
    </span>
  )
}
