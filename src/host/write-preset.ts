/**
 * write-preset — 单一参数 YAML 驱动的预设生成目录物化器。
 *
 * 用户只需编写 preset/<template>/preset.yml(纯参数):
 *   meta + content + modules(模块清单)+ params(直读参数)+ 可选 promptConfigs 覆盖。
 * 默认提示词配置与组合 token 都由引擎按 params 生成,参数文件不含任何模板语法。
 */

import { writeFileSync, mkdirSync, rmSync, cpSync, mkdtempSync, renameSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import { DEFAULT_PRESET_DIR } from './paths.ts'
import {
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
  modelProvider: string
  modelName: string
  /** 子代理固定模型路由 provider（agentOptions 注入 tool-subagent）。 */
  subagentModelProvider: string
  /** 子代理固定模型名。 */
  subagentModelName: string
  /** 主对话思维程度（agent-request patch reasoningEffort；''=不设置，官方档位 off/low/high/max）。 */
  modelReasoningEffort?: string
  /** 主对话采样温度（agent-request patch temperature；''=不设置）。 */
  modelTemperature?: string
  /** 主对话输出上限（agent-request patch maxTokens；''=不设置）。 */
  modelMaxTokens?: string
  /** 子代理思维程度（agent-request patch，audience=subagent；''=不设置）。 */
  subagentReasoningEffort?: string
  /** 子代理采样温度（agent-request patch，audience=subagent；''=不设置）。 */
  subagentTemperature?: string
  /** 子代理输出上限（agent-request patch，audience=subagent；''=不设置）。 */
  subagentMaxTokens?: string
  /** 子代理自定义模型人设（per-child shadow；缺省回退 mainPersona，两者缺省=继承主会话）。 */
  subagentPersona?: string
  /** 委派工具集白名单（toolFilter.allow；支持数组或逗号/空格分隔字符串）。 */
  toolFilterAllow?: string[] | string
  /** 委派工具集黑名单（toolFilter.deny）。 */
  toolFilterDeny?: string[] | string
  /** 委派递归深度上限（0 禁止委派 / provider-managed / 正整数）。 */
  maxDepth?: number | 'provider-managed' | string
  /** 主对话自定义模型人设（preset.yml mainPersona；覆盖模板默认）。 */
  mainPersona?: string
  /** 注入 kind 白名单（context-gate allowKinds；数组或逗号分隔字符串）。 */
  allowKinds?: string[] | string
  /** custom-fallback 锚定词（prompt-injector params.firstTurnWord）。 */
  firstTurnWord?: string
  bootstrapMaxTokens: number
  usePtcMode: boolean
  /** 写入 agents-instruction.txt 供 instruction-hint 配置读取;不传则使用本地默认 hint。 */
  agentsInstructionText?: string
  presetDir: string
  presetOrder: number
  /** settings 层用户自定义提示词配置(优先级最高)。 */
  promptConfigs: PromptConfigSpec[]
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
    modelProvider: typeof options.modelProvider === 'string' && options.modelProvider.length > 0
      ? options.modelProvider
      : '',
    modelName: typeof options.modelName === 'string' && options.modelName.length > 0
      ? options.modelName
      : '',
    subagentModelProvider: typeof options.subagentModelProvider === 'string' && options.subagentModelProvider.length > 0
      ? options.subagentModelProvider
      : '',
    subagentModelName: typeof options.subagentModelName === 'string' && options.subagentModelName.length > 0
      ? options.subagentModelName
      : '',
    // 模型参数空值不覆盖：spec.params（预设模板默认）保留，settings 显式值优先。
    modelReasoningEffort: typeof options.modelReasoningEffort === 'string' && options.modelReasoningEffort.length > 0
      ? options.modelReasoningEffort
      : undefined,
    modelTemperature: typeof options.modelTemperature === 'string' && options.modelTemperature.length > 0
      ? options.modelTemperature
      : undefined,
    modelMaxTokens: typeof options.modelMaxTokens === 'string' && options.modelMaxTokens.length > 0
      ? options.modelMaxTokens
      : undefined,
    subagentReasoningEffort: typeof options.subagentReasoningEffort === 'string' && options.subagentReasoningEffort.length > 0
      ? options.subagentReasoningEffort
      : undefined,
    subagentTemperature: typeof options.subagentTemperature === 'string' && options.subagentTemperature.length > 0
      ? options.subagentTemperature
      : undefined,
    subagentMaxTokens: typeof options.subagentMaxTokens === 'string' && options.subagentMaxTokens.length > 0
      ? options.subagentMaxTokens
      : undefined,
    subagentPersona: typeof options.subagentPersona === 'string' && options.subagentPersona.length > 0
      ? options.subagentPersona
      : '',
    // 工具过滤空值不覆盖：spec.params（预设模板默认）保留，settings/overrides 显式值优先。
    toolFilterAllow: options.toolFilterAllow !== undefined
      && (Array.isArray(options.toolFilterAllow) ? options.toolFilterAllow.length > 0 : String(options.toolFilterAllow).trim().length > 0)
      ? options.toolFilterAllow
      : undefined,
    toolFilterDeny: options.toolFilterDeny !== undefined
      && (Array.isArray(options.toolFilterDeny) ? options.toolFilterDeny.length > 0 : String(options.toolFilterDeny).trim().length > 0)
      ? options.toolFilterDeny
      : undefined,
    maxDepth: options.maxDepth,
    // 空值不覆盖：mainPersona 引擎必需非空（空串会触发 router-first-turn 抛错），
    // firstTurnWord 空应回退 preset.yml 模板默认（we）。
    mainPersona: typeof options.mainPersona === 'string' && options.mainPersona.trim().length > 0
      ? options.mainPersona
      : undefined,
    allowKinds: options.allowKinds,
    firstTurnWord: typeof options.firstTurnWord === 'string' && options.firstTurnWord.length > 0
      ? options.firstTurnWord
      : undefined,
  }
}

