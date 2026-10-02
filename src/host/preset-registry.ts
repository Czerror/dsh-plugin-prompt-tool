/**
 * preset-registry — 把插件存储根里的预设登记为官方预设**身份**。
 *
 * 这一层只做一件事：让宿主在创建会话时 `agentPresets.mount(agentCtx, id)` 找得到 id。
 * 组合本体不再注册（`plugins: []`）——运行时装配由 `runtime/agent-assembly.ts` 在
 * Agent 自己的 scope 里承担，官方工具行由会话原有预设提供。
 *
 * 因此这里**不读** `agent.cordis.yml`：它是给宿主 Loader 用的组合本体，随自建装配一起退场。
 * 登记的身份语义（id、显示元数据、排序）仍来自 `preset.yml`。
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { listPresets, loadPresetSpec } from './manifest.ts'
import { MODULE_DEFINITION_FILE } from './paths.ts'

type Registration = { dispose: () => Promise<void>; fingerprint: string }

/**
 * 预设目录确实存在于本插件存储根（身份判定与官方登记状态无关）。
 *
 * 工具写入目标、TUI 目标与 `owns` 共用这一条判据：本插件管理的预设 = 存储根里含
 * `preset.yml` 的目录，与「宿主有没有把它登记成官方预设」是两回事。
 */
export function presetDirExists(root: string, id: string): boolean {
  return statSync(join(root, id, MODULE_DEFINITION_FILE), { throwIfNoEntry: false }) !== undefined
}

/** 登记身份：元数据来自 preset.yml，组合本体为空（装配不归官方 Loader）。 */
function readDefinition(root: string, id: string): PresetDefinition {
  const preset = loadPresetSpec(join(root, id))
  const order = typeof preset.order === 'number' && Number.isFinite(preset.order) ? preset.order : undefined
  return {
    id,
    ...(typeof preset.name === 'string' && preset.name.length > 0 ? { name: preset.name } : {}),
    ...(typeof preset.description === 'string' ? { description: preset.description } : {}),
    ...(order === undefined ? {} : { order }),
    plugins: [],
  }
}

/** 将插件自有预设登记到官方服务，并拥有每份登记的 disposer。 */
export function createPresetRegistrySync(ctx: Context, root: string): {
  refresh: (forceIds?: readonly string[]) => Promise<void>
  owns: (id: string) => boolean
  dispose: () => Promise<void>
} {
  const registrations = new Map<string, Registration>()
  let queue = Promise.resolve()
  let closed = false
  const refresh = (forceIds?: readonly string[]): Promise<void> => {
    const targets = forceIds === undefined ? undefined : new Set(forceIds)
    const turn = queue.then(async () => {
      if (closed) return
      const errors: unknown[] = []
      // 目录被删除才撤销登记；清单会跳过损坏的 preset.yml。
      for (const [id, current] of registrations) {
        if (targets !== undefined && !targets.has(id)) continue
        try {
          if (presetDirExists(root, id)) continue
          await current.dispose()
          registrations.delete(id)
        } catch (error) { errors.push(error) }
      }
      for (const id of targets ?? listPresets(root).map((preset) => preset.id)) {
        try {
          if (!presetDirExists(root, id)) continue
          const definition = readDefinition(root, id)
          const current = registrations.get(id)
          // 显示元数据变了才重登记；目录仍在且元数据未变时幂等跳过。
          if (current !== undefined && current.fingerprint === JSON.stringify(definition)) continue
          if (current !== undefined) {
            await current.dispose()
            registrations.delete(id)
          }
          const dispose = await ctx.agentPresets.register(definition)
          registrations.set(id, { dispose, fingerprint: JSON.stringify(definition) })
        } catch (error) {
          errors.push(error)
          ctx.logger?.warn?.(`prompt-tool: 预设 ${id} 登记失败：${String(error)}`)
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, `预设登记刷新失败：${errors.map(String).join('；')}`)
    })
    // 保留当前调用的失败结果；下次刷新仍可重试。
    queue = turn.catch(() => {})
    return turn
  }
  return {
    refresh,
    // 身份判定按存储根，不按登记状态：登记只是一个空壳，用来让宿主找得到 id。
    owns: (id) => !closed && presetDirExists(root, id),
    dispose: async () => {
      closed = true
      await queue
      const results = await Promise.allSettled([...registrations.values()].map((registration) => registration.dispose()))
      registrations.clear()
      const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason)
      if (errors.length > 0) throw new AggregateError(errors, '预设登记释放失败')
    },
  }
}
