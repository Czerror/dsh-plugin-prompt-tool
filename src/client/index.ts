import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { PromptSettingsPage, type PromptSettingsPageInjected } from './PromptSettingsPage.tsx'
import type { PromptToolSettingsTransport } from './prompt-tool-store.ts'
import { mountPromptToolWorkspace } from './workspace-mount.tsx'

export const inject = ['slots', 'connection', 'settingsScope']

/** 与宿主 settings namespace 相同的字符串；client 侧不依赖 host 包，按契约字面拼写。 */
const PROMPT_TOOL_NS = 'prompt-tool'

export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  if (connection === undefined) return

  // rc8 ui-settings 跟进：标准字段读写走官方共享 describe mirror。
  // 绑定生命周期由 SettingsScopeBinder 挂在调用方 fiber 上，无需手工 dispose。
  const scope = ctx.settingsScope.bind<Record<string, unknown>>({ namespace: PROMPT_TOOL_NS })
  const describe = ctx.settingsScope.describe()
  const settings: PromptToolSettingsTransport = {
    scope,
    ensure: () => describe.ensure(),
    mutate: async (ops, expectedRevision) => {
      const response = await connection.api.settings.mutate({
        ns: PROMPT_TOOL_NS,
        ops,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      })
      if (!response.result.ok) throw new Error(response.result.error.message)
      describe.acceptView(response.result.value)
      return response.result.value
    },
  }

  // 主设置一级 section：现在只保留「提示词配置」页（含目录导入）。
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'prompt-tool',
    order: 160,
    label: () => '提示词工具',
    inject: (): PromptSettingsPageInjected => ({ api: connection.api, settings }),
  }, PromptSettingsPage))

  // 侧边栏独立工作台：新建会话行下方入口 + 中央列面板。
  ctx.effect(() => mountPromptToolWorkspace(connection.api, settings), 'prompt-tool: sidebar workspace')
}
