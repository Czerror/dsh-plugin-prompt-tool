import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { WorkbenchOverlay } from './WorkbenchOverlay.tsx'
import { WorkbenchSidebarEntry } from './WorkbenchSidebarEntry.tsx'
import type { PromptToolWorkbenchFace } from './workbench-face.ts'
import { PROMPT_TOOL_NS } from '../../locales.ts'

/** 左侧栏入口 id；不注册 main 面板——行点击由入口组件截获并打开抽屉。 */
export const WORKBENCH_ENTRY_ID = PROMPT_TOOL_NS

/**
 * 注册官方槽位：
 * - shell.overlay：可拖动悬浮触发器 + body portal 抽屉（浮层入口）；
 * - sidebar.panellist：左侧栏导航入口，行点击直接打开同一个常驻抽屉。
 *
 * 不注册同 key 的 main：官方只在 selectPanel 时需要 main key，而入口的行点击已在
 * 冒泡阶段被截下，不会走 selectPanel——对话也就不被整树卸载（本机单次观测约 2–3s）。
 * 宿主行结构变化导致截获失效时，点击会由 selectPanel 抛错（已知边界）。
 */
export function registerWorkbenchSlots(ctx: ClientContext, face: PromptToolWorkbenchFace): () => void {
  const openDrawer = (): void => face.controller.open()
  const disposeOverlay = ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'prompt-tool-workbench', order: 50,
    locale: PROMPT_TOOL_NS,
    inject: () => face,
  }, WorkbenchOverlay))
  const disposeIcon = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: WORKBENCH_ENTRY_ID,
    order: 60, // 排在官方插件 0、自动化任务 10、记忆系统 30 之后。
    locale: PROMPT_TOOL_NS,
    label: () => face.t('app.title'),
    inject: () => ({ open: openDrawer }),
  }, WorkbenchSidebarEntry))
  return () => {
    disposeOverlay()
    disposeIcon()
  }
}
