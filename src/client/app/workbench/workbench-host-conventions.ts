/**
 * 工作台的非官方宿主约定：侧栏行 DOM 拦截与跨插件面板互斥事件。
 *
 * 两者都是宿主接入面（一个依赖行结构，一个依赖事件总线），合并在这里便于宿主
 * 接口变化时整体替换；官方 slot 注册仍在 register-workbench，portal/焦点循环
 * 留在 WorkbenchOverlay。
 */
const PANEL_EVENT = 'dsh-panel-activate'
const OTHER_PANELS = new Set(['taskboard', 'ssh'])

export interface WorkbenchHostConventions {
  /** 侧栏行点击拦截；找不到宿主行时返回空 disposer。 */
  interceptSidebarRow(icon: Element | null, open: () => void): () => void
  /** 与其他面板互斥：监听 taskboard / ssh，打开时派发自己的事件。 */
  installPanelExclusion(controller: { close(): void }): () => void
}

/** `target` 只供测试注入；生产在浏览器里默认用 document。 */
export function createWorkbenchHostConventions(target?: EventTarget): WorkbenchHostConventions {
  return {
    interceptSidebarRow(icon, open) {
      const row = icon?.closest('button')
      if (row === null || row === undefined) return () => {}
      const onClick = (event: Event): void => {
        event.stopPropagation()
        open()
      }
      row.addEventListener('click', onClick)
      return () => { row.removeEventListener('click', onClick) }
    },
    installPanelExclusion(controller) {
      const doc = target ?? document
      const onOther = (event: Event): void => {
        const detail = (event as CustomEvent<unknown>).detail
        if (typeof detail === 'string' && OTHER_PANELS.has(detail)) controller.close()
      }
      doc.addEventListener(PANEL_EVENT, onOther)
      doc.dispatchEvent(new CustomEvent(PANEL_EVENT, { detail: 'prompt-tool' }))
      return () => { doc.removeEventListener(PANEL_EVENT, onOther) }
    },
  }
}

/** 生产单例：入口与抽屉共用同一份约定（无状态，共享安全）。 */
export const workbenchHostConventions = createWorkbenchHostConventions()
