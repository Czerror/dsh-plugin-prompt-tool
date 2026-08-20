/**
 * write-preset — 单一参数 YAML 驱动的预设生成目录物化器。
 *
 * 用户只需编写 preset/<template>/preset.yml(纯参数):
 *   meta + content + modules(模块清单)+ params(直读参数)+ 可选 promptConfigs 覆盖。
 * 默认提示词配置与组合 token 都由引擎按 params 生成,参数文件不含任何模板语法。
 */

import { writeFileSync, mkdirSync, rmSync, cpSync, mkdtempSync, renameSync, existsSync, readdirSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import { DEFAULT_PRESET_DIR } from './paths.ts'
import {
  loadPromptConfigFiles,
  mergePromptConfigs,
  renderPromptConfigYaml,
} from './prompt-configs.ts'
import type { PromptConfigSpec } from './prompt-configs.ts'
import {
  assertCompositionArray,
  asString,
  loadPresetSpec,
  packageEngineDir,
  resolvePresetDir,
  renderComposition,
  resolvePresetParams,
} from './manifest.ts'

const ENGINE_DIR = packageEngineDir()

export interface WritePresetOptions {
  firstTurnAnchor: boolean
  firstTurnText: string
  firstTurnCustom: boolean
  guideText: string
  guideCustom: boolean
  injectPrompt: boolean
  subagentFlashProvider: string
  subagentFlashModel: string
  /** 子代理独立 persona（per-child shadow；缺省回退 flashPersona，两者缺省=继承主会话）。 */
  subagentPersona?: string
  /** 子代理工具集白名单（toolFilter.allow；支持数组或逗号/空格分隔字符串）。 */
  subagentToolFilterAllow?: string[] | string
  /** 子代理工具集黑名单（toolFilter.deny）。 */
  subagentToolFilterDeny?: string[] | string
  /** 子代理递归深度上限（0 禁止委派 / provider-managed / 正整数）。 */
  subagentMaxDepth?: number | 'provider-managed'
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
    firstTurnAnchor: options.firstTurnAnchor === true,
    firstTurnCustom: options.firstTurnCustom === true,
    firstTurnText: typeof options.firstTurnText === 'string' ? options.firstTurnText : '',
    guideCustom: options.guideCustom === true,
    guideText: typeof options.guideText === 'string' ? options.guideText : '',
    injectPrompt: options.injectPrompt !== false,
    usePtcMode: options.usePtcMode !== false,
    bootstrapMaxTokens: Number.isSafeInteger(options.bootstrapMaxTokens) ? options.bootstrapMaxTokens : 0,
    subagentFlashProvider: typeof options.subagentFlashProvider === 'string' && options.subagentFlashProvider.length > 0
      ? options.subagentFlashProvider
      : '',
    subagentFlashModel: typeof options.subagentFlashModel === 'string' && options.subagentFlashModel.length > 0
      ? options.subagentFlashModel
      : '',
    subagentPersona: typeof options.subagentPersona === 'string' && options.subagentPersona.length > 0
      ? options.subagentPersona
      : '',
    subagentToolFilterAllow: options.subagentToolFilterAllow,
    subagentToolFilterDeny: options.subagentToolFilterDeny,
    subagentMaxDepth: options.subagentMaxDepth,
  }
}

