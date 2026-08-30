import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { PromptToolSettingsTransport } from './prompt-tool-store.ts'
import { PromptToolWorkspaceController } from './workspace-controller.ts'
import { registerWorkbenchSlots, type PromptToolWorkbenchFace } from './slot-workbench.tsx'
import type { PromptToolHostApi } from './prompt-tool-types.ts'

export const inject = [
  'slots',
  'settingsScope',
  'uiWorkspace',
  'remote',
  'remote.agentPresets',
  'remote.session',
  'sessions',
]

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
    switchPreset: async (id) => {
      const list = ctx.sessions.list.getSnapshot()
      const session = list.current === undefined ? undefined : list.byId[list.current]
      if (session === undefined) return { applied: false }
      if (!session.blank) {
        return { applied: false, message: '当前会话已有内容，官方只允许空会话切换；本次只更新后续会话默认预设' }
      }
      const result = await ctx.remote.agentPresets.select(session.id, id)
      if (!result.ok) {
        const failure = result.error as { message: string; details?: { reason?: unknown } }
        const reason = failure.details?.reason
        return {
          applied: false,
          message: typeof reason === 'string' ? reason : failure.message,
        }
      }
      return { applied: true }
    },
  }

  // 官方 slot 工作台：shell.overlay 顶层悬浮按钮 + 右侧抽屉；sidebar.footer.action
  // 仅提供可拉伸侧边栏的几何探针；settings.plugins.tab 基础设置共享同一 controller。
  // 注册全部走 SlotRegistry 的 inject()（等声明就绪）+ ctx.effect 生命周期，
  // 不手工挂载 DOM。
  const controller = new PromptToolWorkspaceController()
  const face: PromptToolWorkbenchFace = { controller, api: hostApi, settings }
  registerWorkbenchSlots(ctx, face)
}
