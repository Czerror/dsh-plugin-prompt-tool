/**
 * prompt-tool preset 核心(兼容层):
 *   - buildCordis:按单一参数 preset.yml 渲染 anchored 组合文件(不再做字符串补丁);
 *   - parseFrontmatter:skills frontmatter 解析。
 * 新代码请使用 src/host/ 下的 manifest / write-preset / prompt-configs / templates。
 */
import { parse as parseYaml } from 'yaml'
import { fileURLToPath } from 'node:url'
import {
  assertCompositionArray,
  loadCompositionText,
  loadPresetSpec,
  renderTemplateVariables,
  resolvePresetTokens,
} from './host/manifest.ts'

// anchored 预设模板目录(打包后 lib/ 与包根 preset/ 平级)。
const ANCHORED_TEMPLATE_DIR = fileURLToPath(new URL('../preset/anchored/', import.meta.url))

export interface SkillFrontmatter {
  name?: string
  description?: string
  whenToUse?: string
  metadata?: Record<string, unknown>
  /** 官方调用策略：true 时模型不可发现/不可加载（默认 false = 可调用）。 */
  disableModelInvocation?: boolean
  /** 官方调用策略：false 时用户命令不可加载（默认 true）。 */
  userInvocable?: boolean
}

import type { BuildCordisOptions } from './host/prompt-configs.ts'
export type { BuildCordisOptions, PromptConfigFile, PromptConfigSpec } from './host/prompt-configs.ts'
export { buildDefaultPromptConfigs, buildPromptConfigFiles, loadPromptConfigFiles, mergePromptConfigs, renderPromptConfigYaml } from './host/prompt-configs.ts'

const asBoolean = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)

// 解析 skills/*/SKILL.md 的 YAML frontmatter（name/description/whenToUse/metadata
// 与官方 disable-model-invocation / user-invocable 调用策略）。
// 使用正规 YAML 解析器，与 dsh 技能包的 filesystem provider 保持同一套字段来源。
// 容忍 UTF-8 BOM：Windows 记事本保存的文件会在 --- 前写入 EF BB BF，
// 不剥离会导致整个 frontmatter 匹配失败。
export function parseFrontmatter(text: string): { data: SkillFrontmatter; body: string } {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  if (!match) return { data: {}, body: source }
  const data: SkillFrontmatter = {}
  const doc = parseYaml(match[1]!, { logLevel: 'silent' }) as Record<string, unknown> | null
  if (doc !== null && typeof doc === 'object') {
    if (typeof doc.name === 'string') data.name = doc.name
    if (typeof doc.description === 'string') data.description = doc.description
    if (typeof doc.whenToUse === 'string') data.whenToUse = doc.whenToUse
    if (doc.metadata !== null && typeof doc.metadata === 'object') {
      data.metadata = doc.metadata as Record<string, unknown>
    }
    // 接受官方连字符字段与旧版驼峰字段；布尔语义与官方 filesystem provider 一致。
    const disable = asBoolean(doc['disable-model-invocation']) ?? asBoolean(doc.disableModelInvocation)
    if (disable !== undefined) data.disableModelInvocation = disable
    const userInvocable = asBoolean(doc['user-invocable']) ?? asBoolean(doc.userInvocable)
    if (userInvocable !== undefined) data.userInvocable = userInvocable
  }
  return { data, body: source.slice(match[0].length) }
}

/**
 * 渲染 anchored 组合文件:
 * agent.cordis.yml 是模板自带完整组合(含 router-first-turn 与 prompt-config-engine 行),
 * 动态值全部由 preset.yml 的 variables 声明为 __TOKEN__;本函数只做变量替换 + YAML 校验。
 */
export function buildCordis(prompt: string, options: BuildCordisOptions = {}): string {
  const spec = loadPresetSpec(ANCHORED_TEMPLATE_DIR)
  const runtime = {
    promptText: prompt,
    anchorFirstTurn: options.anchorFirstTurn === true,
    anchorCustom: options.anchorCustom === true,
    anchorText: typeof options.anchorText === 'string' ? options.anchorText : '',
    guideCustom: options.guideCustom === true,
    guideText: typeof options.guideText === 'string' ? options.guideText : '',
    injectPrompt: options.injectPrompt !== false,
    usePtcMode: options.usePtcMode !== false,
    bootstrapMaxTokens: Number.isSafeInteger(options.bootstrapMaxTokens) && (options.bootstrapMaxTokens ?? 0) > 0
      ? options.bootstrapMaxTokens
      : 0,
    subagentFlash: options.subagentFlash === true,
    subagentFlashProvider: typeof options.subagentFlashProvider === 'string' && options.subagentFlashProvider.length > 0
      ? options.subagentFlashProvider
      : 'deepseek-official',
    subagentFlashModel: typeof options.subagentFlashModel === 'string' && options.subagentFlashModel.length > 0
      ? options.subagentFlashModel
      : 'deepseek-v4-flash',
  }
  const tokens = resolvePresetTokens(spec, runtime)
  const out = renderTemplateVariables(loadCompositionText(spec), tokens)
  // 生成文件必须含引擎必需行，且引擎行指向提示词配置模块目录。
  const parsed = assertCompositionArray(out, spec)
  const ids = new Set(parsed.map((row) => (row as { id?: string } | null)?.id))
  if (!ids.has('router-first-turn')) throw new Error('generated agent.cordis.yml is missing the router-first-turn row')
  if (!ids.has('prompt-config-engine')) throw new Error('generated agent.cordis.yml is missing the prompt-config-engine row')
  const engine = parsed.find((row) => (row as { id?: string } | null)?.id === 'prompt-config-engine') as { config?: { configsDir?: string } } | undefined
  if (engine?.config?.configsDir !== '../prompt-configs') throw new Error('generated agent.cordis.yml prompt-config-engine row must point configsDir at ../prompt-configs')
  return out
}
