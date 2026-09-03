/** ARIA tabs 键盘导航：左右切换、Home/End 跳首尾（顶层页、技能筛选共用）。 */
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

/** 纯索引算法：无效索引、空列表或非导航键均不产生目标。 */
export function nextTabIndex(length: number, current: number, key: string): number | undefined {
  if (length <= 0 || current < 0 || current >= length) return undefined
  if (key === 'ArrowRight') return (current + 1) % length
  if (key === 'ArrowLeft') return (current - 1 + length) % length
  if (key === 'Home') return 0
  if (key === 'End') return length - 1
  return undefined
}

export function tabKeyHandler<T>(
  items: readonly T[],
  current: T,
  onSelect: (item: T) => void,
): (event: ReactKeyboardEvent<HTMLElement>) => void {
  return (event) => {
    const next = nextTabIndex(items.length, items.indexOf(current), event.key)
    if (next === undefined) return
    event.preventDefault()
    onSelect(items[next]!)
  }
}
