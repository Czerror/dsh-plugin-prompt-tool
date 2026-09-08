import type { ReactNode } from 'react'
import css from './StatusDot.module.css'

/** 状态色调：成功 / 中性 / 失败。 */
export type StatusDotTone = 'success' | 'neutral' | 'danger'

/** 状态圆点：实心核心 + 同色光晕；工作台顶部在线指示与状态徽章共用。 */
export function StatusDot(props: { tone: StatusDotTone; pulse?: boolean }): ReactNode {
  return <i className={css.dot} data-tone={props.tone} data-pulse={props.pulse === true ? '' : undefined} aria-hidden="true" />
}