/** 把任意单一参数预设模板物化到生成目录;全部失败 fail loud。 */
export function writePreset(prompt: string, options: WritePresetOptions): void {
  // 空路径兜底:旧版 UI 保存的空串 presetDir 不得传入 mkdirSync('')。
  const presetDir = options.presetDir.trim().length > 0 ? options.presetDir : DEFAULT_PRESET_DIR
  const templateName = typeof options.presetTemplate === 'string' && options.presetTemplate.trim().length > 0
    ? options.presetTemplate.trim()
    : 'anchored'
  const templateDir = resolvePresetDir(templateName)
  const spec = loadPresetSpec(templateDir)
  const runtime = runtimeOf(options, prompt)
  const params = resolvePresetParams(spec, runtime)

  const parentDir = dirname(presetDir)
  mkdirSync(parentDir, { recursive: true })
  const tmpDir = mkdtempSync(join(parentDir, `.${basename(presetDir)}.tmp-`))
  const outDir = tmpDir
  try {
  // 0) 保留用户参数覆盖文件（重建/升级不丢用户修改；随预设隔离）。
  const overridesSrc = join(presetDir, 'prompt-tool.overrides.yml')
  if (existsSync(overridesSrc)) {
    cpSync(overridesSrc, join(outDir, 'prompt-tool.overrides.yml'), { force: true })
  }

  // 1) 组合文件:modules 模块库装配 + token 渲染 + moduleConfigs 行级合并 + YAML 校验。
  const composition = renderComposition(spec, runtime, templateDir)
  assertCompositionArray(composition, spec)
  writeFileSync(join(outDir, 'agent.cordis.yml'), composition, 'utf8')

  // 2) 宿主预设元数据(模板 meta 参数 + 运行时 order)。
  const meta = spec.meta !== null && typeof spec.meta === 'object' ? spec.meta as Record<string, unknown> : {}
  writeFileSync(join(outDir, 'preset.yml'), stringifyYaml({ ...meta, order: options.presetOrder }) + '\n', 'utf8')

  // 2.5) 内容资产:preset.md / agents.md(与组合文件同层;大文本存文件而非 settings)。
  writeFileSync(join(outDir, 'preset.md'), prompt, 'utf8')
  writeFileSync(join(outDir, 'agents.md'), options.agentsInstructionText ?? '', 'utf8')

  // 2.6) 模板目录本地文件复制（官方格式预设的组合引用 ./xxx.mjs 等相对路径模块，
  // 必须随预设进入生成目录；跳过定义文件 preset.yml / agent.cordis.yml 与
  // 内容资产 preset.md / agents.md——后者由运行时 prompt 决定）。
  const templateEntries = readdirSync(templateDir, { withFileTypes: true })
  for (const entry of templateEntries) {
    if (entry.name === 'preset.yml' || entry.name === 'agent.cordis.yml'
      || entry.name === 'preset.md' || entry.name === 'agents.md') continue
    const source = join(templateDir, entry.name)
    const target = join(outDir, entry.name)
    if (entry.isDirectory()) cpSync(source, target, { recursive: true, force: true })
    else cpSync(source, target, { force: true })
  }

  // 3) 项目本体:引擎目录整体复制(全部执行逻辑;预设只有参数)。
  const engineDir = join(outDir, 'engine')
  rmSync(engineDir, { recursive: true, force: true })
  cpSync(ENGINE_DIR, engineDir, { recursive: true, force: true })

  // 4) 提示词配置:引擎默认(按 params)< 模板覆盖 < promptConfigsDir < settings。
  const promptConfigsDir = join(outDir, 'prompt-configs')
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
  const templateConfigs = Array.isArray(spec.promptConfigs) ? spec.promptConfigs as PromptConfigSpec[] : []
  let templateDefaults: PromptConfigSpec[]
  if (templateConfigs.length > 0) {
    // 模板自带默认提示词配置：运行时只覆盖 anchored 动态字段，结构数据来自 preset.yml。
    templateDefaults = templateConfigs.map((config) => {
      const next: PromptConfigSpec = { ...config, params: { ...config.params } }
      if (next.id === 'near-anchor') {
        next.enabled = params.firstTurnAnchor === true
        next.params = {
          ...next.params,
          useCustom: params.firstTurnCustom === true,
          firstTurnText: asString(params.firstTurnText),
          buildPattern: asString(params.buildPattern),
          complexPattern: asString(params.complexPattern),
          firstTurnBuild: asString(params.firstTurnBuild),
          firstTurnInspect: asString(params.firstTurnInspect),
          firstTurnDeep: asString(params.firstTurnDeep),
        }
      } else if (next.id === 'router-guide') {
        next.enabled = params.firstTurnAnchor === true
        // 自定义引导对所有模型注入（Pro/Flash），自动引导只服务 Flash 家族。
        const useCustom = params.firstTurnAnchor === true && params.guideCustom === true
        next.modelScope = useCustom ? 'all' : 'flash'
        next.params = {
          ...next.params,
          useCustom,
          text: asString(params.guideText),
          guideComplexPattern: asString(params.guideComplexPattern),
          guideWeak: asString(params.guideWeak),
          guideDeep: asString(params.guideDeep),
        }
      } else if (next.id === 'prompt-injector') {
        next.enabled = params.injectPrompt !== false
        next.params = { ...next.params, text: prompt, firstTurnWord: asString(params.firstTurnWord, 'we') }
      }
      return next
    })
  } else {
    // 通用模板未提供 promptConfigs 时，writer 不注入任何 anchored 默认配置；
    // 全部内容由模板数据或用户 settings 提供。
    templateDefaults = []
  }
  const merged = mergePromptConfigs(templateDefaults, dirConfigs, options.promptConfigs)
  for (const [index, config] of merged.entries()) {
    writeFileSync(join(promptConfigsDir, `${String(index * 10).padStart(2, '0')}-${config.id}.yml`), renderPromptConfigYaml(config), 'utf8')
  }

  // 5) 历史残留清理(模板参数声明,writer 只执行)。
  for (const legacy of spec.legacyCleanup ?? []) {
    rmSync(join(outDir, legacy), { force: true })
  }

  // 6) agents-instruction.txt(模板内容资产经 settings 覆盖时写入)。
  const agentsInstructionPath = join(outDir, 'agents-instruction.txt')
  if (options.agentsInstructionText !== undefined) {
    writeFileSync(agentsInstructionPath, options.agentsInstructionText, 'utf8')
  } else {
    rmSync(agentsInstructionPath, { force: true })
  }

  // 7) 原子提交:新目录完全写好后替换旧目录;失败时恢复旧目录并清理临时目录。
  const backupDir = join(parentDir, `.${basename(presetDir)}.bak-${Date.now().toString(36)}`)
  let oldMoved = false
  if (existsSync(presetDir)) {
    renameSync(presetDir, backupDir)
    oldMoved = true
  }
  try {
    renameSync(outDir, presetDir)
  } catch (error) {
    if (oldMoved) {
      try {
        renameSync(backupDir, presetDir)
      } catch {
        // 恢复失败时保留 backup 供人工处理,不再覆盖现场。
      }
    }
    throw error
  }
  if (oldMoved) rmSync(backupDir, { recursive: true, force: true })
  } catch (error) {
    rmSync(tmpDir, { recursive: true, force: true })
    throw error
  }
}
