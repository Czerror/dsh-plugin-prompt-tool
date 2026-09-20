/**
 * writer 投影事实：这些 promptConfig 字段在每次重建（writePreset 物化）时都由预设级
 * 扁平参数覆写，所以在实例卡里只能是只读回显，唯一写入口是来源参数本身
 * （能力卡或工具管线共享设置区里的同名控件）。
 *
 * 契约的目的：让前端按「配置 id + 字段路径 → 来源参数」消费同一份事实，
 * 而不是在组件里散写 `id === 'near-anchor'` 之类的特判；host 侧的真实投影行为
 * 由 `test/host/managed-config-fields.test.mjs` 按 writer 产物逐字段锁定。
 */
import type { EngineParamKey } from './engine-params.ts'

export interface ManagedConfigField {
  /** 配置内的字段路径：`params.<键>` 或顶层字段名（`enabled` / `modelScope`）。 */
  path: string
  /** 唯一来源的预设级扁平参数键。 */
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

/** 受 writer 管理、因此不能在实例卡里写值的配置字段。 */
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
      { path: 'params.useCustom', sourceParam: 'guideCustom' },
      { path: 'params.text', sourceParam: 'guideText' },
      { path: 'params.complexPattern', sourceParam: 'complexPattern' },
      { path: 'params.guideWeak', sourceParam: 'guideWeak' },
      { path: 'params.guideDeep', sourceParam: 'guideDeep' },
    ],
  },
]

export function managedConfigSpec(configId: string | undefined): ManagedConfigSpec | undefined {
  if (configId === undefined) return undefined
  return MANAGED_CONFIG_FIELDS.find((spec) => spec.configId === configId)
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