/** 模型参数（思维程度/温度/输出上限）→ agent-request 提示词配置（官方 LlmCallConfig patch 浅合并）。
 *  读合并后 params（preset.yml 模板默认 + settings/overrides 覆盖），空值不产生配置。 */
function modelRequestConfigs(params: Record<string, unknown>): PromptConfigSpec[] {
  const patchOf = (prefix: 'model' | 'subagent'): Record<string, unknown> => {
    const patch: Record<string, unknown> = {}
    const effort = params[`${prefix}ReasoningEffort`]
    const temperature = params[`${prefix}Temperature`]
    const maxTokens = params[`${prefix}MaxTokens`]
    if (typeof effort === 'string' && effort.trim().length > 0) patch.reasoningEffort = effort.trim()
    const temp = typeof temperature === 'string' ? Number(temperature) : NaN
    if (typeof temperature === 'string' && temperature.trim().length > 0 && Number.isFinite(temp)) patch.temperature = temp
    const tokens = typeof maxTokens === 'string' ? Number(maxTokens) : NaN
    if (typeof maxTokens === 'string' && maxTokens.trim().length > 0 && Number.isSafeInteger(tokens) && tokens > 0) patch.maxTokens = tokens
    return patch
  }
  const configs: PromptConfigSpec[] = []
  const mainPatch = patchOf('model')
  if (Object.keys(mainPatch).length > 0) {
    configs.push({ id: 'model-params', name: '模型参数（主对话）', layer: 'agent-request', audience: 'main', order: -100, params: { patch: mainPatch } })
  }
  const subagentPatch = patchOf('subagent')
  if (Object.keys(subagentPatch).length > 0) {
    configs.push({ id: 'subagent-model-params', name: '模型参数（子代理）', layer: 'agent-request', audience: 'subagent', order: -100, params: { patch: subagentPatch } })
  }
  return configs
}

