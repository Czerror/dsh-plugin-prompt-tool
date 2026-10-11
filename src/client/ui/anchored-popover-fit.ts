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
 *  panel.scrollHeight，把直接子级的溢出量加回来即可。
 *  不临时解除 max-height：解除会让滚动容器瞬时不再溢出，同步回流时浏览器随即把它的
 *  scrollTop 钳回 0；滚动本身又会触发重测，于是面板内怎么滚都弹回顶部。 */
export function measurePanelContentHeight(panel: {
  scrollHeight: number
  offsetHeight: number
  children: ArrayLike<{ scrollHeight: number; clientHeight: number }>
}): number {
  let height = Math.max(panel.scrollHeight, panel.offsetHeight)
  for (const child of Array.from(panel.children)) height += Math.max(0, child.scrollHeight - child.clientHeight)
  return height
}
