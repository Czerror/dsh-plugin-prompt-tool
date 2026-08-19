/**
 * write-preset — 单一参数 YAML 驱动的预设生成目录物化器。
 *
 * 用户只需编写 preset/<template>/preset.yml(纯参数):
 *   meta + content + modules(模块清单)+ params(直读参数)+ 可选 promptConfigs 覆盖。
 * 默认提示词配置与组合 token 都由引擎按 params 生成,参数文件不含任何模板语法。
 */

import { writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { DEFAULT_PRESET_DIR } from '../config.ts'
import {
  buildDefaultPromptConfigs,
  loadPromptConfigFiles,
  mergePromptConfigs,
  renderPromptConfigYaml,
} from './prompt-configs.ts'
import type { PromptConfigSpec } from './prompt-configs.ts'
import {
  loadCompositionText,
  loadPresetSpec,
  packageEngineDir,
  packagePresetDir,
  renderTemplateVariables,
  resolvePresetParams,
  resolvePresetTokens,
} from './manifest.ts'

const PRESETS_DIR = packagePresetDir()
const ENGINE_DIR = packageEngineDir()

export interface WritePresetOptions {
  anchorFirstTurn: boolean
  anchorText: string
  anchorCustom: boolean
  guideText: string
  guideCustom: boolean
  injectPrompt: boolean
  subagentFlash: boolean
  subagentFlashProvider: string
  subagentFlashModel: string
  bootstrapMaxTokens: number
  usePtcMode: boolean
  /** 写入 agents-instruction.txt 供 instruction-hint 配置读取;不传则使用本地默认 hint。 */
  agentsInstructionText?: string
  presetDir: string
  presetOrder: number
  /** settings 层用户自定义提示词配置(优先级最高)。 */
  promptConfigs: PromptConfigSpec[]
  /** 用户自定义提示词配置目录(优先级低于 promptConfigs)。 */
  promptConfigsDir: string
  /** 预设模板名(preset/<name>);默认 anchored(兼容期)。 */
  presetTemplate?: string
  /** 目录加载失败等非致命告警回调。 */
  warn?: (message: string) => void
}

function runtimeOf(options: WritePresetOptions, prompt: string): Record<string, unknown> {
  return {
    promptText: prompt,
    anchorFirstTurn: options.anchorFirstTurn === true,
    anchorCustom: options.anchorCustom === true,
    anchorText: typeof options.anchorText === 'string' ? options.anchorText : '',
    guideCustom: options.guideCustom === true,
    guideText: typeof options.guideText === 'string' ? options.guideText : '',
    injectPrompt: options.injectPrompt !== false,
    usePtcMode: options.usePtcMode !== false,
    bootstrapMaxTokens: Number.isSafeInteger(options.bootstrapMaxTokens) ? options.bootstrapMaxTokens : 0,
    subagentFlash: options.subagentFlash === true,
    subagentFlashProvider: typeof options.subagentFlashProvider === 'string' && options.subagentFlashProvider.length > 0
      ? options.subagentFlashProvider
      : 'deepseek-official',
    subagentFlashModel: typeof options.subagentFlashModel === 'string' && options.subagentFlashModel.length > 0
      ? options.subagentFlashModel
      : 'deepseek-v4-flash',
  }
}

const asString = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback)

/** 把任意单一参数预设模板物化到生成目录;全部失败 fail loud。 */
export function writePreset(prompt: string, options: WritePresetOptions): void {
  // 空路径兜底:旧版 UI 保存的空串 presetDir 不得传入 mkdirSync('')。
  const presetDir = options.presetDir.trim().length > 0 ? options.presetDir : DEFAULT_PRESET_DIR
  const templateName = typeof options.presetTemplate === 'string' && options.presetTemplate.trim().length > 0
    ? options.presetTemplate.trim()
    : 'anchored'
  const templateDir = join(PRESETS_DIR, templateName)
  const spec = loadPresetSpec(templateDir)
  const runtime = runtimeOf(options, prompt)
  const params = resolvePresetParams(spec, runtime)
  const tokens = resolvePresetTokens(spec, runtime)

  mkdirSync(presetDir, { recursive: true })

  // 1) 组合文件:modules 模块库装配 + 引擎内部 token 渲染 + YAML 校验。
  const composition = renderTemplateVariables(loadCompositionText(spec), tokens)
  const unresolved = composition.match(/__[A-Z0-9_]+__/g)
  if (unresolved !== null) throw new Error(`generated agent.cordis.yml has unresolved variables: ${unresolved.join(', ')}`)
  const parsedComposition = parseYaml(composition, { logLevel: 'silent' })
  if (!Array.isArray(parsedComposition)) throw new Error(`generated agent.cordis.yml is not a YAML array (template ${templateName})`)
  writeFileSync(join(presetDir, 'agent.cordis.yml'), composition, 'utf8')

  // 2) 宿主预设元数据(模板 meta 参数 + 运行时 order)。
  const meta = spec.meta !== null && typeof spec.meta === 'object' ? spec.meta as Record<string, unknown> : {}
  writeFileSync(join(presetDir, 'preset.yml'), stringifyYaml({ ...meta, order: options.presetOrder }) + '\n', 'utf8')

  // 3) 项目本体:引擎目录整体复制(全部执行逻辑;预设只有参数)。
  const engineDir = join(presetDir, 'engine')
  rmSync(engineDir, { recursive: true, force: true })
  cpSync(ENGINE_DIR, engineDir, { recursive: true, force: true })

  // 4) 提示词配置:引擎默认(按 params)< 模板覆盖 < promptConfigsDir < settings。
  const promptConfigsDir = join(presetDir, 'prompt-configs')
  rmSync(promptConfigsDir, { recursive: true, force: true })
  mkdirSync(promptConfigsDir, { recursive: true })
  let dirConfigs: PromptConfigSpec[] = []
  if (options.promptConfigsDir.length > 0) {
    try {
      dirConfigs = loadPromptConfigFiles(options.promptConfigsDir)
    } catch (error) {
      options.warn?.(`prompt-tool: failed to load promptConfigsDir ${JSON.stringify(options.promptConfigsDir)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const engineDefaults = buildDefaultPromptConfigs({
    anchorFirstTurn: params.anchorFirstTurn === true,
    anchorCustom: params.anchorCustom === true,
    anchorText: asString(params.anchorText),
    guideCustom: params.guideCustom === true,
    guideText: asString(params.guideText),
    injectPrompt: params.injectPrompt !== false,
  }, prompt)
  const templateConfigs = Array.isArray(spec.promptConfigs) ? spec.promptConfigs as PromptConfigSpec[] : []
  const merged = mergePromptConfigs(engineDefaults, templateConfigs, dirConfigs, options.promptConfigs)
  for (const [index, config] of merged.entries()) {
    writeFileSync(join(promptConfigsDir, `${String(index * 10).padStart(2, '0')}-${config.id}.yml`), renderPromptConfigYaml(config), 'utf8')
  }

  // 5) 历史残留清理(模板参数声明,writer 只执行)。
  for (const legacy of spec.legacyCleanup ?? []) {
    rmSync(join(presetDir, legacy), { force: true })
  }

  // 6) agents-instruction.txt(模板内容资产经 settings 覆盖时写入)。
  const agentsInstructionPath = join(presetDir, 'agents-instruction.txt')
  if (options.agentsInstructionText !== undefined) {
    writeFileSync(agentsInstructionPath, options.agentsInstructionText, 'utf8')
  } else {
    rmSync(agentsInstructionPath, { force: true })
  }
}
