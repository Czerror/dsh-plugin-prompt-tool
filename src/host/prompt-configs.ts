/**
 * 提示词配置数据接口：默认提示词配置构建、通用 YAML 渲染与多源合并。
 *
 * 这是「用户自定义注入内容 + 自定义注入层级位置」的功能层：
 *   1. settings.promptConfigs 数组
 *   2. 模块定义里的规则（`module.yml` 的 `rules`）
 * 两者按此优先级合并，同名 id 后者覆盖，新 id 追加在默认提示词配置之后。
 * 规则正文与切片归模块定义所有（`rules/<规则id>.yml`），UI 与运行时消费同一份切片。
 */
// 规则和文件身份使用引擎同一个边界校验。
import { assertRuleId } from '../../engine/rule-spec.mjs'
import type { RuleDefinition } from '../shared/rules.ts'

/**
 * `PromptConfigSpec` 各枚举字段的**运行期值清单**。
 *
 * 类型由它派生（`(typeof X)[number]`）；运行时仍由 `engine/schema.mjs` 的
 * `KNOWN_*` 权威校验，bridge 的 /meta 契约保护实际输出。
 *
 * 为什么不直接从引擎派生类型：枚举清单的权威是 `engine/schema.mjs` 的 `KNOWN_*`，
 * 那是没有 `.d.mts` 的纯 `.mjs`，在 TS 看来是 `any`，派生不出字面量联合。
 */
export const PROMPT_CONFIG_SPEC_ENUMS = {
  configKind: ['ordered', 'anchor'],
  role: ['user'],
  position: ['after-user', 'before-all', 'after-all'],
  dedupe: ['session', 'batch', 'none'],
  promotion: ['none', 'main', 'include-subagents'],
  audience: ['main', 'subagent'],
  modelScope: ['all', 'pro', 'flash'],
  mergeMode: ['separate', 'merged'],
} as const

/** 取上面某一条枚举的值联合。 */
type SpecEnum<K extends keyof typeof PROMPT_CONFIG_SPEC_ENUMS> = (typeof PROMPT_CONFIG_SPEC_ENUMS[K])[number]

export interface PromptConfigSpec {
  id: string
  name?: string
  enabled?: boolean
  strategy?: string
  layer?: string
  configKind?: SpecEnum<'configKind'>
  order?: number
  role?: SpecEnum<'role'>
  group?: string
  exclusive?: boolean
  position?: SpecEnum<'position'>
  dedupe?: SpecEnum<'dedupe'>
  promotion?: SpecEnum<'promotion'>
  /** 消息受众：缺省（省略/null）= 公用（主会话+子代理）；main=仅主会话；subagent=仅子代理。 */
  audience?: SpecEnum<'audience'> | null
  modelScope?: SpecEnum<'modelScope'>
  sourceKind?: string
  form?: string
  summary?: string
  identity?: { field: 'plugin'; value: string }
  text?: string
  /** 单条提示词配置的多段文本：注入为一条消息的多个 text 内容块。 */
  texts?: string[]
  /** 同位置多条提示词配置的插入方式：separate=先后插入独立消息（默认）；merged=拼接为一条消息。 */
  mergeMode?: SpecEnum<'mergeMode'>
  templateFile?: string
  fill?: string
  variables?: Record<string, string>
  params?: Record<string, unknown>
}

/**
 * 提示词配置 / 自定义工具 ID 的安全文件名段校验：ID 直接拼进生成文件名
 * （prompt-configs/<n>-<id>.yml / custom-tools/<n>-<id>.yml），含路径分隔符
 * 或 Windows 非法字符会越出生成目录或写盘失败，保存/物化前 fail loud 拒绝。
 * 允许 [a-zA-Z0-9._-] 与常见中文/多字节字符（ST 导入 id 含中文），
 * 仅拒绝分隔符、控制字符、点目录与 Windows 保留字符。
 */
export function assertSafeConfigId(id: string): void {
  assertRuleId(id)
  if (id.startsWith('_')) throw new Error('规则 id 不得以下划线开头（保留命名空间）')
}

/** 生成文件名统一 4 位零填充前缀（0000-…），超过 10 条后字典序仍稳定。 */
export function configFileName(index: number, id: string): string {
  assertSafeConfigId(id)
  return `${String(index).padStart(4, '0')}-${id}.yml`
}
/** 模型采样参数生成与装配判定共用同一规则；空值不产生请求配置。 */
export function modelRequestRules(params: Record<string, unknown>): RuleDefinition[] {
  const patchOf = (prefix: 'model' | 'subagent'): Record<string, unknown> => {
    const patch: Record<string, unknown> = {}
    const effort = params[`${prefix}ReasoningEffort`]
    const temperature = params[`${prefix}Temperature`]
    const maxTokens = params[`${prefix}MaxTokens`]
    if (typeof effort === 'string' && effort.trim().length > 0) patch.reasoningEffort = effort.trim()
    const temp = typeof temperature === 'string' ? Number(temperature.trim()) : temperature
    if (typeof temp === 'number' && Number.isFinite(temp) && String(temperature).trim().length > 0) patch.temperature = temp
    const tokens = typeof maxTokens === 'string' ? Number(maxTokens.trim()) : maxTokens
    if (typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens > 0 && String(maxTokens).trim().length > 0) patch.maxTokens = tokens
    return patch
  }
  const rules: RuleDefinition[] = []
  const add = (id: string, name: string, audience: 'main' | 'subagent', patch: Record<string, unknown>): void => {
    if (Object.keys(patch).length > 0) rules.push({
      id, name, layer: 'agent-request', if: { scope: { audience } },
      then: [{ id: 'request', kind: 'request-params', patch }],
    })
  }
  const mainPatch = patchOf('model')
  // 固定主模型归当前预设的请求，不经全局默认模型服务回写。
  if (typeof params.modelProvider === 'string' && params.modelProvider.trim().length > 0
    && typeof params.modelName === 'string' && params.modelName.trim().length > 0) {
    mainPatch.provider = params.modelProvider.trim()
    mainPatch.model = params.modelName.trim()
  }
  add('param-model-params', '模型参数（主对话）', 'main', mainPatch)
  const subagentPatch = patchOf('subagent')
  // 本地子代理请求路由；不改写官方委派工具的创建参数或外部子代理运行时。
  if (typeof params.subagentModelProvider === 'string' && params.subagentModelProvider.trim().length > 0
    && typeof params.subagentModelName === 'string' && params.subagentModelName.trim().length > 0) {
    subagentPatch.provider = params.subagentModelProvider.trim()
    subagentPatch.model = params.subagentModelName.trim()
  }
  add('param-subagent-model-params', '模型参数（子代理）', 'subagent', subagentPatch)
  return rules
}

