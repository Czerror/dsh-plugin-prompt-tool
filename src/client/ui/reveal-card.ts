/** 新建对象后的滚动定位（与"过滤"彻底分离）。
 *
 *  纪律：过滤下拉与搜索词只由用户手动改变；新建动作只做两件事——
 *  ① 展开新卡（由调用方设置展开状态）；② 滚动定位到新卡（本模块）。
 *  因此这里只读取目标锚点，绝不改动任何筛选状态；锚点选择器由调用方内联给出。
 */

/** 滚动重试间隔与上限：节点由异步描述符驱动，尚未渲染时按固定间隔重试，超时静默退出。 */
const SCROLL_RETRY_MS = 80
const SCROLL_MAX_ATTEMPTS = 25

/**
 * 转义 id 以安全嵌入 CSS 属性选择器。
 *
 * @param id - 目录配置 id 或引擎能力 id。
 * @returns 可安全用于 `[data-*="…"]` 的转义结果。
 */
export const cssEscapeId = (id: string): string => CSS.escape(id)

/**
 * 滚动定位到指定锚点；节点尚未渲染时按固定间隔重试，超时静默退出。
 *
 * @param selector - 目标卡片的 CSS 选择器。
 * @returns 清理函数：取消尚未触发的重试与待执行的滚动。
 */
export function scrollToCreatedCard(selector: string): () => void {
  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let frame: number | undefined
  const attempt = (): void => {
    const target = document.querySelector(selector)
    if (target === null) {
      attempts += 1
      if (attempts <= SCROLL_MAX_ATTEMPTS) timer = setTimeout(attempt, SCROLL_RETRY_MS)
      return
    }
    // 等一帧再滚：让展开后的内容完成布局，避免定位到未展开高度。
    frame = requestAnimationFrame(() => {
      // 无效的块级对齐在实现上等价于 auto（可能整页跳动）；先试 nearest，失败再退化为整体滚动。
      try {
        target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      } catch {
        target.scrollIntoView()
      }
    })
  }
  attempt()
  return () => {
    if (timer !== undefined) clearTimeout(timer)
    if (frame !== undefined) cancelAnimationFrame(frame)
  }
}
