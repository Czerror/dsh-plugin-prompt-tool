/**
 * preset.yml 顶层 `persona` 段契约：与官方 `@deepseek-ai/dsh-persona` 行同构，
 * 由渲染层写入 `deployment:persona-prefix`（order 0）与
 * `deployment:persona-suffix`（order 10200）两段。
 * 旧 params.sectionName 人设写法不做运行时兼容，由离线脚本
 * scripts/migrate-presets.mjs 迁移。
 */

/** 组合模块库里官方人设行的模块名（engine/compositions/library/persona.yml）。 */
export const PERSONA_MODULE = 'persona'

/**
 * preset.yml 顶层 `persona` 段：与官方 `@deepseek-ai/dsh-persona` 行的 config 同构。
 * 官方 schema：prefix required、suffix 默认 ''、complete 默认 false、
 * includeRuntimeContext 默认 true。
 */
export interface PersonaSpec {
  /** `deployment:persona-prefix` 文本（第一方指导之前，官方 order 0）。 */
  prefix: string
  /** `deployment:persona-suffix` 文本（第一方指导之后，官方 order 10200）。 */
  suffix?: string
  /** prefix 独占整个 system prompt（抑制其余段与 suffix）。 */
  complete?: boolean
  /** false = 抑制该 scope 的动态 runtime-context 快照。 */
  includeRuntimeContext?: boolean
}

/** 读取 preset.yml persona 段；非对象或缺 prefix 返回 undefined（调用方按“未声明”处理）。 */
export function readPersonaSpec(value: unknown): PersonaSpec | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.prefix !== 'string') return undefined
  return {
    prefix: record.prefix,
    ...(typeof record.suffix === 'string' ? { suffix: record.suffix } : {}),
    ...(typeof record.complete === 'boolean' ? { complete: record.complete } : {}),
    ...(typeof record.includeRuntimeContext === 'boolean' ? { includeRuntimeContext: record.includeRuntimeContext } : {}),
  }
}

/** persona 段 → 官方行 config；默认值不落键（suffix ''、complete false、
 *  includeRuntimeContext true）。键顺序对齐官方 agent.cordis.yml 写法：
 *  suffix 在上、prefix 在下（prefix 常为长 block scalar，放末尾更易读）。 */
export function personaRowConfig(persona: PersonaSpec): Record<string, unknown> {
  return {
    ...(persona.suffix === undefined || persona.suffix === '' ? {} : { suffix: persona.suffix }),
    prefix: persona.prefix,
    ...(persona.complete === true ? { complete: true } : {}),
    ...(persona.includeRuntimeContext === false ? { includeRuntimeContext: false } : {}),
  }
}
