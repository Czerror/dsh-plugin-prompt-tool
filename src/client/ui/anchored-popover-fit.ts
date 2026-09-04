export interface AnchoredPopoverFit {
  side: 'top' | 'bottom'
  maxHeight: number
}

/** 选择空间更充足的一侧，并把面板高度限制在锚点与视口边缘之间。 */
export function resolveAnchoredPopoverFit(input: {
  anchorTop: number
  anchorBottom: number
  desiredHeight: number
  viewportHeight: number
  gap: number
  margin: number
}): AnchoredPopoverFit {
  const below = Math.max(0, input.viewportHeight - input.anchorBottom - input.gap - input.margin)
  const above = Math.max(0, input.anchorTop - input.gap - input.margin)
  const side = below >= input.desiredHeight || below >= above ? 'bottom' : 'top'
  return { side, maxHeight: Math.min(input.desiredHeight, side === 'bottom' ? below : above) }
}
