import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { useAnchoredPosition } from '@deepseek-ai/dsh-client-ui-primitives'
import { measurePanelContentHeight, resolveAnchoredPopoverFit } from './anchored-popover-fit.ts'
import type { AnchoredPopoverFit } from './anchored-popover-fit.ts'

/** body-portaled 浮层的统一定位：滚动、缩放和锚点/面板尺寸变化时重新测量。 */
export function useAnchoredPopoverStyle(options: {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  panelRef: RefObject<HTMLElement | null>
  gap?: number
  margin?: number
  maxViewportRatio?: number
}): CSSProperties | null {
  const { open, anchorRef, panelRef, gap = 8, margin = 12, maxViewportRatio = 0.72 } = options
  const [fit, setFit] = useState<AnchoredPopoverFit | null>(null)
  /** 最近一次测量：内容异步变化时补测（见下方第二次 useLayoutEffect）。 */
  const measureRef = useRef<() => void>(() => {})

  useLayoutEffect(() => {
    if (!open) {
      measureRef.current = () => {}
      setFit(null)
      return
    }
    const measure = (): void => {
      const anchor = anchorRef.current?.getBoundingClientRect()
      const panel = panelRef.current
      if (anchor === undefined || panel === null) return
      const cap = Math.floor(window.innerHeight * maxViewportRatio)
      const desiredHeight = Math.min(measurePanelContentHeight(panel), cap)
      const next = resolveAnchoredPopoverFit({
        anchorTop: anchor.top,
        anchorBottom: anchor.bottom,
        desiredHeight,
        viewportHeight: window.innerHeight,
        gap,
        margin,
      })
      const maxHeight = Math.min(next.maxHeight, cap)
      setFit((current) => current?.side === next.side && current.maxHeight === maxHeight ? current : { side: next.side, maxHeight })
    }
    measureRef.current = measure
    measure()
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    if (anchorRef.current !== null) observer?.observe(anchorRef.current)
    if (panelRef.current !== null) observer?.observe(panelRef.current)
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [open, anchorRef, panelRef, gap, margin, maxViewportRatio])

  // 面板被 max-height 锁住后，异步内容变高不会改变元素尺寸，ResizeObserver 不再触发
  // （模板列表首次打开为空、随后加载即此场景）；每次渲染补测一次，让 scrollHeight 重新参与计算。
  useLayoutEffect(() => {
    measureRef.current()
  })

  const position = useAnchoredPosition({
    open: open && fit !== null,
    anchorRef,
    panelRef,
    side: fit?.side ?? 'bottom',
    gap,
    margin,
  })
  if (fit === null) return null
  return position === null
    ? { visibility: 'hidden', maxHeight: fit.maxHeight }
    : { ...position, maxHeight: fit.maxHeight }
}
