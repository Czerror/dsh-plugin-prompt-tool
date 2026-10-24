import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { WorkbenchOverlay } from './WorkbenchOverlay.tsx'
import { WorkbenchMainPanel } from './WorkbenchMainPanel.tsx'
import { WorkbenchSidebarIcon } from './WorkbenchSidebarIcon.tsx'
import type { PromptToolWorkbenchFace } from './workbench-face.ts'
import { PROMPT_TOOL_NS } from '../../locales.ts'

/** 左侧栏全局面板 key：sidebar.panellist 的 id 与 main 的 key 必须相同；与命名空间共用同一字面量。 */
export const WORKBENCH_PANEL_ID = PROMPT_TOOL_NS as MainPanelId

/**
 * 注册官方槽位：
 * - shell.overlay：可拖动悬浮触发器 + body portal 抽屉（浮层入口）；
 * - sidebar.panellist + 同 key 的 main：左侧栏导航入口，选中即打开悬浮抽屉并回到
 *   对话（官方 Global panel entries 要求成对注册，工作台只保留抽屉一个实例）。
 *
 * 入口位置由插件自己的位置偏好与视口夹取决定；不读宿主布局树。
 */
export function registerWorkbenchSlots(ctx: ClientContext, face: PromptToolWorkbenchFace): () => void {
  const disposeOverlay = ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'prompt-tool-workbench', order: 50,
    locale: PROMPT_TOOL_NS,
    inject: () => face,
  }, WorkbenchOverlay))
  // 行点击由图标组件在冒泡前拦截；同一个稳定回调交给它。
  const openDrawer = (): void => face.controller.open()
  const disposePanel = ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', () => {
    const disposeMain = ctx.slots.register({
      name: 'main', key: WORKBENCH_PANEL_ID,
      locale: PROMPT_TOOL_NS,
      inject: () => ({ controller: face.controller, closePanel: () => ctx.layout.selectPanel(null) }),
    }, WorkbenchMainPanel)
    let disposeIcon: () => void
    try {
      // 先有主面板再有入口：注册图标失败时撤掉主面板，不留可抛错的孤儿 key。
      // order 60：排在官方插件 0、自动化任务 10、记忆系统 30 之后。
      disposeIcon = ctx.slots.register({
        name: 'sidebar.panellist', id: WORKBENCH_PANEL_ID, order: 60,
        locale: PROMPT_TOOL_NS,
        label: () => face.t('app.title'),
        inject: () => ({ open: openDrawer }),
      }, WorkbenchSidebarIcon)
    } catch (error) {
      disposeMain()
      throw error
    }
    return () => {
      disposeIcon()
      disposeMain()
    }
  }))
  return () => {
    disposeOverlay()
    disposePanel()
  }
}
