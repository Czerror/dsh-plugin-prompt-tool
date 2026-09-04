import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './controls.module.css'

export interface MenuSelectOption {
  value: string
  label: string
  disabled?: boolean
}

/** 官方 Menu 外观的紧凑单选控件。 */
export function MenuSelect(props: {
  value: string
  options: readonly MenuSelectOption[]
  onChange: (value: string) => void
  ariaLabel: string
  disabled?: boolean
  placeholder?: string
  className?: string
  align?: 'start' | 'end'
  compact?: boolean
}): ReactNode {
  const [open, setOpen] = useState(false)
  const disabled = props.disabled === true
  const compact = props.compact === true
  const selected = props.options.find((option) => option.value === props.value)

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  return (
    <Menu
      open={open && !disabled}
      compact={compact}
      portal
      align={props.align ?? 'end'}
      className={clsx(styles.menuSelect, compact ? styles.menuSelectCompact : styles.menuSelectStandard, props.className)}
      items={props.options.map((option) => ({
        id: option.value,
        label: option.label,
        ...(option.disabled !== undefined ? { disabled: option.disabled } : {}),
      }))}
      selectedId={props.value}
      onClose={() => setOpen(false)}
      onSelect={(value) => {
        setOpen(false)
        if (value !== props.value) props.onChange(value)
      }}
      anchor={(
        <button
          type="button"
          className={clsx(styles.menuSelectTrigger, compact ? styles.menuSelectTriggerCompact : styles.menuSelectTriggerStandard)}
          aria-label={props.ariaLabel}
          aria-haspopup="menu"
          aria-expanded={open && !disabled}
          disabled={disabled}
          onClick={() => setOpen((value) => !value)}
        >
          <span className={styles.menuSelectLabel}>
            {selected?.label ?? (props.value.length > 0 ? props.value : props.placeholder ?? '（未选择）')}
          </span>
          <IconChevronDownOutline14 className={styles.menuSelectChevron} />
        </button>
      )}
    />
  )
}
