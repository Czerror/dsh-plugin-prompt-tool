import clsx from 'clsx'
import css from './primitives.module.css'

/** 受控开关：原生按钮承担 Enter/Space，视觉状态直接使用 aria-checked。 */
export function Switch({ checked, onChange, label, disabled, className }: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
  className?: string
}) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label}
    disabled={disabled} className={clsx(css.switch, className)} onClick={() => onChange(!checked)}>
    <span className={css.switchTrack} aria-hidden="true"><span className={css.thumb} /></span>
  </button>
}
