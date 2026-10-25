/**
 * 工作台的非官方宿主约定：侧栏行 DOM 拦截与跨插件面板互斥事件。
 *
 * 官方 slot 注册是宿主 API，留在 register-workbench；这里只集中两处会随宿主
 * 结构/事件总线漂移的约定，将来宿主给正式接口时只换这个 adapter。
 */

/** 够用的文档事件面：生产传 document，测试传假对象。 */
export interface PanelEventTarget {
  addEventListener(type: string, listener: (event: Event) => void): void
  removeEventListener(type: string, listener: (event: Event) => void): void
  dispatchEvent(event: Event): boolean
}

export interface WorkbenchHost {
  /** 侧栏行点击拦截；找不到宿主行时返回空 disposer。 */
  interceptSidebarRow(icon: Element | null, open: () => void): () => void
  /** 与其他面板互斥：监听 taskboard / ssh，打开时派发自己的事件。 */
  installPanelExclusion(controller: { close(): void }, target?: PanelEventTarget): () => void
}

const PANEL_EVENT = 'dsh-panel-activate'
const OTHER_PANELS = new Set(['taskboard', 'ssh'])

export function createWorkbenchHost(): WorkbenchHost {
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
    installPanelExclusion(controller, target = document) {
      const onOther = (event: Event): void => {
        const detail = (event as CustomEvent<unknown>).detail
        if (typeof detail === 'string' && OTHER_PANELS.has(detail)) controller.close()
      }
      target.addEventListener(PANEL_EVENT, onOther)
      target.dispatchEvent(new CustomEvent(PANEL_EVENT, { detail: 'prompt-tool' }))
      return () => { target.removeEventListener(PANEL_EVENT, onOther) }
    },
  }
}