/** 把任意单一参数预设模板物化到生成目录;全部失败 fail loud。 */
export function writePreset(prompt: string, options: WritePresetOptions): void {
  // 空路径兜底:旧版 UI 保存的空串 presetDir 不得传入 mkdirSync('')。
  const presetDir = options.presetDir.trim().length > 0 ? options.presetDir : DEFAULT_PRESET_DIR
  const templateName = typeof options.presetTemplate === 'string' && options.presetTemplate.trim().length > 0
    ? options.presetTemplate.trim()
    : 'anchored'
  // 安全边界：templateName 现在是写入路径段（presetDir/<template>/），只允许
  // 目录名形态，拒绝路径分隔符与 ..（防穿越写入容器根之外）。
  if (!/^[a-zA-Z0-9_-]+$/.test(templateName)) {
    throw new Error(`invalid presetTemplate ${JSON.stringify(templateName)}: must be a bare directory name`)
  }
  const templateDir = resolvePresetDir(templateName)
  const spec = loadPresetSpec(templateDir)
  const runtime = runtimeOf(options, prompt)
  const params = resolvePresetParams(spec, runtime)

  // 预设分离：presetDir 是容器根（官方按目录名加载 id），渲染目标为
  // presetDir/<template>/ 子预设目录——各预设完整隔离（引擎/提示词配置/overrides
  // 各自独立），切换预设只更新容器根的薄转发 agent.cordis.yml。
  const presetRoot = presetDir
  const targetDir = join(presetRoot, templateName)
  mkdirSync(presetRoot, { recursive: true })
  const tmpDir = mkdtempSync(join(presetRoot, `.${templateName}.tmp-`))
  const outDir = tmpDir
  try {
  // 0) 保留用户参数覆盖文件（重建/升级不丢用户修改；随子预设隔离）。
  //    旧单目录结构（overrides 在容器根）首次生成时迁移进子预设。
  const overridesSrc = join(targetDir, 'prompt-tool.overrides.yml')
  const legacyOverrides = join(presetRoot, 'prompt-tool.overrides.yml')
  if (existsSync(overridesSrc)) {
    cpSync(overridesSrc, join(outDir, 'prompt-tool.overrides.yml'), { force: true })
  } else if (existsSync(legacyOverrides)) {
    cpSync(legacyOverrides, join(outDir, 'prompt-tool.overrides.yml'), { force: true })
  }
  // 旧单目录结构迁移：容器根残留（engine/prompt-configs/内容资产）归位后清理一次。
  if (existsSync(join(presetRoot, 'engine')) && !existsSync(targetDir)) {
    for (const name of ['engine', 'prompt-configs', 'preset.md', 'agents.md', 'preset.yml',
      'agents-instruction.txt', 'prompt-tool.overrides.yml']) {
      rmSync(join(presetRoot, name), { recursive: true, force: true })
    }
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

  // 4) 提示词配置:引擎默认(按 params)< 模板覆盖 < settings。
  const promptConfigsDir = join(outDir, 'prompt-configs')
  rmSync(promptConfigsDir, { recursive: true, force: true })
  mkdirSync(promptConfigsDir, { recursive: true })
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
  // 模型参数（agent-request）作为引擎默认级注入，优先级低于模板与 settings。
  const merged = mergePromptConfigs(modelRequestConfigs(params), templateDefaults, options.promptConfigs)
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
  const backupDir = join(presetRoot, `.${templateName}.bak-${Date.now().toString(36)}`)
  let oldMoved = false
  if (existsSync(targetDir)) {
    renameSync(targetDir, backupDir)
    oldMoved = true
  }
  try {
    renameSync(outDir, targetDir)
  } catch (error) {
    if (oldMoved) {
      try {
        renameSync(backupDir, targetDir)
      } catch {
        // 恢复失败时保留 backup 供人工处理,不再覆盖现场。
      }
    }
    throw error
  }
  if (oldMoved) rmSync(backupDir, { recursive: true, force: true })

  // 8) 容器根薄转发：agent.cordis.yml 指向激活子预设（官方契约：目录名 = 预设 id，
  //    容器根必须始终有完整组合）。组合内 `name: ./engine/...` 重写为
  //    `./<template>/engine/...`；configsDir 相对引擎文件解析，引擎文件在子预设
  //    内，无需改写。
  const forwarded = composition.replaceAll('./engine/', `./${templateName}/engine/`)
  writeFileSync(join(presetRoot, 'agent.cordis.yml'), forwarded, 'utf8')
  } catch (error) {
    rmSync(tmpDir, { recursive: true, force: true })
    throw error
  }
}
