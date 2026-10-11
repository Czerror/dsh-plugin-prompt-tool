import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'
import { resolveAnchoredPopoverFit } from './anchored-popover-fit.ts'

/** body-portaled 浮层的统一定位：滚动、缩放和锚点/面板尺寸变化时重新测量。
 *  只读锚点、视口和面板宽度，不读内容高度——高度上限由可用空间给出，面板按内容生长。
 *  这里刻意不测量内容：测量要临时改样式，同步回流会把面板内的 scrollTop 钳回 0，
 *  而滚动本身又会触发重测，浮层里就再也滚不动。 */
export function useAnchoredPopoverStyle(options: {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  panelRef: RefObject<HTMLElement | null>
  gap?: number
  margin?: number
  maxViewportRatio?: number
  align?: 'start' | 'end'
}): CSSProperties | null {
  const { open, anchorRef, panelRef, gap = 8, margin = 12, maxViewportRatio = 0.72, align = 'start' } = options
  const [position, setPosition] = useState<CSSProperties | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const measure = (): void => {
      const anchor = anchorRef.current?.getBoundingClientRect()
      const panel = panelRef.current
      if (anchor === undefined || panel === null) return
      // 桌面标题栏是公开窗口几何；从自己的面板读取继承值，不查询宿主 DOM。
      const titlebar = Math.max(0, Number.parseFloat(getComputedStyle(panel).getPropertyValue('--dsh-windows-titlebar-height')) || 0)
      const cap = Math.max(0, Math.min(Math.floor(window.innerHeight * maxViewportRatio), window.innerHeight - titlebar - margin * 2))
      const next = resolveAnchoredPopoverFit({
        anchorTop: anchor.top - titlebar,
        anchorBottom: anchor.bottom - titlebar,
        viewportHeight: window.innerHeight - titlebar,
        gap,
        margin,
      })
      const maxHeight = Math.min(next.maxHeight, cap)
      const width = panel.offsetWidth
      const left = Math.max(margin, Math.min(align === 'end' ? anchor.right - width : anchor.left, window.innerWidth - width - margin))
      // 朝下沿用顶边贴锚点：maxHeight 不超过下方可用空间，面板底边不会越出视口。
      // 朝上改用 bottom 定位让底边贴锚点，面板按内容向上生长——不测高度也能贴紧。
      const edge: CSSProperties = next.side === 'top'
        ? { bottom: Math.max(margin + titlebar, window.innerHeight - (anchor.top - gap)) }
        : { top: Math.max(margin + titlebar, anchor.bottom + gap) }
      setPosition((current) => current?.left === left && current.top === edge.top
        && current.bottom === edge.bottom && current.maxHeight === maxHeight
        ? current
        : { left, maxHeight, ...edge })
    }
    measure()
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    // 面板宽度参与左右夹取，锚点与面板的尺寸变化都要重算。
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    if (anchorRef.current !== null) observer?.observe(anchorRef.current)
    if (panelRef.current !== null) observer?.observe(panelRef.current)
    // 抽屉移动可能没有 scroll/resize；仅锚点位置改变时重算，不在每帧测量。
    let previous = anchorRef.current?.getBoundingClientRect()
    let frame = 0
    const track = (): void => {
      const current = anchorRef.current?.getBoundingClientRect()
      if (current?.left !== previous?.left || current?.top !== previous?.top || current?.width !== previous?.width || current?.height !== previous?.height) {
        previous = current
        measure()
      }
      frame = requestAnimationFrame(track)
    }
    frame = requestAnimationFrame(track)
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [open, anchorRef, panelRef, gap, margin, maxViewportRatio, align])

  return position
}
