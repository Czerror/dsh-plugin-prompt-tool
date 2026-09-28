import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { measurePanelContentHeight, resolveAnchoredPopoverFit } from './anchored-popover-fit.ts'

/** body-portaled 浮层的统一定位：滚动、缩放和锚点/面板尺寸变化时重新测量。 */
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
  /** 最近一次测量：内容异步变化时补测（见下方第二次 useLayoutEffect）。 */
  const measureRef = useRef<() => void>(() => {})

  useLayoutEffect(() => {
    if (!open) {
      measureRef.current = () => {}
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
      const desiredHeight = Math.min(measurePanelContentHeight(panel), cap)
      const next = resolveAnchoredPopoverFit({
        anchorTop: anchor.top - titlebar,
        anchorBottom: anchor.bottom - titlebar,
        desiredHeight,
        viewportHeight: window.innerHeight - titlebar,
        gap,
        margin,
      })
      const maxHeight = Math.min(next.maxHeight, cap)
      const height = Math.min(desiredHeight, maxHeight)
      const width = panel.offsetWidth
      const left = Math.max(margin, Math.min(align === 'end' ? anchor.right - width : anchor.left, window.innerWidth - width - margin))
      const top = Math.max(margin + titlebar, Math.min(next.side === 'top' ? anchor.top - gap - height : anchor.bottom + gap, window.innerHeight - height - margin))
      setPosition((current) => current?.left === left && current.top === top && current.maxHeight === maxHeight ? current : { left, top, maxHeight })
    }
    measureRef.current = measure
    measure()
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    if (anchorRef.current !== null) observer?.observe(anchorRef.current)
    if (panelRef.current !== null) observer?.observe(panelRef.current)
    // 抽屉移动可能没有 scroll/resize；仅锚点位置改变时重算，不在每帧重测内容。
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

  // 面板被 max-height 锁住后，异步内容变高不会改变元素尺寸，ResizeObserver 不再触发
  // （模板列表首次打开为空、随后加载即此场景）；每次渲染补测一次，让 scrollHeight 重新参与计算。
  useLayoutEffect(() => {
    measureRef.current()
  })

  return position
}
