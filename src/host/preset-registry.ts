import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import type { Context } from '@deepseek-ai/cordis'
import { entryListProblem } from '@deepseek-ai/dsh-agent-preset-registry'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { listPresets, loadPresetSpec } from './manifest.ts'

type Registration = { definition: PresetDefinition; fingerprint: string; dispose: () => Promise<void> }

function readDefinition(root: string, id: string): PresetDefinition {
  const preset = loadPresetSpec(join(root, id))
  const file = join(root, id, 'agent.cordis.yml')
  const source = readFileSync(file, 'utf8')
  // 保留官方 Loader 的延迟表达式标记；不能把 !!js 当普通字符串或在宿主提前执行。
  const plugins = parse(source, {
    version: '1.2',
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (__jsExpr: string) => ({ __jsExpr }) }],
  })
  const problem = entryListProblem(plugins)
  if (problem !== undefined) throw new Error(`预设 ${preset.id}：${problem}`)
  const order = typeof preset.order === 'number' && Number.isFinite(preset.order) ? preset.order : undefined
  return {
    id,
    ...(typeof preset.name === 'string' && preset.name.length > 0 ? { name: preset.name } : {}),
    ...(typeof preset.description === 'string' ? { description: preset.description } : {}),
    ...(order === undefined ? {} : { order }),
    plugins: plugins as PresetDefinition['plugins'],
  }
}

/** Register generated user preset compositions with the v0.1.7 registry. */
export function createPresetRegistrySync(ctx: Context, root: string): {
  refresh: (forceIds?: readonly string[]) => Promise<void>
  dispose: () => Promise<void>
} {
  const registrations = new Map<string, Registration>()
  let queue = Promise.resolve()
  let closed = false
  const refresh = (forceIds: readonly string[] = []): Promise<void> => {
    const turn = queue.then(async () => {
      if (closed) return
      const errors: unknown[] = []
      // 清单会跳过损坏的 preset.yml；只有目录确实被删除才撤销旧注册。
      for (const [id, current] of registrations) {
        try {
          if (statSync(join(root, id), { throwIfNoEntry: false }) !== undefined) continue
          await current.dispose()
          registrations.delete(id)
        } catch (error) { errors.push(error) }
      }
      for (const preset of listPresets(root, { includeCompatibility: true })) {
        try {
          const definition = readDefinition(root, preset.id)
          const fingerprint = JSON.stringify(definition)
          const current = registrations.get(preset.id)
          if (current?.fingerprint === fingerprint && !forceIds.includes(preset.id)) continue
          // register 使用调用方 Context.baseUrl 解析所有相对插件与 include 路径。
          const registry = ctx.extend({ baseUrl: pathToFileURL(join(root, preset.id, 'agent.cordis.yml')).href }).agentPresets
          const register = async (candidate: PresetDefinition): Promise<() => Promise<void>> => {
            const dispose = await registry.register(candidate)
            try {
              const result = await registry.resolve(candidate.id)
              if (result.broken !== undefined) throw new Error(result.broken)
              return dispose
            } catch (error) {
              await dispose()
              throw error
            }
          }
          if (current !== undefined) {
            // 官方不提供原子 replace。先审计临时候选，失败时旧定义和 revision 均不动。
            const discard = await register({ ...definition, id: `prompt-tool-candidate-${randomUUID()}` })
            await discard()
            await current.dispose()
            registrations.delete(preset.id)
          }
          try {
            const dispose = await register(definition)
            registrations.set(preset.id, { definition, fingerprint, dispose })
          } catch (error) {
            if (current !== undefined) {
              const dispose = await register(current.definition)
              registrations.set(preset.id, { ...current, dispose })
            }
            throw error
          }
        } catch (error) {
          errors.push(error)
          ctx.logger?.warn?.(`prompt-tool: 预设 ${preset.id} 注册刷新失败：${String(error)}`)
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, '预设注册刷新失败')
    })
    // 保留当前调用的失败结果；下次刷新仍可重试。
    queue = turn.catch(() => {})
    return turn
  }
  return {
    refresh,
    dispose: async () => {
      closed = true
      await queue
      const results = await Promise.allSettled([...registrations.values()].map((registration) => registration.dispose()))
      registrations.clear()
      const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason)
      if (errors.length > 0) throw new AggregateError(errors, '预设注册释放失败')
    },
  }
}
