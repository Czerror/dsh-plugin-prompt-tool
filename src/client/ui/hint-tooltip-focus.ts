/** 指针按下后多久内的 focus 视为鼠标点击聚焦（点击到 focus 通常间隔几十毫秒）。 */
export const POINTER_FOCUS_WINDOW_MS = 500

/** 聚焦说明是否应锁定显示：只有键盘聚焦（Tab / :focus-visible）才算。
 *  鼠标点击按钮同样会触发 focus，若照此显示，点击后按钮失焦或卸载
 *  会让浮窗在按钮旁边闪一次。选择器查询不可用时保守按键盘聚焦处理。 */
export function isKeyboardFocus(element: { matches?: (selector: string) => boolean }): boolean {
  if (typeof element.matches !== 'function') return true
  try {
    return element.matches(':focus-visible')
  } catch {
    return true
  }
}

/** 是否锁定聚焦说明：刚发生指针按下（鼠标点击）一律不锁定——checkbox 等控件
 *  点击后也会匹配 :focus-visible，只靠选择器无法区分。 */
export function shouldLockFocus(options: {
  element: { matches?: (selector: string) => boolean }
  pointerDownAt: number
  now: number
}): boolean {
  if (options.now - options.pointerDownAt < POINTER_FOCUS_WINDOW_MS) return false
  return isKeyboardFocus(options.element)
}
