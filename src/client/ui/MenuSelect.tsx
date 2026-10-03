import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutlineRegular } from './icons.tsx'
import { Menu, type MenuEntry } from './Menu.tsx'
import { controlWidth } from './control-width.ts'
import styles from './controls.module.css'

export interface MenuSelectOption {
  value: string
  label: string
  disabled?: boolean
  /** 连续相同 group 的选项显示分组标题。 */
  group?: string
}

/** 紧凑单选控件，保留未知值与分组。 */
export function MenuSelect(props: {
  value: string
  options: readonly MenuSelectOption[]
  onChange: (value: string) => void
  /** 由关闭切到打开时调用：调用方据此在展开瞬间重新拉取选项，无需独立刷新按钮。 */
  onOpen?: () => void
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
  const pointerBeganInside = useRef(true)
  const ownsFocus = useRef(false)
  const disabled = props.disabled === true
  const compact = props.compact === true
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
      label: option.label,
      ...(option.disabled !== undefined ? { disabled: option.disabled } : {}),
    })
    return entries
  })

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  return (
    <span className={styles.menuSelectOwner} style={compact ? { width: controlWidth([selected?.label ?? (props.value || props.placeholder || '（未选择）'), ...props.options.map(option => option.label)], 48, 4, 26), flex: '0 1 auto', minWidth: 0, maxWidth: '100%', font: '12px/18px system-ui, sans-serif' } : undefined} onBlur={(event) => {
      const next = event.relatedTarget
      if (next instanceof Node && event.currentTarget.contains(next)) return
      ownsFocus.current = false
      // 原生鼠标的focusout与focusin之间会执行微任务，须等焦点转移结束，避免卸载待点击选项。
      requestAnimationFrame(() => { if (!ownsFocus.current) setOpen(false) })
    }} onFocus={() => { ownsFocus.current = true }}>
    <Menu
      open={open && !disabled}
      compact={compact}
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
          onPointerDown={(event) => {
            // 触屏会把邻近点击重定向到按钮；以原始落点保证可点击区域不越过可见边框。
            const rect = event.currentTarget.getBoundingClientRect()
            pointerBeganInside.current = event.clientX >= rect.left && event.clientX <= rect.right
              && event.clientY >= rect.top && event.clientY <= rect.bottom
            if (!pointerBeganInside.current) event.preventDefault()
          }}
          onPointerCancel={() => { pointerBeganInside.current = true }}
          onClick={(event) => {
            const inside = pointerBeganInside.current
            pointerBeganInside.current = true
            if (event.detail !== 0 && !inside) return
            // 副作用留在事件处理器里，不进 setState 的 updater（StrictMode 会双调用 updater）。
            if (!open) props.onOpen?.()
            setOpen(!open)
          }}
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
