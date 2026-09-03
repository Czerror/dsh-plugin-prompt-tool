/** textarea 随内容自适应高度（field-sizing 的 JS 兜底：不支持的内核手动调整）。 */
import type { ChangeEvent } from 'react'

export function autoResizeTextarea(event: ChangeEvent<HTMLTextAreaElement>): void {
  const el = event.currentTarget
  if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content')) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}
