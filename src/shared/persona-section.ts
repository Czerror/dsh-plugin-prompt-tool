/** 独立人设卡：按受众和字段覆盖；省略继承，空文本和 false 都是显式值。 */
export interface PersonaTargetSpec {
  prefix?: string
  suffix?: string
  complete?: boolean
  /** false 额外抑制动态上下文；true 不施加插件抑制，不撤销宿主自己的策略。 */
  includeRuntimeContext?: boolean
}

export interface PersonaSpec {
  main?: PersonaTargetSpec
  subagent?: PersonaTargetSpec
}

export interface PersonaSnapshot {
  persona: PersonaSpec | null
  /** 完整模块定义的原始字节版本，写入前核对。 */
  revision: string
}

export type PersonaAudience = 'main' | 'subagent'
export interface PersonaSources { main: string | null; subagent: string | null }
export interface PersonaSourcesSnapshot {
  sources: PersonaSources
  revision: string | null
  candidates: Array<{ id: string; name: string }>
  persisted?: boolean
  publicationPending?: boolean
  publicationError?: string
}
export interface PersonaSourcesRequest {
  sources?: PersonaSources
  expectedRevision?: string | null
  refreshOnly?: boolean
}

const FIELDS = ['prefix', 'suffix', 'complete', 'includeRuntimeContext'] as const

/** 已声明的非法值必须拒绝，不能吞成「继承」。 */
export function readPersonaSpec(value: unknown): PersonaSpec | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('persona 必须是对象')
  const record = value as Record<string, unknown>
  if (FIELDS.some(field => Object.hasOwn(record, field))) {
    throw new TypeError('旧扁平 persona 已退役；请重新导入或显式转换为 persona.main / persona.subagent')
  }
  for (const key of Object.keys(record)) if (key !== 'main' && key !== 'subagent') throw new TypeError(`未知人设受众：${key}`)
  const result: PersonaSpec = {}
  for (const audience of ['main', 'subagent'] as const) {
    const target = record[audience]
    if (target === undefined) continue
    if (target === null || typeof target !== 'object' || Array.isArray(target)) throw new TypeError(`persona.${audience} 必须是对象`)
    const source = target as Record<string, unknown>
    const parsed: PersonaTargetSpec = {}
    for (const key of Object.keys(source)) if (!FIELDS.includes(key as typeof FIELDS[number])) throw new TypeError(`未知人设字段：persona.${audience}.${key}`)
    for (const field of FIELDS) {
      const item = source[field]
      if (item === undefined) continue
      if (field === 'prefix' || field === 'suffix') {
        if (typeof item !== 'string') throw new TypeError(`persona.${audience}.${field} 必须是字符串`)
        if (new TextEncoder().encode(item).byteLength > 1024 * 1024) throw new TypeError(`persona.${audience}.${field} 超过 1 MiB`)
        parsed[field] = item
      } else {
        if (typeof item !== 'boolean') throw new TypeError(`persona.${audience}.${field} 必须是布尔值`)
        parsed[field] = item
      }
    }
    if (Object.keys(parsed).length > 0) result[audience] = parsed
  }
  return result
}
