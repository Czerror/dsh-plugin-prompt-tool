/**
 * 自建 loopback settings bridge：Web 设置页数据通道（提示词配置数组经此输出到 UI）。
 *
 * 本文件只做装配：建一次运行时 → 两个 `ctx.inject` 作用域 → 9 个域各注册自己的端点 →
 * 逐个收集 disposer。端点实现按域放在 `routes/<域>.ts`，共享态与共享 helper 在
 * `bridge-runtime.ts`（descriptor 缓存、上传暂存、两条队列、change 回调都在那里只建一次）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createBridgeRuntime, type BridgeDeps, type SkillsBridgeState } from './bridge-runtime.ts'
import { registerDefinitions } from './routes/definitions.ts'
import { registerDiagnostics } from './routes/diagnostics.ts'
import { registerInstructions } from './routes/instructions.ts'
import { registerLifecycle } from './routes/lifecycle.ts'
import { registerMeta } from './routes/meta.ts'
import { registerParams } from './routes/params.ts'
import { registerSettingsDomain } from './routes/settings.ts'
import { registerSkills } from './routes/skills.ts'
import { registerTemplates } from './routes/templates.ts'
import { registerTransfer } from './routes/transfer.ts'

export type { BridgeDeps, SkillsBridgeState }
/** 指令卡合并的对外入口仍在原处：`src/index.ts` 从这里取。 */
export { mergeInstructionCards } from './bridge-runtime.ts'

export function registerSettingsBridge(
  ctx: Context,
  deps: BridgeDeps,
): { invalidateDescriptor: () => void } {
  const { ns } = deps
  // 运行时只建一次：两个注入域共用同一份共享态与注册通道。
  const runtime = createBridgeRuntime({ ctx, deps, ns })

  // 动态等待 webServer：webServer 由 @deepseek-ai/dsh-web-app 提供。
  // profile 首次缺少该 bundle 时，本子插件先 pending 但不阻塞启动审计；
  // ensureWebSurface 仅报告缺失能力，profile 装配交给官方插件管理流程。
  ctx.inject(['settings', 'webServer'], (sctx: Context) => {
    sctx.effect(() => {
      const disposers = [
        // 上传暂存归运行时所有，随本作用域销毁。
        runtime.attachSettingsScope(sctx),
        ...registerMeta(runtime),
        ...registerSettingsDomain(runtime),
        ...registerSkills(runtime),
        ...registerTemplates(runtime),
        ...registerInstructions(runtime),
        ...registerParams(runtime),
        ...registerDefinitions(runtime),
        ...registerTransfer(runtime),
        ...registerLifecycle(runtime),
      ]
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'prompt-tool: settings bridge')
  })

  // 工具面（/tool-surface）等只读运行态端点：独立动态等待 agents+tools，
  // 不扩大 src/index.ts 静态 inject。注册通道与事务入口复用同一个运行时。
  ctx.inject(['agents', 'tools', 'webServer'], (stx: Context) => {
    stx.effect(() => {
      runtime.attachAgentScope(stx)
      const disposers = registerDiagnostics(runtime)
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'prompt-tool: tool surface')
  })

  // 失效回调直连缓存本身：作用域挂上前后都只影响那一份缓存（挂上前缓存为空，失效即空操作）。
  return { invalidateDescriptor: () => runtime.descriptor.invalidate() }
}
