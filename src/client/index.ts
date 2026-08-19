import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { PromptSettingsPage, type PromptSettingsPageInjected } from './PromptSettingsPage.tsx'
import { mountPromptToolWorkspace } from './workspace-mount.tsx'

export const inject = ['slots', 'connection']

export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  if (connection === undefined) return

  // 主设置一级 section：现在只保留「提示词配置」页（含目录导入）。
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'prompt-tool',
    order: 160,
    label: () => '提示词工具',
    inject: (): PromptSettingsPageInjected => ({ api: connection.api }),
  }, PromptSettingsPage))

  // 侧边栏独立工作台：新建会话行下方入口 + 中央列面板。
  ctx.effect(() => mountPromptToolWorkspace(connection.api), 'prompt-tool: sidebar workspace')
}
