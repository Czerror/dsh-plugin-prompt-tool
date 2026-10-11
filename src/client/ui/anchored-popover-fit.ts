export interface AnchoredPopoverFit {
  side: 'top' | 'bottom'
  maxHeight: number
}

/** 朝下仍可用的最小高度（px）：下方低于它就改上翻。固定值，不看内容——
 *  测量内容高度要求读写样式，会在滚动重测时产生副作用（见 anchored-popover.ts）。 */
const MIN_USABLE_HEIGHT = 160

/** 选择空间更充足的一侧，并把面板高度限制在锚点与视口边缘之间。
 *  只读锚点与视口：内容高的浮层在两侧都放不下时留在下方滚动，不会因为
 *  「上方空间更大」就把明明放得下的矮浮层翻上去。 */
export function resolveAnchoredPopoverFit(input: {
  anchorTop: number
  anchorBottom: number
  viewportHeight: number
  gap: number
  margin: number
}): AnchoredPopoverFit {
  const below = Math.max(0, input.viewportHeight - input.anchorBottom - input.gap - input.margin)
  const above = Math.max(0, input.anchorTop - input.gap - input.margin)
  const side = below >= MIN_USABLE_HEIGHT || below >= above ? 'bottom' : 'top'
  // maxHeight 只取可用空间上限：实际高度由内容决定，面板矮时不会撑满。
  return { side, maxHeight: side === 'bottom' ? below : above }
}
