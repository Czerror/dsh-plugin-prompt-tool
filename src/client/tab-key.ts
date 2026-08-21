/** ARIA tabs 键盘导航：左右切换、Home/End 跳首尾（顶层页、技能筛选、内容资产 tab 共用）。 */
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

export function tabKeyHandler<T>(
  items: readonly T[],
  current: T,
  onSelect: (item: T) => void,
): (event: ReactKeyboardEvent<HTMLElement>) => void {
  return (event) => {
    const index = items.indexOf(current)
    if (index < 0) return
    let next: number | undefined
    if (event.key === 'ArrowRight') next = (index + 1) % items.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    if (next === undefined) return
    event.preventDefault()
    onSelect(items[next]!)
  }
}
