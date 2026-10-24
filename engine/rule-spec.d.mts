/**
 * `rule-spec.mjs` 的手写声明：只声明 `src/` 与 `test/engine/` 消费的导出，形状按实现写实。
 *
 * 这里不复用插件侧类型（声明文件与 `.mjs` 同目录，`src/` 不在引擎的类型解析面内），
 * 只用结构等价的本地形状；被消费的字段与 `engine/rule-spec.mjs` 的产物逐名对应。
 */
import type { RuleAudience } from './audience.mjs'
export type { RuleAudience }

/** 编译后的动作；仅覆盖插件依赖面（装配侧只读 id/kind/channelOrder/waterfallPosition/compiledConfig）。 */
export interface CompiledRuleAction {
  id: string
  kind: string
  channelOrder: number
  waterfallPosition: string
  actionIndex: number
  /** inject-text 动作编译出的注入叶子；其余动作没有这个字段。 */
  compiledConfig?: Record<string, unknown>
  [key: string]: unknown
}

/** 编译后的规则；仅覆盖插件依赖面（装配侧只读 id/enabled/actions）。 */
export interface CompiledRule {
  id: string
  name?: string
  layer?: string
  enabled: boolean
  exclusive: boolean
  sequence: number
  actions: CompiledRuleAction[]
  [key: string]: unknown
}

/** `options.promptConfigOptions`：模板与策略的取法，交给 `schema.mjs#createPromptConfigs`。 */
export interface PromptConfigCompileOptions {
  templateBaseUrl?: URL
  templateModuleRoot?: URL
  strategyDir?: string
  loadTemplate?: (file: unknown) => unknown
}

export interface CompileRulesOptions {
  moduleId?: string
  sourceModuleId?: string
  configOrder?: Record<string, number>
  variables?: Record<string, string>
  variablesEnabled?: boolean
  contextActivationRecursive?: boolean
  /** 人设已独占 complete 段时拒绝第二条（宿主聚合用）。 */
  personaComplete?: boolean
  promptConfigOptions?: PromptConfigCompileOptions
  /** 挂载期输入：编译期显式剥掉，绑定由 `rule-runtime.mjs` 完成。 */
  ctx?: unknown
  standingMountFor?: unknown
}

/** 引擎编译出的注入配置叶子；只列编译必产出的字段，宿主按自己的 `PromptConfigSpec` 消费它。 */
export interface InjectionConfigSpec {
  id: string
  layer: string
  strategy?: string
  order?: number
  sourceKind?: string
  text?: string
  texts?: string[]
  templateFile?: string
  fill?: string
  variables?: Record<string, string>
  params?: Record<string, unknown>
}

/** 规则与动作的执行点目录（编辑器元数据）；结构等价于 `src/shared/rules.ts` 的 `RuleEditorMeta`。 */
export interface RuleEditorMeta {
  predicates: Array<{ kind: string; example: Record<string, unknown> }>
  actions: Array<{
    kind: string
    example: Record<string, unknown>
    channel: string
    phase: string
    lifecycle: 'event' | 'registration'
    supportsWhen: boolean
  }>
  composites: string[]
  waterfallPositions: string[]
}

/** 规则及物化身份的唯一安全边界；非法值抛 `TypeError`。 */
export function assertRuleId(id: unknown): void

export function compileRules(specs: readonly unknown[], options?: CompileRulesOptions): CompiledRule[]

/** 该受众下独占的 `complete` 系统段，身份是 `rule.id/action.id`。 */
export function completeRuleSections(rules: readonly unknown[], audience: RuleAudience): string[]



/** 动作级受众事实：规则级 when 与动作级 conditions 的合取；else 动作（bypassRuleWhen）只读动作条件。 */
export function actionAudiences(rule: unknown, actionId: string): Set<RuleAudience>

export function injectionConfigSpec(
  rule: { id: string; layer?: string },
  action: { id: string; kind?: string; config?: unknown },
  options?: { variables?: Record<string, string>; variablesEnabled?: boolean },
): InjectionConfigSpec

export function getRuleEditorMeta(): RuleEditorMeta
