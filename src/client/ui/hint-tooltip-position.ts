export type HintTooltipPosition =
  | { kind: 'pointer'; x: number; y: number }
  | { kind: 'focus'; left: number; right: number; centerY: number }

const clamp = (value: number, min: number, max: number): number =>
  max < min ? min : Math.min(Math.max(value, min), max)

/** 把说明浮窗贴近指针或聚焦控件，并限制在视口内。 */
export function fitHintTooltipPosition(
  position: HintTooltipPosition,
  bubble: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const edge = 12
  const gap = 12
  let left = position.kind === 'pointer' ? position.x + gap : position.right + 10
  let top = position.kind === 'pointer' ? position.y + gap : position.centerY - bubble.height / 2
  if (left + bubble.width > viewport.width - edge) {
    left = position.kind === 'pointer' ? position.x - bubble.width - gap : position.left - bubble.width - 10
  }
  if (top + bubble.height > viewport.height - edge && position.kind === 'pointer') {
    top = position.y - bubble.height - gap
  }
  return {
    left: clamp(left, edge, viewport.width - edge - bubble.width),
    top: clamp(top, edge, viewport.height - edge - bubble.height),
  }
}
