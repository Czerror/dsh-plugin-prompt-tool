import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutlineRegular, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { useMenuFocus } from './menu-focus.ts'
import styles from './controls.module.css'

export interface MenuSelectOption {
  value: string
  label: string
  disabled?: boolean
  /** 连续相同 group 的选项会在官方 Menu 中显示分组标题。 */
  group?: string
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
  id?: string
  'aria-invalid'?: boolean
  'aria-describedby'?: string
}): ReactNode {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const ownsFocus = useRef(false)
  const disabled = props.disabled === true
  const compact = props.compact === true
  const firstItemRef = useMenuFocus(open && !disabled)
  const firstEnabledIndex = props.options.findIndex((option) => !option.disabled)
  const selected = props.options.find((option) => option.value === props.value)
  let previousGroup: string | undefined
  const items: MenuEntry[] = props.options.flatMap((option, index) => {
    const entries: MenuEntry[] = []
    if (option.group !== undefined && option.group.length > 0 && option.group !== previousGroup) {
      entries.push({ type: 'label', id: `group-${index}`, text: option.group })
    }
    previousGroup = option.group
    entries.push({
      id: option.value,
      label: <span ref={index === firstEnabledIndex ? firstItemRef : undefined}>{option.label}</span>,
      ...(option.disabled !== undefined ? { disabled: option.disabled } : {}),
    })
    return entries
  })

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  return (
    <span className={styles.menuSelectOwner} onKeyDown={(event) => {
      if (!open || (event.key !== 'Escape' && event.key !== 'Tab')) return
      event.stopPropagation()
      if (event.key === 'Escape') event.preventDefault()
      triggerRef.current?.focus()
      setOpen(false)
    }} onBlur={(event) => {
      const next = event.relatedTarget
      if (next instanceof Node && (event.currentTarget.contains(next) || firstItemRef.current?.closest('[role="menu"]')?.contains(next))) return
      ownsFocus.current = false
      // 原生鼠标的focusout与focusin之间会执行微任务，须等焦点转移结束，避免卸载待点击选项。
      requestAnimationFrame(() => { if (!ownsFocus.current) setOpen(false) })
    }} onFocus={() => { ownsFocus.current = true }}>
    <Menu
      open={open && !disabled}
      compact={compact}
      portal
      autoFocus
      align={props.align ?? 'end'}
      className={clsx(styles.menuSelect, compact ? styles.menuSelectCompact : styles.menuSelectStandard, props.className)}
      items={items}
      selectedId={props.value}
      onClose={() => setOpen(false)}
      onSelect={(value) => {
        setOpen(false)
        triggerRef.current?.focus()
        if (triggerRef.current?.matches(':disabled')) return
        if (value !== props.value) props.onChange(value)
      }}
      anchor={(
        <button
          ref={triggerRef}
          id={props.id}
          type="button"
          className={clsx(styles.menuSelectTrigger, compact ? styles.menuSelectTriggerCompact : styles.menuSelectTriggerStandard)}
          aria-label={props.ariaLabel}
          aria-haspopup="menu"
          aria-expanded={open && !disabled}
          aria-invalid={props['aria-invalid']}
          aria-describedby={props['aria-describedby']}
          disabled={disabled}
          onClick={() => setOpen((value) => !value)}
        >
          <span className={styles.menuSelectLabel}>
            {selected?.label ?? (props.value.length > 0 ? props.value : props.placeholder ?? '（未选择）')}
          </span>
          <IconChevronDownOutlineRegular className={styles.menuSelectChevron} />
        </button>
      )}
    />
    </span>
  )
}
