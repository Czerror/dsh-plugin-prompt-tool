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
/** 注册官方槽位；触发器在 shell.overlay 顶层，sidebar.footer.action 只提供可拉伸宽度探针。 */
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
