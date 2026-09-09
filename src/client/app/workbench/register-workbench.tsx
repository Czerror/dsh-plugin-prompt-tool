import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { PromptToolTab } from './PromptToolTab.tsx'
import { SettingsTab } from './SettingsTab.tsx'
import { SidebarGeometryProbe } from './SidebarGeometryProbe.tsx'
import { WorkbenchOverlay } from './WorkbenchOverlay.tsx'
import type { PromptToolWorkbenchFace } from './workbench-face.ts'

/** 右侧栏 tab type 的稳定身份：body 与 title 都按该 id 派发。 */
export const PROMPT_TOOL_TAB_ID = 'dsh-plugin-prompt-tool/workbench'
/** tab type 的 kind，也是 `openTab` 的入参。 */
export const PROMPT_TOOL_TAB_KIND = 'prompt-tool'

/** 注册官方槽位：settings.plugins.tab 基础设置 + 右侧栏工作台 tab（两段注册）
 *  + shell.overlay 悬浮入口（双入口兼容：悬浮抽屉与官方右侧栏各自独立打开）
 *  + sidebar.footer.action 几何探针（悬浮按钮贴合侧栏轨道右缘）。 */
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
  // 官方右侧栏两段注册：type 进 registry（guide 提供入口盒），body 进 keyed slot。
  const disposeType = ctx.effect(() => ctx.sidebarRightTabs.register({
    id: PROMPT_TOOL_TAB_ID,
    kind: PROMPT_TOOL_TAB_KIND,
    title: () => '提示词工具',
    guide: [{
      order: 40,
      title: () => '提示词工具',
      description: () => '主会话、子代理、工具预览、技能、预设与角色六页工作台',
    }],
  }), 'prompt-tool: sidebar-right tab type')
  const disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: PROMPT_TOOL_TAB_ID, inject: () => face,
  }, PromptToolTab))
  return () => { disposeBody(); disposeType(); disposeOverlay(); disposeGeometry(); disposeTab() }
}
