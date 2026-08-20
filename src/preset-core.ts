/**
 * prompt-tool preset 核心(兼容层):
 *   - buildCordis:按单一参数 preset.yml 渲染 anchored 组合文件(不再做字符串补丁)。
 * 新代码请使用 src/host/ 下的 manifest / write-preset / prompt-configs / templates。
 */
import { fileURLToPath } from 'node:url'
import {
  assertCompositionArray,
  loadPresetSpec,
  renderComposition,
} from './host/manifest.ts'

// anchored 预设模板目录(打包后 lib/ 与包根 preset/ 平级)。
const ANCHORED_TEMPLATE_DIR = fileURLToPath(new URL('../preset/anchored/', import.meta.url))

import type { BuildCordisOptions } from './host/prompt-configs.ts'
export type { BuildCordisOptions, PromptConfigFile, PromptConfigSpec } from './host/prompt-configs.ts'
export { buildDefaultPromptConfigs, buildPromptConfigFiles, loadPromptConfigFiles, mergePromptConfigs, renderPromptConfigYaml } from './host/prompt-configs.ts'

/**
 * 渲染 anchored 组合文件:
 * agent.cordis.yml 是模板自带完整组合(含 router-first-turn 与 prompt-config-engine 行),
 * 动态值全部由 preset.yml 的 variables 声明为 __TOKEN__;本函数只做变量替换 + YAML 校验。
 */
export function buildCordis(prompt: string, options: BuildCordisOptions = {}): string {
  const spec = loadPresetSpec(ANCHORED_TEMPLATE_DIR)
  const runtime = {
    promptText: prompt,
    firstTurnAnchor: options.firstTurnAnchor === true,
    firstTurnCustom: options.firstTurnCustom === true,
    firstTurnText: typeof options.firstTurnText === 'string' ? options.firstTurnText : '',
    guideCustom: options.guideCustom === true,
    guideText: typeof options.guideText === 'string' ? options.guideText : '',
    injectPrompt: options.injectPrompt !== false,
    usePtcMode: options.usePtcMode !== false,
    bootstrapMaxTokens: Number.isSafeInteger(options.bootstrapMaxTokens) && (options.bootstrapMaxTokens ?? 0) > 0
      ? options.bootstrapMaxTokens
      : 0,
    subagentFlashProvider: typeof options.subagentFlashProvider === 'string' && options.subagentFlashProvider.length > 0
      ? options.subagentFlashProvider
      : '',
    subagentFlashModel: typeof options.subagentFlashModel === 'string' && options.subagentFlashModel.length > 0
      ? options.subagentFlashModel
      : '',
  }
  const out = renderComposition(spec, runtime, ANCHORED_TEMPLATE_DIR)
  // 生成文件必须含引擎必需行，且引擎行指向提示词配置模块目录。
  const parsed = assertCompositionArray(out, spec)
  const ids = new Set(parsed.map((row) => (row as { id?: string } | null)?.id))
  if (!ids.has('router-first-turn')) throw new Error('generated agent.cordis.yml is missing the router-first-turn row')
  if (!ids.has('prompt-config-engine')) throw new Error('generated agent.cordis.yml is missing the prompt-config-engine row')
  const engine = parsed.find((row) => (row as { id?: string } | null)?.id === 'prompt-config-engine') as { config?: { configsDir?: string } } | undefined
  if (engine?.config?.configsDir !== '../prompt-configs') throw new Error('generated agent.cordis.yml prompt-config-engine row must point configsDir at ../prompt-configs')
  return out
}
