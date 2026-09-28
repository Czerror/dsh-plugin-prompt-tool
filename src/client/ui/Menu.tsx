import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { useAnchoredPopoverStyle } from './anchored-popover.ts'
import { useDismissOnOutsidePointer } from './outside-pointer.ts'
import css from './Menu.module.css'

export type MenuEntry = { id: string; label: ReactNode; disabled?: boolean; danger?: boolean }
  | { id: string; type: 'label'; text: string }

/** 工作台使用的单层菜单；body portal、定位和键盘行为由插件持有。 */
export function Menu({ open, anchor, items, selectedId, onSelect, onClose, align = 'start', compact = false, className }: {
  open: boolean
  anchor: ReactNode
  items: readonly MenuEntry[]
  selectedId?: string
  onSelect: (id: string) => void
  onClose: () => void
  align?: 'start' | 'end'
  compact?: boolean
  className?: string
}): ReactNode {
  const rootRef = useRef<HTMLSpanElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPopoverStyle({ open, anchorRef: rootRef, panelRef: listRef, gap: 4, align, maxViewportRatio: 1 })
  useDismissOnOutsidePointer(rootRef, open, () => onClose(), listRef)
  const focusTrigger = (): void => { rootRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }

  useEffect(() => {
    if (!open) return
    // 定位完成的可见帧再聚焦，避免浏览器拒绝隐藏 portal 的 focus。
    const frame = requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus())
    const blur = (): void => { if (document.activeElement instanceof HTMLIFrameElement) onClose() }
    window.addEventListener('blur', blur)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('blur', blur) }
  }, [open])

  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>): void => {
    if (!open || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
    if (event.target instanceof Node && !rootRef.current?.contains(event.target) && !listRef.current?.contains(event.target)) return
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      // 输入法候选的 Escape/导航不能冒泡成外层弹窗关闭。
      if (['Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) event.stopPropagation()
      return
    }
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.stopPropagation()
      if (event.key === 'Escape') event.preventDefault()
      onClose()
      focusTrigger()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    if (buttons.length === 0) return
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : current < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    event.preventDefault()
    event.stopPropagation()
    buttons[next]?.focus()
  }
  return <span ref={rootRef} className={clsx(css.root, className)} onKeyDown={onKeyDown}>
    {anchor}
    {open && typeof document !== 'undefined' && createPortal(
      <div ref={listRef} className={clsx(css.list, compact && css.compact)} role="menu"
        style={position ?? { visibility: 'hidden', left: 0, top: 0 }} onClick={(event) => event.stopPropagation()}>
        {items.map((item) => 'type' in item
          ? <div key={item.id} className={css.label} role="presentation">{item.text}</div>
          : <button key={item.id} type="button" role={selectedId === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={selectedId === undefined ? undefined : selectedId === item.id}
            className={clsx(css.item, item.danger && css.danger)} disabled={item.disabled} onClick={() => {
              focusTrigger()
              onSelect(item.id)
            }}>
            <span className={css.itemLabel}>{item.label}</span>
            {selectedId === item.id && <span aria-hidden="true">✓</span>}
          </button>)}
      </div>, document.body)}
  </span>
}
