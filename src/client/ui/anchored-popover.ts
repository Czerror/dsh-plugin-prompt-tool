import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'
import { useAnchoredPosition } from '@deepseek-ai/dsh-client-ui-primitives'
import { resolveAnchoredPopoverFit } from './anchored-popover-fit.ts'
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

  useLayoutEffect(() => {
    if (!open) {
      setFit(null)
      return
    }
    const measure = (): void => {
      const anchor = anchorRef.current?.getBoundingClientRect()
      const panel = panelRef.current
      if (anchor === undefined || panel === null) return
      const cap = Math.floor(window.innerHeight * maxViewportRatio)
      const desiredHeight = Math.min(Math.max(panel.scrollHeight, panel.offsetHeight), cap)
      const next = resolveAnchoredPopoverFit({
        anchorTop: anchor.top,
        anchorBottom: anchor.bottom,
        desiredHeight,
        viewportHeight: window.innerHeight,
        gap,
        margin,
      })
      setFit((current) => current?.side === next.side && current.maxHeight === next.maxHeight ? current : next)
    }
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
