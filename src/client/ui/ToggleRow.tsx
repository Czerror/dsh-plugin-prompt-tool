/** 开关行：label + hint + 可选 extra + 官方 Switch。 */
import type { ReactNode } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './controls.module.css'

export function ToggleRow(props: { id: string; label: string; hint: string; checked: boolean; disabled?: boolean; extra?: ReactNode; onChange: (value: boolean) => void }): ReactNode {
  return (
    <div className={styles.toggleRow}>
      <span className={styles.settingCopy} id={props.id}><strong>{props.label}</strong><small>{props.hint}</small></span>
      {props.extra}
      <Switch checked={props.checked} disabled={props.disabled} label={props.label} onChange={props.onChange} />
    </div>
  )
}
