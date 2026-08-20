/** 开关行：label + hint + 可选 extra + checkbox。 */
import type { ReactNode } from 'react'
import styles from './PromptUi.module.css'

export function ToggleRow(props: { id: string; label: string; hint: string; checked: boolean; disabled?: boolean; extra?: ReactNode; onChange: (value: boolean) => void }): ReactNode {
  return (
    <label className={styles.toggleRow} htmlFor={props.id}>
      <span className={styles.settingCopy}><strong>{props.label}</strong><small>{props.hint}</small></span>
      {props.extra}
      <input id={props.id} type="checkbox" aria-label={props.label} checked={props.checked} disabled={props.disabled} onChange={(event) => props.onChange(event.target.checked)} />
      <span className={styles.switch} aria-hidden="true"><i /></span>
    </label>
  )
}
