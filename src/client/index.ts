import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { PromptToolSettingsTransport } from './data/use-prompt-tool-store.ts'
import { createSessionModelFace } from './data/session-model-face.ts'
import { createSessionPresetFace } from './data/session-preset-face.ts'
import { readCurrentSessionId, subscribeSessionIdChange } from './data/session-id-source.ts'
import { bridgeCall } from './data/bridge-client.ts'
import { registerWorkbenchSlots } from './app/workbench/register-workbench.tsx'
import { PromptToolWorkspaceController } from './app/workbench/workspace-controller.ts'
import type { PromptToolWorkbenchFace } from './app/workbench/workbench-face.ts'
import type { PromptToolHostApi } from './data/host-api.ts'
import { PROMPT_TOOL_NS as LOCALE_NS, registerPromptToolLocale } from './locales.ts'

export const inject = [
  'locale',
  'slots',
  'settingsScope',
  'uiWorkspace',
  'uiSession',
  'remote',
  'remote.agentPresets',
  'remote.session',
  'sessions',
]

/** 与宿主 settings namespace 相同的字符串；client 侧不依赖 host 包，按契约字面拼写。 */
const PROMPT_TOOL_NS = 'prompt-tool'

export function apply(ctx: ClientContext): void {
  // 官方 locale 字典：注册挂 effect（卸载/重挂自动释放，不会重复注册同一命名空间）。
  // 命名空间在 locales.ts 里并入官方 LocaleNamespaceMap，slot 注册据此拿到 typed t。
  ctx.effect(() => registerPromptToolLocale(ctx.locale))
  const t = ctx.locale.bind(LOCALE_NS)
  // 官方连接世代重建（connection/reset）后，宿主的模型目录缓存可能已过期：
  // 显式刷新一次（越过 10 分钟 TTL），下一次打开工作台即命中新目录。
  // 目录刷新不是关键路径，失败静默。
  ctx.effect(() => ctx.on('connection/reset', () => {
    void bridgeCall('models', { refresh: true }).catch(() => undefined)
  }))
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
  // 当前会话 id：官方在 alpha.2 把「当前选中会话」移出 Session Controller
  // （ISessions 注释：navigation belongs to view owners），SessionListState 不再
  // 有 current；改由 ui-session 的作用域绑定读取。
  const currentSessionId = (): string | undefined => readCurrentSessionId(ctx.uiSession.adapter, ctx.sessions)
  const hostApi: PromptToolHostApi = {
    currentSessionId,
    subscribeSessionChange: (listener) => subscribeSessionIdChange(ctx.uiSession.adapter, ctx.sessions, listener),
    listAgentPresets: async () => {
      try {
        const result = await ctx.remote.agentPresets.list()
        if (!result.ok) return []
        const presets = (result.value as { presets?: readonly { id: string; name?: string; description?: string; trust?: 'system' | 'user'; broken?: string }[] }).presets
        return (presets ?? []).filter((preset) => preset.broken === undefined).map(({ id, name, description, trust }) => ({
          id,
          ...(name === undefined ? {} : { name }),
          ...(description === undefined ? {} : { description }),
          ...(trust === undefined ? {} : { trust }),
        }))
      } catch {
        return []
      }
    },
    pickDirectory: () => ctx.uiWorkspace.pickDirectory(),
    openPath: async (path) => {
      const result = await ctx.remote.session.openWorkspacePath({ path })
      if (!result.ok) throw new Error(result.error.message)
    },
    // 当前会话模型选择：投影 modelSelection.next ?? 宿主默认（UI 回退）；
    // 写入走官方 session.selectModel（对当前会话生效 + 宿主持久化为新会话默认）。
    sessionModel: createSessionModelFace(
      {
        currentSessionId,
        subscribeCurrent: (listener) => ctx.uiSession.adapter.current.subscribe(listener),
        // sessionId 是官方 brand 字符串：结构同源，按官方签名断言对齐。
        binding: (id) => ctx.sessions.binding(id as Parameters<typeof ctx.sessions.binding>[0]),
        subagentAddress: (id) => ctx.sessions.subagentAddress(id as Parameters<typeof ctx.sessions.subagentAddress>[0]),
      },
      (request) => ctx.remote.session.selectModel(request as Parameters<typeof ctx.remote.session.selectModel>[0]),
    ),
    // 官方会话级预设切换（新建会话 chip）只改那个空白会话，不改宿主默认预设：
    // 工作台据此跟随（见 session-preset-follow）。
    sessionPreset: createSessionPresetFace({
      currentSessionId,
      subscribeCurrent: (listener) => ctx.uiSession.adapter.current.subscribe(listener),
      binding: (id) => ctx.sessions.binding(id as Parameters<typeof ctx.sessions.binding>[0]),
    }),
    switchPreset: async (id) => {
      const sessionId = currentSessionId()
      const list = ctx.sessions.list.getSnapshot()
      const session = sessionId === undefined ? undefined : list.byId[sessionId as keyof typeof list.byId]
      if (session === undefined) return { applied: false }
      if (!session.blank) {
        return { applied: false, message: t('settings.switchReason.sessionNotBlank') }
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

  // 悬浮入口：shell.overlay（可拖动触发器 + body portal 抽屉）；
  // settings.plugins.tab 基础设置共享同一注入面。
  // 位置由插件自己的位置偏好 + 视口夹取决定，不读宿主布局树。
  // 注册全部走官方 SlotRegistry，不手工挂载 DOM。
  const face: PromptToolWorkbenchFace = { controller: new PromptToolWorkspaceController(), api: hostApi, settings, t }
  registerWorkbenchSlots(ctx, face)
}
