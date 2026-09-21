/**
 * 提示词配置权威校验：给 settings bridge 与未来的提示词配置编辑器共用。
 *
 * 校验分两层：
 *   1. 最小结构校验（本文件）：promptConfigs 必须是数组、元素必须是对象、
 *      id 必须是非空字符串——settings 保存前就能给出逐条错误；
 *   2. 权威校验（引擎）：复用 engine/prompt-config-engine.mjs 的
 *      createPromptConfigs 逐条校验枚举与字段约束，错误消息与引擎挂载时一致。
 *
 * 校验过程只读不写：不写 settings、不重建生成目录，调用方可以安全地在
 * 保存前反复调用。
 */
import type { PromptConfigFile, PromptConfigSpec } from '../host/prompt-configs.ts'
import { configFileName, renderPromptConfigYaml } from '../host/prompt-configs.ts'
import { packageEngineDir } from '../host/manifest.ts'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface PromptConfigValidationError {
  /** 数组下标；结构层整组错误为 -1。 */
  index: number
  /** 该条配置的 id（缺失或非字符串时为空串）。 */
  id: string
  /** 引擎或结构层错误消息（保留 configs[i] 前缀）。 */
  message: string
}

export interface PromptConfigValidationResult {
  valid: boolean
  errors: PromptConfigValidationError[]
  /** valid=true 时回显归一化前的输入数组（调用方预览用）。 */
  configs?: PromptConfigSpec[]
  /** valid=true 时逐条渲染的 yml 模块预览（与生成目录同构）。 */
  files?: PromptConfigFile[]
}

/** 数组整体不是数组时返回单条 -1 错误；元素问题逐条收集。 */
function shapeErrors(value: unknown): PromptConfigValidationError[] {
  if (!Array.isArray(value)) {
    return [{ index: -1, id: '', message: 'promptConfigs must be an array' }]
  }
  const errors: PromptConfigValidationError[] = []
  const seenIds = new Set<string>()
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index]
    const label = `configs[${index}]`
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      errors.push({ index, id: '', message: `${label} must be an object` })
      continue
    }
    const record = item as Record<string, unknown>
    const id = record.id
    if (typeof id !== 'string' || id.length === 0) {
      errors.push({ index, id: typeof id === 'string' ? id : '', message: `${label}.id must be a non-empty string` })
    } else if (seenIds.has(id)) {
      errors.push({ index, id, message: `${label} duplicate id ${JSON.stringify(id)} (后者覆盖前者会静默丢卡)` })
    } else {
      seenIds.add(id)
    }
  }
  return errors
}

/**
 * 逐条调用引擎权威校验并渲染预览文件。
 * 逐条（而非整组一次）校验保证一条坏配置不吞掉其余错误，且 index 可直接映射。
 */
export async function validatePromptConfigs(value: unknown, options: { strategyDir?: string; presetDir?: string } = {}): Promise<PromptConfigValidationResult> {
  const errors = shapeErrors(value)
  if (errors.length > 0 || !Array.isArray(value)) return { valid: false, errors }
  const specs = value as PromptConfigSpec[]
  // 与 bridge /meta 共用包根解析，源码 src/runtime 与打包 lib 路径均可调用。
  const engineUrl = pathToFileURL(join(packageEngineDir(), 'prompt-config-engine.mjs'))
  const { createPromptConfigs } = await import(engineUrl.href) as {
    createPromptConfigs: (specs: unknown[], options?: { strategyDir?: string; templateBaseUrl?: string }) => unknown
  }
  const engineOptions = {
    ...(options.strategyDir ? { strategyDir: options.strategyDir } : {}),
    ...(options.presetDir ? { templateBaseUrl: pathToFileURL(join(dirname(options.presetDir), '.engine', 'schema.mjs')).href } : {}),
  }
  const files: PromptConfigFile[] = []
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index]
    const id = spec !== null && typeof spec === 'object' && typeof (spec as { id?: unknown }).id === 'string'
      ? (spec as { id: string }).id
      : ''
    try {
      createPromptConfigs([spec], engineOptions)
      // 文件名与 YAML 渲染同样属于写盘前校验，不能等写盘后才暴露非法 id。
      files.push({ file: configFileName(index * 10, spec!.id), content: renderPromptConfigYaml(spec!) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push({ index, id, message })
    }
  }
  if (errors.length > 0) return { valid: false, errors }
  return { valid: true, errors: [], configs: specs, files }
}
