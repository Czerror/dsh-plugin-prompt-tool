import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { PromptToolSettingsTransport } from './prompt-tool-store.ts'
import { mountPromptToolWorkspace } from './workspace-mount.tsx'
import type { PromptToolHostApi } from './prompt-tool-types.ts'

export const inject = ['settingsScope', 'uiWorkspace', 'remote']

/** 与宿主 settings namespace 相同的字符串；client 侧不依赖 host 包，按契约字面拼写。 */
const PROMPT_TOOL_NS = 'prompt-tool'

export function apply(ctx: ClientContext): void {
  // alpha.1 ui-settings：标准字段读写走官方共享 describe mirror + scope mutate
  // （revision 校验与 mirror fold 由 SettingsScopeController 内置，无需 acceptView）。
  const scope = ctx.settingsScope.bind<Record<string, unknown>>({ namespace: PROMPT_TOOL_NS })
  const settings: PromptToolSettingsTransport = {
    scope,
    ensure: () => ctx.settingsScope.describe().ensure(),
    mutate: async (ops, expectedRevision) => {
      await scope.mutate(ops, expectedRevision)
    },
  }
  const hostApi: PromptToolHostApi = {
    pickDirectory: () => ctx.uiWorkspace.pickDirectory(),
    openPath: async (path) => {
      const result = await ctx.remote.session.openWorkspacePath({ path })
      if (!result.ok) throw new Error(result.error.message)
    },
  }

  // 侧边栏独立工作台：新建会话行下方入口 + 中央列面板。
  ctx.effect(() => mountPromptToolWorkspace(hostApi, settings), 'prompt-tool: sidebar workspace')
}
