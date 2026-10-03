import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutlineRegular } from './icons.tsx'
import { Menu, type MenuEntry } from './Menu.tsx'
import { Button } from './Button.tsx'
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
  'aria-labelledby'?: string
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
    <span className={styles.menuSelectOwner} onBlur={(event) => {
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
      className={clsx(styles.menuSelect, props.className)}
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
        <Button
          ref={triggerRef}
          id={props.id}
          shape="pill"
          variant="outline"
          size={compact ? 'sm' : 'md'}
          className={styles.menuSelectTrigger}
          aria-label={props.ariaLabel}
          aria-labelledby={props['aria-labelledby']}
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
        </Button>
      )}
    />
    </span>
  )
}
