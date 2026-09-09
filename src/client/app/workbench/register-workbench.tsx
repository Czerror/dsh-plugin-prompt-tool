import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { SettingsTab } from './SettingsTab.tsx'
import { SidebarGeometryProbe } from './SidebarGeometryProbe.tsx'
import { WorkbenchOverlay } from './WorkbenchOverlay.tsx'
import type { PromptToolWorkbenchFace } from './workbench-face.ts'

/** 注册官方槽位：settings.plugins.tab 基础设置 + shell.overlay 悬浮入口
 *  （触发器 + body portal 抽屉）+ sidebar.footer.action 几何探针
 *  （悬浮按钮贴合侧栏轨道右缘）。 */
export function registerWorkbenchSlots(ctx: ClientContext, face: PromptToolWorkbenchFace): () => void {
  const disposeGeometry = ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'prompt-tool-floating-geometry', order: 40,
  }, SidebarGeometryProbe))
  const disposeTab = ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab', id: 'prompt-tool', order: 40, label: '提示词工具', inject: () => face,
  }, SettingsTab))
  const disposeOverlay = ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'prompt-tool-workbench', order: 50, inject: () => face,
  }, WorkbenchOverlay))
  return () => { disposeOverlay(); disposeGeometry(); disposeTab() }
}
