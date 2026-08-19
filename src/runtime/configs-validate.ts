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
import type { PromptConfigFile, PromptConfigSpec } from '../engine/prompt-configs.ts'
import { renderPromptConfigYaml } from '../engine/prompt-configs.ts'

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
    }
  }
  return errors
}

/**
 * 逐条调用引擎权威校验并渲染预览文件。
 * 逐条（而非整组一次）校验保证一条坏配置不吞掉其余错误，且 index 可直接映射。
 */
export async function validatePromptConfigs(value: unknown, options: { strategyDir?: string } = {}): Promise<PromptConfigValidationResult> {
  const errors = shapeErrors(value)
  if (errors.length > 0 || !Array.isArray(value)) return { valid: false, errors }
  const specs = value as PromptConfigSpec[]
  // 引擎与配置文件夹分离:包根 engine/ 与 lib/ 平级,../engine 相对路径成立。
  // strategyDir 让模板专属策略也能通过同一权威校验(当前 anchored 全部内置)。
  const engineUrl = new URL('../engine/prompt-config-engine.mjs', import.meta.url)
  const { createPromptConfigs } = await import(engineUrl.href) as {
    createPromptConfigs: (specs: unknown[], options?: { strategyDir?: string }) => unknown
  }
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index]
    const id = spec !== null && typeof spec === 'object' && typeof (spec as { id?: unknown }).id === 'string'
      ? (spec as { id: string }).id
      : ''
    try {
      createPromptConfigs([spec], typeof options.strategyDir === 'string' && options.strategyDir.length > 0
        ? { strategyDir: options.strategyDir }
        : {})
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push({ index, id, message })
    }
  }
  if (errors.length > 0) return { valid: false, errors }
  const files: PromptConfigFile[] = specs.map((spec, index) => ({
    file: `${String(index * 10).padStart(2, '0')}-${spec.id}.yml`,
    content: renderPromptConfigYaml(spec),
  }))
  return { valid: true, errors: [], configs: specs, files }
}
