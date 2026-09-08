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
  // maxHeight 只取可用空间上限：实际高度由内容决定。若把首帧内容高度也算进来，
  // 异步内容（模板列表）加载后会被锁死在初始高度。
  return { side, maxHeight: side === 'bottom' ? below : above }
}

/** 测量面板真实内容高度：面板可能已被 max-height 限制，内部滚动容器的溢出不计入
 *  panel.scrollHeight，直接测量只会得到被裁剪后的高度；先临时解除限制再量。
 *  同步读写不产生可见闪烁，测量后恢复原值。 */
export function measurePanelContentHeight(panel: {
  style: { maxHeight: string }
  scrollHeight: number
  offsetHeight: number
}): number {
  const applied = panel.style.maxHeight
  panel.style.maxHeight = 'none'
  const height = Math.max(panel.scrollHeight, panel.offsetHeight)
  panel.style.maxHeight = applied
  return height
}
