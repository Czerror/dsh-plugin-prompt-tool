import type { ReactNode } from 'react'
import css from './StatusDot.module.css'

/** 状态色调：成功 / 中性 / 失败 / 警告。 */
export type StatusDotTone = 'success' | 'neutral' | 'danger' | 'warning'

/** 实心状态圆点与柔和静态光晕，状态含义由相邻文字提供。 */
export function StatusDot(props: { tone: StatusDotTone }): ReactNode {
  return <i className={css.dot} data-tone={props.tone} aria-hidden="true" />
}
