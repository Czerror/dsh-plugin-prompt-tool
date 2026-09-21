/** 受管字段白名单；实际来源必须由 writer 最终合并分支提供，不能仅凭 id 判定。 */
import type { EngineParamKey } from './engine-params.ts'

export interface ManagedConfigField {
  /** 配置内的字段路径：`params.<键>` 或顶层字段名（`enabled` / `modelScope`）。 */
  path: string
  /** 该字段由 writer 投影时使用的预设级扁平参数键。 */
  sourceParam: EngineParamKey
  /**
   * 计算结果而不是逐字映射：来源参数的组合结果（或集合开关），
   * 只读回显但不断言等于来源参数的字面值。
   */
  derived?: boolean
  /** 来源参数缺省（undefined）时的回落说明键，供只读回显标注真实生效语义。 */
  fallbackNote?: 'followsAnchor' | 'followsCustom'
}

export interface ManagedConfigSpec {
  /** writer 投影规则认的配置 id。 */
  configId: string
  fields: readonly ManagedConfigField[]
}

/** writer 可投影的字段白名单；是否确由参数投影由 ConfigFieldSources 决定。 */
export const MANAGED_CONFIG_FIELDS: readonly ManagedConfigSpec[] = [
  {
    configId: 'near-anchor',
    fields: [
      { path: 'enabled', sourceParam: 'firstTurnAnchor' },
      { path: 'params.useCustom', sourceParam: 'firstTurnCustom' },
      { path: 'params.text', sourceParam: 'firstTurnText' },
      { path: 'params.buildPattern', sourceParam: 'buildPattern' },
      { path: 'params.complexPattern', sourceParam: 'complexPattern' },
      { path: 'params.firstTurnBuild', sourceParam: 'firstTurnBuild' },
      { path: 'params.firstTurnInspect', sourceParam: 'firstTurnInspect' },
      { path: 'params.firstTurnDeep', sourceParam: 'firstTurnDeep' },
    ],
  },
  {
    configId: 'router-guide',
    fields: [
      // guideEnabled 显式声明优先；缺省跟随锚定开关。
      { path: 'enabled', sourceParam: 'guideEnabled', fallbackNote: 'followsAnchor' },
      // 自定义引导对所有模型注入，自动引导只服务 Flash 家族。
      { path: 'modelScope', sourceParam: 'guideCustom', derived: true, fallbackNote: 'followsCustom' },
      { path: 'params.useCustom', sourceParam: 'guideCustom', derived: true },
      { path: 'params.text', sourceParam: 'guideText' },
      { path: 'params.complexPattern', sourceParam: 'complexPattern' },
      { path: 'params.guideWeak', sourceParam: 'guideWeak' },
      { path: 'params.guideDeep', sourceParam: 'guideDeep' },
    ],
  },
]

export interface ConfigFieldSources {
  configId: string
  fields: Array<{ path: string; source: 'preset-param' | 'prompt-config' }>
}

/** 严格投影白名单；未知路径、参数键和附加属性都不进入客户端。 */
export function readConfigFieldSources(configId: string, raw: unknown): ConfigFieldSources | undefined {
  const spec = MANAGED_CONFIG_FIELDS.find((entry) => entry.configId === configId)
  if (spec === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  if (record.configId !== configId || !Array.isArray(record.fields)) return undefined
  const fields = spec.fields.flatMap(({ path }) => {
    const entry = (record.fields as unknown[]).find((item) => item !== null && typeof item === 'object'
      && (item as Record<string, unknown>).path === path) as Record<string, unknown> | undefined
    const source = entry?.source
    return source === 'preset-param' || source === 'prompt-config' ? [{ path, source } satisfies ConfigFieldSources['fields'][number]] : []
  })
  return { configId, fields }
}

/** 只有本次物化确由预设参数投影的字段才锁定；重命名或缺少事实均不按 id 猜测。 */
export function managedConfigSpec(configId: string | undefined, sources?: ConfigFieldSources): ManagedConfigSpec | undefined {
  if (configId === undefined || sources?.configId !== configId) return undefined
  const spec = MANAGED_CONFIG_FIELDS.find((entry) => entry.configId === configId)
  const fields = spec?.fields.filter((field) => sources.fields.some((entry) => entry.path === field.path && entry.source === 'preset-param')) ?? []
  return fields.length > 0 ? { configId, fields } : undefined
}

export function isManagedConfigField(config: { id: string; fieldSources?: ConfigFieldSources }, path: string): boolean {
  return managedConfigSpec(config.id, config.fieldSources)?.fields.some((field) => field.path === path) === true
}

/** 来源只用于读回；无论客户端传了什么来源，都不能写入预设定义。 */
export function stripConfigFieldSources<T extends { fieldSources?: unknown }>(config: T): Omit<T, 'fieldSources'> {
  const { fieldSources: _fieldSources, ...definition } = config
  return definition
}

/** 该受管字段在当前配置草稿里的值（只读回显用；缺失时返回 undefined）。 */
export function managedFieldValue(
  field: ManagedConfigField,
  config: { enabled?: boolean; modelScope?: string; params?: Record<string, unknown> },
): unknown {
  if (field.path === 'enabled') return config.enabled
  if (field.path === 'modelScope') return config.modelScope
  const key = field.path.replace(/^params\./, '')
  return config.params?.[key]
}
