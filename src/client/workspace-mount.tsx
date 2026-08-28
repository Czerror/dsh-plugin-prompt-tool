import { createRoot, type Root } from 'react-dom/client'
import { PromptWorkspace } from './PromptWorkspace.tsx'
import type { PromptToolSettingsTransport } from './prompt-tool-store.ts'
import type { PromptToolHostApi } from './prompt-tool-types.ts'
import css from './PromptWorkspace.module.css'
import { mountPromptToolSidebarEntry } from './sidebar-entry.ts'
import { PromptToolWorkspaceController } from './workspace-controller.ts'
import { findConversationColumn, findOfficialWorkspaceMount, matchesSidebarContext } from './host-surface.ts'

export { PROMPT_TOOL_VIEW_SELECTOR } from './host-surface.ts'

const ACTIVE_ATTR = 'data-dsh-prompt-tool-active'
const TASKBOARD_ACTIVE_ATTR = 'data-dsh-taskboard-active'
const SSH_ACTIVE_ATTR = 'data-dsh-ssh-active'
const ACTIVATE_EVENT = 'dsh-panel-activate'

function mountPanel(controller: PromptToolWorkspaceController, api: PromptToolHostApi, settings: PromptToolSettingsTransport): () => void {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  const ensure = (): void => {
    if (container !== undefined && container.isConnected) return
    if (container !== undefined) {
      root?.unmount()
      root = undefined
      container = undefined
    }
    const column = findOfficialWorkspaceMount() ?? findConversationColumn()
    if (column === undefined) return
    container = document.createElement('div')
    container.dataset.dshPromptToolView = ''
    container.className = css.panelView ?? ''
    column.append(container)
    root = createRoot(container)
    root.render(<PromptWorkspace api={api} settings={settings} controller={controller} onClose={() => { controller.close() }} />)
    // 宿主 DOM 后出现、面板已打开时（applyActive 早于本容器创建），补一次焦点移入。
    if (controller.getSnapshot().open) {
      container.querySelector<HTMLElement>('button, input, select, textarea, [tabindex]')?.focus()
    }
  }

  // 宿主 DOM 高频变动：body subtree 观察防抖，避免每次变更都全文档扫描。
  let waitTimer: ReturnType<typeof setTimeout> | undefined
  const waitObserver = new MutationObserver(() => {
    if (waitTimer !== undefined) clearTimeout(waitTimer)
    waitTimer = setTimeout(ensure, 200)
  })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  let suppressCompatibilityClose = false
  const applyActive = (): void => {
    if (!controller.getSnapshot().open) {
      document.documentElement.removeAttribute(ACTIVE_ATTR)
      return
    }
    // 与 task-board / SSH 面板互斥：先发兼容关闭事件，再宣布本面板激活。
    suppressCompatibilityClose = true
    document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: 'ssh' }))
    document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: 'taskboard' }))
    suppressCompatibilityClose = false
    document.documentElement.removeAttribute(TASKBOARD_ACTIVE_ATTR)
    document.documentElement.removeAttribute(SSH_ACTIVE_ATTR)
    document.documentElement.setAttribute(ACTIVE_ATTR, '')
    document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: 'prompt-tool' }))
    // 打开后把焦点移入面板首个可聚焦控件，键盘用户无需手动 Tab 进入。
    container?.querySelector<HTMLElement>('button, input, select, textarea, [tabindex]')?.focus()
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && controller.getSnapshot().open) {
      event.preventDefault()
      controller.close()
    }
  }

  const onOtherPanelActivate = (event: Event): void => {
    if (suppressCompatibilityClose || !controller.getSnapshot().open) return
    const detail = (event as CustomEvent<unknown>).detail
    if (detail === 'taskboard' || detail === 'ssh') controller.close()
  }

  const onSidebarContextClick = (event: MouseEvent): void => {
    if (!controller.getSnapshot().open) return
    const target = event.target
    if (target instanceof Element && matchesSidebarContext(target)) controller.close()
  }

  document.addEventListener('click', onSidebarContextClick, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherPanelActivate)
  document.addEventListener('keydown', onKeyDown)
  const unsubscribe = controller.subscribe(applyActive)
  applyActive()
  ensure()

  return () => {
    if (waitTimer !== undefined) clearTimeout(waitTimer)
    document.removeEventListener('click', onSidebarContextClick, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherPanelActivate)
    document.removeEventListener('keydown', onKeyDown)
    waitObserver.disconnect()
    unsubscribe()
    document.documentElement.removeAttribute(ACTIVE_ATTR)
    root?.unmount()
    root = undefined
    container?.remove()
    container = undefined
  }
}

/** 挂载侧边栏入口与中央列工作台（同一单元，随插件卸载整体回收）。 */
export function mountPromptToolWorkspace(api: PromptToolHostApi, settings: PromptToolSettingsTransport): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}
  const controller = new PromptToolWorkspaceController()
  const disposeEntry = mountPromptToolSidebarEntry(controller)
  const disposePanel = mountPanel(controller, api, settings)
  return () => {
    disposePanel()
    disposeEntry()
  }
}
