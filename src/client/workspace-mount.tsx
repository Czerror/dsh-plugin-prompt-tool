import { createRoot, type Root } from 'react-dom/client'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import { PromptWorkspace } from './PromptWorkspace.tsx'
import type { PromptToolSettingsTransport } from './prompt-tool-store.ts'
import css from './PromptWorkspace.module.css'
import { mountPromptToolSidebarEntry } from './sidebar-entry.ts'
import { PromptToolWorkspaceController } from './workspace-controller.ts'

export const PROMPT_TOOL_VIEW_SELECTOR = '[data-dsh-prompt-tool-view]'

const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'
const ACTIVE_ATTR = 'data-dsh-prompt-tool-active'
const TASKBOARD_ACTIVE_ATTR = 'data-dsh-taskboard-active'
const SSH_ACTIVE_ATTR = 'data-dsh-ssh-active'
const ACTIVATE_EVENT = 'dsh-panel-activate'
const SIDEBAR_CONTEXT_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'

function conversationColumn(): HTMLElement | undefined {
  return document.querySelector<HTMLElement>(CONVERSATION_COLUMN_SELECTOR) ?? undefined
}

function mountPanel(controller: PromptToolWorkspaceController, api: IApiClient, settings: PromptToolSettingsTransport): () => void {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  const ensure = (): void => {
    if (container !== undefined && container.isConnected) return
    if (container !== undefined) {
      root?.unmount()
      root = undefined
      container = undefined
    }
    const column = conversationColumn()
    if (column === undefined) return
    container = document.createElement('div')
    container.dataset.dshPromptToolView = ''
    container.className = css.panelView ?? ''
    column.append(container)
    root = createRoot(container)
    root.render(<PromptWorkspace api={api} settings={settings} controller={controller} onClose={() => { controller.close() }} />)
  }

  const waitObserver = new MutationObserver(ensure)
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
  }

  const onOtherPanelActivate = (event: Event): void => {
    if (suppressCompatibilityClose || !controller.getSnapshot().open) return
    const detail = (event as CustomEvent<unknown>).detail
    if (detail === 'taskboard' || detail === 'ssh') controller.close()
  }

  const onSidebarContextClick = (event: MouseEvent): void => {
    if (!controller.getSnapshot().open) return
    const target = event.target
    if (target instanceof Element && target.closest(SIDEBAR_CONTEXT_SELECTOR) !== null) controller.close()
  }

  document.addEventListener('click', onSidebarContextClick, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherPanelActivate)
  const unsubscribe = controller.subscribe(applyActive)
  applyActive()
  ensure()

  return () => {
    document.removeEventListener('click', onSidebarContextClick, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherPanelActivate)
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
export function mountPromptToolWorkspace(api: IApiClient, settings: PromptToolSettingsTransport): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}
  const controller = new PromptToolWorkspaceController()
  const disposeEntry = mountPromptToolSidebarEntry(controller)
  const disposePanel = mountPanel(controller, api, settings)
  return () => {
    disposePanel()
    disposeEntry()
  }
}
