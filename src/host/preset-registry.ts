import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import type { Context } from '@deepseek-ai/cordis'
import { entryListProblem } from '@deepseek-ai/dsh-agent-preset-registry'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { listPresets, loadPresetSpec } from './manifest.ts'

type Registration = { definition: PresetDefinition; fingerprint: string; dispose: () => Promise<void> }

function isJsExpr(value: unknown): boolean {
  return typeof value === 'object' && value !== null && typeof (value as { __jsExpr?: unknown }).__jsExpr === 'string'
}

/** 行级换算：只认行对象自己的 `name`，不误伤 config 里的同名业务字段。 */
function absolutizeRow(row: unknown, presetDir: string): unknown {
  if (row === null || typeof row !== 'object' || Array.isArray(row) || isJsExpr(row)) return row
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(row as Record<string, unknown>)) {
    if (key === 'name' && typeof item === 'string' && item.startsWith('.')) {
      out[key] = pathToFileURL(resolve(presetDir, item)).href
    } else if (key === 'config' && Array.isArray(item)) {
      // `cordis:group` 的子行列表：递归换算，组内相对引擎行同样成立。
      out[key] = item.map((child) => absolutizeRow(child, presetDir))
    } else out[key] = item
  }
  return out
}

/**
 * 装配期换算：把组合里的**本地模块说明符**（`name` 以 `.` 开头的行）换成绝对 file URL。
 *
 * 为什么必须换算：注册用的 Loader 树必须以**宿主锚点**建——`register()` 取调用方 ctx 的
 * `baseUrl` 解析每一行（`vendor/loader/lib/types/config/tree.js`），一旦把 baseUrl 改写成
 * 预设目录，组合内的包名行（`@deepseek-ai/dsh-*`）就会从预设目录起解析、向上找不到
 * node_modules，整份预设注册被拒。锚点回归宿主后，预设目录内按目录写的相对说明符
 * （`../.engine/prompt-config-engine.mjs`）才需要在这里换算。
 *
 * 为什么只换算 `name`：`configsDir` / `strategyDir` / `policyFile` / `triggersFile` 由引擎按
 * `import.meta.url`（`<预设根>/.engine/`）自解析，保持相对形态才继续成立；换算它们反而会让
 * `new URL()` 把盘符当 scheme 而拒绝。
 *
 * 换算只发生在内存里的注册定义，正本 `agent.cordis.yml` 一字不改——因此用户改 `DSH_HOME`
 * 或复制整个预设根后，下次注册会按新位置重新换算。
 */
export function absolutizeLocalModules(rows: unknown, presetDir: string): unknown {
  if (!Array.isArray(rows)) return rows
  return rows.map((row) => absolutizeRow(row, presetDir))
}

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
    plugins: absolutizeLocalModules(plugins, join(root, id)) as PresetDefinition['plugins'],
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
          // 不改写 baseUrl：Loader 树继承宿主锚点，包名行才解析得到；预设目录内的相对
          // 说明符已由 readDefinition 换算为绝对 file URL。
          const registry = ctx.agentPresets
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
