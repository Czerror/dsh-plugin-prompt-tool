import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import { install as installStyles } from 'virtual:prompt-tool-styles'
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
import { readCurrentSessionId } from './data/session-id-source.ts'
import { bridgeCall, subscribeConfigurationChanges } from './data/bridge-client.ts'
import { registerWorkbenchSlots } from './app/workbench/register-workbench.tsx'
import { createNativeWorkspaceState } from './app/workbench/native-workspace-state.ts'
import { NativeWorkspace, NativeWorkspaceData, type NativeWorkspaceOwner } from './app/workbench/NativeWorkspace.tsx'
import { createWorkspaceStoreHolder } from './data/workspace-state.ts'
import { createRuleDiagnosticsSession } from './data/rule-diagnostics-session.ts'
import type { PromptToolHostApi } from './data/host-api.ts'
import { registerPromptToolLocale } from './locales.ts'
import { PROMPT_TOOL_NS } from '../shared/namespace.ts'
import { registerRewindSlot } from './app/register-rewind.tsx'

export const inject = [
  'locale',
  'slots',
  'configForms',
  'uiWorkspace',
  'uiSession',
  'remote',
  'remote.agentPresets',
  'remote.session',
  'sessions',
  'uiConversation',
]

export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles)
  // 官方 locale 字典：注册挂 effect（卸载/重挂自动释放，不会重复注册同一命名空间）。
  // 命名空间在 locales.ts 里并入官方 LocaleNamespaceMap，slot 注册据此拿到 typed t。
  ctx.effect(() => registerPromptToolLocale(ctx.locale))
  const t = ctx.locale.bind(PROMPT_TOOL_NS)
  const workspaceState = createNativeWorkspaceState()
  const diagnostics = createRuleDiagnosticsSession()
  const holder = createWorkspaceStoreHolder()
  ctx.effect(() => () => { diagnostics.dispose(); holder.dispose(); workspaceState.dispose() })
  ctx.effect(() => subscribeConfigurationChanges(() => diagnostics.invalidate()))
  ctx.effect(() => registerRewindSlot(ctx, t))
  // 官方连接世代重建（connection/reset）后，宿主的模型目录缓存可能已过期：
  // 显式刷新一次（越过 10 分钟 TTL），下一次打开工作台即命中新目录。
  // 目录刷新不是关键路径，失败静默。
  ctx.effect(() => ctx.on('connection/reset', () => {
    diagnostics.invalidate()
    void bridgeCall('models', { refresh: true }).catch(() => undefined)
  }))
  // 0.1.7 ui-settings：标准字段读写复用 ConfigForms 的共享镜像与写入队列。
  // locale 与 settings 共用同一命名空间字面量；换 Loader 行 id 装配时 client transport 需同步（已知边界）。
  const scope = ctx.configForms.get<Record<string, unknown>>(PROMPT_TOOL_NS)
  const settings: PromptToolSettingsTransport = {
    scope,
    ensure: () => ctx.configForms.describe().ensure(),
    mutate: async (ops, expectedRevision) => {
      if (!await scope.mutate(ops, expectedRevision)) throw new Error(t('settings.saveRejected'))
      diagnostics.invalidate()
    },
  }
  // 当前会话 id：官方在 alpha.2 把「当前选中会话」移出 Session Controller
  // （ISessions 注释：navigation belongs to view owners），SessionListState 不再
  // 有 current；改由 ui-session 的作用域绑定读取。
  const currentSessionId = (): string | undefined => workspaceState.getSnapshot().sessionId
  const subscribeCurrent = (listener: () => void): (() => void) => {
    let previous = currentSessionId()
    return workspaceState.subscribe(() => {
      const next = currentSessionId()
      if (next !== previous) { previous = next; listener() }
    })
  }
  const hostApi: PromptToolHostApi = {
    currentSessionId,
    subscribeSessionChange: subscribeCurrent,
    listAgentPresets: async () => {
      const result = await ctx.remote.agentPresets.list()
      if (!result.ok) throw new Error(result.error.message)
      return result.value.presets.map(({ id, name, description, broken }) => ({
        id,
        ...(name === undefined ? {} : { name }),
        ...(description === undefined ? {} : { description }),
        ...(broken === undefined ? {} : { broken }),
      }))
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
        subscribeCurrent,
        // sessionId 是官方 brand 字符串：结构同源，按官方签名断言对齐。
        binding: (id) => ctx.sessions.binding(id as Parameters<typeof ctx.sessions.binding>[0]),
        subagentAddress: (id) => ctx.sessions.subagentAddress(id as Parameters<typeof ctx.sessions.subagentAddress>[0]),
      },
      (request) => ctx.remote.session.selectModel(request as Parameters<typeof ctx.remote.session.selectModel>[0]),
    ),
    // 官方会话预设投影供宿主能力面使用；模块编辑目标由请求身份独立管理。
    sessionPreset: createSessionPresetFace({
      currentSessionId,
      subscribeCurrent,
      binding: (id) => ctx.sessions.binding(id as Parameters<typeof ctx.sessions.binding>[0]),
    }),
  }

  // main 面板卸载对话作用域后，仍使用进入面板前最后选中的官方会话。
  let mainSessionId = readCurrentSessionId(ctx.uiSession.adapter, ctx.sessions)
  const mainListeners = new Set<() => void>()
  ctx.effect(() => ctx.uiSession.adapter.current.subscribe(() => {
    const next = readCurrentSessionId(ctx.uiSession.adapter, ctx.sessions)
    if (next === undefined || next === mainSessionId) return
    mainSessionId = next
    for (const listener of mainListeners) listener()
  }))
  const owner: NativeWorkspaceOwner = {
    state: workspaceState, holder, diagnostics, api: hostApi, settings, t,
    mainSession: () => mainSessionId,
    subscribeMainSession(listener) { mainListeners.add(listener); return () => { mainListeners.delete(listener) } },
  }
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'prompt-tool-data',
  }, () => createElement(NativeWorkspaceData, { owner }))))
  ctx.effect(() => registerWorkbenchSlots(ctx, {
    t,
    renderWorkspace: (props) => createElement(NativeWorkspace, {
      ...props,
      owner,
    }),
  }))
}
