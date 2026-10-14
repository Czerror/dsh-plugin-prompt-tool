import clsx from 'clsx'
import { useContext } from 'react'
import { AutoSaveSelection } from './AutoSaveSelection.ts'
import css from './primitives.module.css'

/** 受控开关：原生按钮承担 Enter/Space，视觉状态直接使用 aria-checked。 */
export function Switch({ checked, onChange, label, disabled, className }: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
  className?: string
}) {
  const commitSelection = useContext(AutoSaveSelection)
  return <button type="button" role="switch" aria-checked={checked} aria-label={label}
    disabled={disabled} className={clsx(css.switch, className)} onClick={() => { onChange(!checked); if (commitSelection) queueMicrotask(commitSelection) }}>
    <span className={css.switchTrack} aria-hidden="true"><span className={css.thumb} /></span>
  </button>
}
