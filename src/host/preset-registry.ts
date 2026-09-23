import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import type { Context } from '@deepseek-ai/cordis'
import { entryListProblem } from '@deepseek-ai/dsh-agent-preset-registry'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { listPresets, loadPresetSpec } from './manifest.ts'
import { PRESET_ENGINE_PREFIX } from './preset-install.ts'

type Registration = { definition: PresetDefinition; fingerprint: string; dispose: () => Promise<void> }

/**
 * 共享引擎模块的受管配置字段：值按**历史语义**相对 `<预设根>/.engine/` 书写
 * （如 `../<id>/prompt-configs`），装配期换算为绝对 `file://`。
 */
const MANAGED_FIELDS: Record<string, readonly string[]> = {
  'prompt-config-engine.mjs': ['configsDir', 'strategyDir'],
  'tool-config-engine.mjs': ['configsDir'],
  'subagent-tool-policy.mjs': ['policyFile'],
  'declared-triggers.mjs': ['triggersFile'],
}

/** 需要注入预设根基准的引擎模块——只有它们的 configContract 声明了 `presetRoot` 键。 */
const PRESET_ROOT_MODULES = new Set(['prompt-config-engine.mjs', 'tool-config-engine.mjs', 'declared-triggers.mjs'])

type AbsolutizeContext = {
  /** 预设目录 `<预设根>/<id>`：其它本地模块说明符的基准。 */
  presetDir: string
  /** 历史引擎位置 `<预设根>/.engine/`：受管配置字段的基准。 */
  engineDir: string
  /** 预设根 file URL（带尾斜杠）：注入给引擎做 `templateFile` 越界校验基准。 */
  presetRootUrl: string
}

function isJsExpr(value: unknown): boolean {
  return typeof value === 'object' && value !== null && typeof (value as { __jsExpr?: unknown }).__jsExpr === 'string'
}

/** 行名引用的共享引擎模块名；只认插件包的说明符前缀（不再兼容旧布局）。 */
function engineModuleOf(name: unknown): string | undefined {
  return typeof name === 'string' && name.startsWith(PRESET_ENGINE_PREFIX)
    ? name.slice(PRESET_ENGINE_PREFIX.length)
    : undefined
}

/** config 层换算：受管字段 → 绝对 `file://`；需要基准的引擎行注入预设根。 */
function absolutizeConfig(
  config: Record<string, unknown>, engineModule: string | undefined, context: AbsolutizeContext,
): Record<string, unknown> {
  const fields = engineModule === undefined ? undefined : MANAGED_FIELDS[engineModule]
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (fields !== undefined && fields.includes(key) && typeof value === 'string' && value.startsWith('.')) {
      out[key] = pathToFileURL(resolve(context.engineDir, value)).href
    } else out[key] = value
  }
  if (engineModule !== undefined && PRESET_ROOT_MODULES.has(engineModule)) out.presetRoot = context.presetRootUrl
  return out
}

/** 行级换算：只认行对象自己的 `name` 与 `config`，不误伤 config 里的同名业务字段。 */
function absolutizeRow(row: unknown, context: AbsolutizeContext): unknown {
  if (row === null || typeof row !== 'object' || Array.isArray(row) || isJsExpr(row)) return row
  const source = row as Record<string, unknown>
  const engineModule = engineModuleOf(source.name)
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) {
    if (key === 'name' && typeof item === 'string') {
      // 引擎行已是包名说明符，不改写；其余本地说明符按预设目录换算。
      out[key] = item.startsWith('.') && engineModule === undefined
        ? pathToFileURL(resolve(context.presetDir, item)).href
        : item
    } else if (key === 'config' && Array.isArray(item)) {
      // `cordis:group` 的子行列表：递归换算，组内引擎行同样成立。
      out[key] = item.map((child) => absolutizeRow(child, context))
    } else if (key === 'config' && item !== null && typeof item === 'object' && !isJsExpr(item)) {
      out[key] = absolutizeConfig(item as Record<string, unknown>, engineModule, context)
    } else out[key] = item
  }
  return out
}

/**
 * 装配期换算：把组合里的本地引用换成 Loader 与引擎都能解析的绝对形态。
 *
 * 三件事，全部只发生在内存注册定义，正本 `agent.cordis.yml` 一字不改：
 * 1. **本地模块说明符**（`name` 以 `.` 开头）：相对预设目录 → 绝对 `file://`。注册用的 Loader
 *    树必须以**宿主锚点**建（`register()` 取调用方 ctx 的 `baseUrl` 解析每一行），否则组合内的
 *    包名行会从预设目录起解析、整份注册被拒；锚点归宿主后，预设目录内的相对说明符必须在此换算。
 * 2. **受管配置字段**（`configsDir` / `strategyDir` / `policyFile` / `triggersFile`）：按历史语义
 *    相对 `<预设根>/.engine/` 解析为绝对 `file://`。引擎由插件包提供后其 `import.meta.url` 不再
 *    位于该目录，`file://` 也是对全部受管字段一致有效的唯一形态。
 * 3. **预设根基准**：给需要 `templateFile` 越界校验的引擎行注入 `presetRoot`。
 *
 * 共享引擎行本身写 `dsh-plugin-prompt-tool/engine/*.mjs`（由生成侧 `rewritePresetEngineReferences`
 * 产出），本函数不改写它。**不兼容旧预设**：仍写 `./engine/`、`../.engine/` 的预设按普通本地
 * 说明符处理，指向已不再物化的目录并因此挂载失败，需重建后重新物化。
 */
export function absolutizeLocalModules(rows: unknown, presetDir: string): unknown {
  if (!Array.isArray(rows)) return rows
  const presetRoot = resolve(presetDir, '..')
  const context: AbsolutizeContext = {
    presetDir,
    engineDir: join(presetRoot, '.engine'),
    presetRootUrl: `${pathToFileURL(presetRoot).href}/`,
  }
  return rows.map((row) => absolutizeRow(row, context))
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
