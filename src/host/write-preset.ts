/**
 * write-preset — 单一参数 YAML 驱动的模块目录物化器。
 *
 * 用户只需编写 modules/<template>/module.yml(纯参数):
 *   meta + content + modules(模块清单)+ params(直读参数)+ 可选 promptConfigs 覆盖。
 * 默认提示词配置与组合 token 都由引擎按 params 生成,参数文件不含任何模板语法。
 * 输出 = 官方对齐布局：moduleDir/<template>/（模块目录，agent.cordis.yml 组合本体
 * 直接可挂载）。共享引擎自阶段 2 起由插件包提供（组合行引用包内说明符），不再物化。
 */

import { writeFileSync, mkdirSync, rmSync, cpSync, mkdtempSync, renameSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument, stringify as stringifyYaml } from 'yaml'
// 纯策略模块同时由 host writer 与生成运行时消费；保持校验算法单一来源。
// @ts-expect-error 仓库根 ESM 引擎文件由 tsdown 作为源码依赖打包，无独立声明文件。
import { validateSubagentToolPolicy } from '../../engine/subagent-tool-policy-core.mjs'
// @ts-expect-error 仓库根 ESM 引擎文件由 tsdown 作为源码依赖打包，无独立声明文件。
import { compileDeclarations } from '../../engine/trigger-spec.mjs'
import { MODULES_DIR, MODULE_CONFIGS_DIR, MODULE_DEFINITION_FILE } from './paths.ts'
import { DEFAULT_MODULE_ID } from '../shared/preset-ids.ts'
import { triggerPromptConfigOptions } from './module-triggers.ts'
import { appendModuleConfigOrder, readConfigOrder } from './module-config-order.ts'
import { enabledModuleIds } from './config-store.ts'
import { assertModuleDirectory, assertPresetId, assertPresetTree, engineModuleFileNames, rewritePresetEngineReferences } from './module-install.ts'
import { compileCustomTool } from './custom-tools.ts'
import { validateCustomToolIdentities } from '../shared/engine-capabilities.ts'
import { WRITER_PARAM_KEYS, type PresetWriterParams } from '../shared/engine-params.ts'
import { resolveLegacyPromptConfigs } from './legacy-prompt-params.ts'
import {
  configFileName,
  mergePromptConfigs,
  modelRequestConfigs,
  renderPromptConfigYaml,
} from './prompt-configs.ts'
import type { PromptConfigSpec } from './prompt-configs.ts'
import {
  assertCompositionArray,
  asString,
  loadModuleSpec,
  packageEngineDir,
  renderComposition,
  resolvePresetParams,
  resolveModuleDir,
} from './manifest.ts'

const ENGINE_DIR = packageEngineDir()

/**
 * 渲染契约版本：包内模块模板/引擎契约变化（modules 清单、persona 顶层段与
 * dsh-persona 行 config 字段等）时 +1。启动重建据此重刷用户目录旧产物——
 * 否则旧产物只会在用户手动切换该模块时才会重新渲染。
 */
export const RENDER_VERSION = 5
export const RENDER_STAMP = `# prompt-tool:render v${RENDER_VERSION}`

/** 剥离文本中的模块级变量引用（{{key}} → 空串）；内置变量（{{DSH_HOME}} 等）保留。
 *  模板变量插值停用时由 writePreset 调用，避免 {{key}} 残留导致官方渲染 unknown variable。 */
function stripVariableRefs(text: string, keys: ReadonlySet<string>): string {
  return text.replace(/\{\{([A-Za-z0-9_.\u4e00-\u9fff-]+)\}\}/g, (whole, key: string) => keys.has(key) ? '' : whole)
}

/** 禁用条目物化瘦身阈值（字符数）：超过则渲染产物只保留元数据不落正文。
 *  ST 导入的设置 dump（SPresetSettings 等）动辄数百 KB 且 enabled=false——
 *  注入与展示都不需要正文，全量落盘只拖慢 rebuild 与引擎启动扫描。 */
const DISABLED_TEXT_SLIM_THRESHOLD = 32 * 1024

/**
 * 把任意单一参数模块模板物化到生成目录（writePreset）的写入态选项。
 * 引擎参数契约来自 shared/engine-params.ts（PresetWriterParams：runtimeOf 透传子集），
 * 此处只保留 writePreset 专属字段——加引擎参数只需改一处契约，漏透传变成编译错误。
 */
export interface WritePresetOptions extends PresetWriterParams {
  /** AGENTS.md 内容资产（写生成目录 agents.md）：常驻层写盘的唯一来源，不再注入提示词。 */
  agentsInstructionText?: string
  moduleDir: string
  /** @deprecated 模块排序归模块定义；该旧输入已不再覆盖顶层 order。 */
  presetOrder?: number
  /** settings 层用户自定义提示词配置(优先级最高)。 */
  promptConfigs: PromptConfigSpec[]
  /** 当前模块目录名；默认 pt-standard。 */
  presetTemplate?: string
  /** 输出目录/模块 id 覆盖；缺省 = presetTemplate 同名输出。 */
  outputId?: string
  /** 隔离的定义/资源来源；与最终 outputId 分离，不回退同名已安装模块。 */
  sourceDir?: string
  /** 只生成并返回暂存目录；调用方负责安装或清理，不更新共享引擎及目标目录。 */
  materializeOnly?: boolean
  /** 目录加载失败等非致命告警回调。 */
  warn?: (message: string) => void
}

/** 按模块身份重建：定义与正文均读取该模块，不叠加工作台当前编辑态。 */
export function materializeModule(
  id: string,
  options: Pick<WritePresetOptions, 'moduleDir' | 'presetOrder' | 'warn'>,
): string {
  if (enabledModuleIds(options.moduleDir).includes(id)) appendModuleConfigOrder(options.moduleDir, id)
  const dir = resolveModuleDir(id, options.moduleDir)
  const spec = loadModuleSpec(dir)
  const content = (file: string, fallback: string): string => {
    try {
      return readFileSync(join(dir, file), 'utf8') || fallback
    } catch {
      return fallback
    }
  }
  const prompt = content('preset.md', asString(spec.content?.presetText))
  return writePreset(prompt, {
    moduleDir: options.moduleDir,
    presetOrder: options.presetOrder,
    presetTemplate: id,
    outputId: id,
    promptConfigs: [],
    agentsInstructionText: content('agents.md', asString(spec.content?.agentsText)),
    warn: options.warn,
  })
}

/** Windows 瞬时文件锁（杀软/宿主短读）下的重试：rename/写文件失败最多重试 3 次、间隔 400ms。 */
function withLockRetry<T>(action: () => T, retries = 3): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return action()
    } catch (error) {
      if (attempt >= retries) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400)
    }
  }
}

/** 目录改名失败且可回退的占用错误（Windows 打开句柄/进程 cwd 会拒绝整目录改名）。 */
function isLockError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

// 共享引擎自阶段 2 起由**插件包**提供（组合行引用 `dsh-plugin-prompt-tool/engine/*.mjs`），
// 不再物化到 `<模块根>/.engine/`；用户目录里既有的 `.engine/` 不再被引用，保留不主动清理。

/**
 * 原地合并写：srcDir 覆盖到已存在的 destDir（目录交换被占用时的回退路径）。
 * 同名目录递归合并（被占用的目录只刷新内容），同名文件覆盖，destDir 多余项删除。
 */
function syncDirInPlace(srcDir: string, destDir: string): void {
  const keep = new Set(readdirSync(srcDir))
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const source = join(srcDir, entry.name)
    const target = join(destDir, entry.name)
    if (entry.isDirectory()) {
      if (existsSync(target)) syncDirInPlace(source, target)
      else cpSync(source, target, { recursive: true, force: true })
    } else {
      withLockRetry(() => cpSync(source, target, { force: true }))
    }
  }
  for (const entry of readdirSync(destDir)) {
    if (keep.has(entry)) continue
    withLockRetry(() => rmSync(join(destDir, entry), { recursive: true, force: true }))
  }
}

/**
 * 写盘用的 runtime 参数对象。
 *
 * 保留外部调用方的显式覆盖语义；普通模块重建不再回传定义中的参数副本。
 * 未提供与显式 false / 0 / 空字符串不同，不能用编辑器默认值补齐。
 */
export function runtimeOf(options: WritePresetOptions, prompt: string): Record<string, unknown> {
  /** 未提供的参数保持 undefined：resolvePresetParams 跳过 undefined 键，
   *  模块 module.yml 的 params/model 段才是缺省值来源。写成 false/''/true 会把
   *  「调用方没给」冒充成「调用方要求」，导入与离线物化时覆盖作者定义。 */
  const providedBoolean = (value: boolean | undefined): boolean | undefined =>
    typeof value === 'boolean' ? value : undefined
  return {
    // 所有引擎参数可直接用于 writePreset；undefined 不覆盖模板值。
    ...Object.fromEntries(WRITER_PARAM_KEYS.map((key) => [key, options[key]])),
    promptText: prompt,
    firstTurnAnchor: providedBoolean(options.firstTurnAnchor),
    firstTurnCustom: providedBoolean(options.firstTurnCustom),
    firstTurnText: typeof options.firstTurnText === 'string' ? options.firstTurnText : undefined,
    guideCustom: providedBoolean(options.guideCustom),
    guideText: typeof options.guideText === 'string' ? options.guideText : undefined,
    // 每轮引导独立开关，仅显式 true 启用。
    guideEnabled: providedBoolean(options.guideEnabled),
    injectPrompt: providedBoolean(options.injectPrompt),
    // 字符串键：调用方给了就用它（'' = 显式不设置），没给才回落到 preset.yml 定义。
    modelProvider: typeof options.modelProvider === 'string' ? options.modelProvider : undefined,
    modelName: typeof options.modelName === 'string' ? options.modelName : undefined,
    subagentModelProvider: typeof options.subagentModelProvider === 'string' ? options.subagentModelProvider : undefined,
    subagentModelName: typeof options.subagentModelName === 'string' ? options.subagentModelName : undefined,
    modelReasoningEffort: typeof options.modelReasoningEffort === 'string' ? options.modelReasoningEffort : undefined,
    modelTemperature: typeof options.modelTemperature === 'string' ? options.modelTemperature : undefined,
    modelMaxTokens: typeof options.modelMaxTokens === 'string' ? options.modelMaxTokens : undefined,
    subagentReasoningEffort: typeof options.subagentReasoningEffort === 'string' ? options.subagentReasoningEffort : undefined,
    subagentTemperature: typeof options.subagentTemperature === 'string' ? options.subagentTemperature : undefined,
    subagentMaxTokens: typeof options.subagentMaxTokens === 'string' ? options.subagentMaxTokens : undefined,
    maxDepth: options.maxDepth,
    // firstTurnWord 空 = 不写该键，由模板/模块的 prompt-injector 条目决定确认词。
    firstTurnWord: typeof options.firstTurnWord === 'string' && options.firstTurnWord.length > 0
      ? options.firstTurnWord
      : undefined,
  }
}

/** 手写/导入模块恢复路径：与保存方完整编译同源，但坏定义仍逐条告警跳过。 */
function materializeCustomTool(tool: Record<string, unknown>, warn: (message: string) => void): Record<string, unknown> | undefined {
  try {
    return compileCustomTool(tool)
  } catch (error) {
    warn('customTools: ' + JSON.stringify(tool.id) + ': ' + String((error as Error).message ?? error) + '; skipped')
    return undefined
  }
}

/** 把任意单一参数模块模板物化到生成目录;全部失败 fail loud。 */
export function writePreset(prompt: string, options: WritePresetOptions): string {
  // 空路径兜底:旧版 UI 保存的空串 moduleDir 不得传入 mkdirSync('')。
  const moduleDir = options.moduleDir.trim().length > 0 ? options.moduleDir : MODULES_DIR
  const templateName = typeof options.presetTemplate === 'string' && options.presetTemplate.trim().length > 0
    ? options.presetTemplate.trim()
    : DEFAULT_MODULE_ID
  // 安全边界：templateName 现在是写入路径段（moduleDir/<template>/），同时必须是
  // 官方 agent-presets 可发现的预设 id（PRESET_ID = /^[a-z0-9][a-z0-9-]*$/）——
  // 含中文等非法 id 会被宿主 discovery 静默跳过（会话 resume 报 preset not found），
  // 这里 fail loud 拒绝，防止生成官方不可见目录。
  if (!/^[a-z0-9][a-z0-9-]*$/.test(templateName)) {
    throw new Error(`invalid presetTemplate ${JSON.stringify(templateName)}: must match official agent-presets id /^[a-z0-9][a-z0-9-]*$/`)
  }
  // 导入与复制时，来源定义和目标身份可以不同。
  const outputId = typeof options.outputId === 'string' && options.outputId.trim().length > 0
    ? options.outputId.trim()
    : templateName
  if (!/^[a-z0-9][a-z0-9-]*$/.test(outputId)) {
    throw new Error(`invalid outputId ${JSON.stringify(outputId)}: must match official agent-presets id /^[a-z0-9][a-z0-9-]*$/`)
  }
  assertPresetId(templateName)
  assertPresetId(outputId)
  const templateDir = options.sourceDir ?? resolveModuleDir(templateName, moduleDir)
  assertPresetTree(templateDir)
  const spec = loadModuleSpec(templateDir, { legacyParams: false })
  if (Array.isArray(spec.meta?.stWarnings)) {
    for (const warning of spec.meta.stWarnings) if (typeof warning === 'string') options.warn?.(`prompt-tool: ST 导入兼容提示：${warning}`)
  }
  if (spec.subagentToolPolicy !== undefined && spec.subagentToolPolicy !== null) {
    const policyErrors = validateSubagentToolPolicy(spec.subagentToolPolicy)
    if (policyErrors.length > 0) {
      throw new Error(`invalid subagentToolPolicy: ${policyErrors.join('; ')}`)
    }
  }
  // 触发器声明在**保存期**就用引擎的声明编译器校验（与运行时同一份实现）：写错的声明
  // 会在保存时被拒，而不是等到装配才炸。编译器只做数据校验（不需要 ctx）。
  if (spec.triggers !== undefined && spec.triggers !== null) {
    if (!Array.isArray(spec.triggers)) {
      throw new Error('invalid triggers: 必须是触发器声明数组')
    }
    try {
      compileDeclarations(spec.triggers, { promptConfigOptions: triggerPromptConfigOptions(templateDir, spec.moduleConfigs?.['declared-triggers']?.strategyDir) })
    } catch (error) {
      throw new Error(`invalid triggers: ${String((error as Error)?.message ?? error)}`)
    }
  }
  const runtime = runtimeOf(options, prompt)
  const params = resolvePresetParams(spec, runtime)
  const legacy = resolveLegacyPromptConfigs(spec, {
    moduleDir: templateDir, prompt, overrides: runtime, promptConfigs: options.promptConfigs,
  })
  for (const warning of legacy.warnings) (options.warn ?? console.warn)(`prompt-tool: ${warning}`)

  // 官方对齐布局：moduleDir 是模块根（官方 USER_PRESET_DIR），每个模块一个
  // 官方模块目录 moduleDir/<template>/（agent.cordis.yml 组合本体直接可挂载），
  // 共享引擎由插件包提供（组合行引用包名说明符），不再物化到 moduleDir/.engine。
  const targetDir = assertModuleDirectory(moduleDir, outputId, true)
  mkdirSync(moduleDir, { recursive: true })
  const tmpDir = mkdtempSync(join(moduleDir, `.${outputId}.tmp-`))
  const outDir = tmpDir
  try {
  // 1) 组合文件:modules 模块库装配 + 参数桥行级合并 + YAML 校验。
  const composition = renderComposition({ ...spec, promptConfigs: legacy.configs }, runtime, templateDir)
  assertCompositionArray(composition, spec)
  // 引擎引用重写：组合源的 ./engine/ 与旧预设的 ../.engine/ 一律写成包名说明符
  // dsh-plugin-prompt-tool/engine/<module>.mjs（引擎不再物化）；受管配置字段保持
  // 「相对历史引擎位置 <模块根>/.engine/」的形态，由运行时配装期换算为绝对 file://
  // （`runtime/agent-assembly.ts` 的 absolutizeManagedFields）。
  const subComposition = rewritePresetEngineReferences(composition, outputId,
    engineModuleFileNames(ENGINE_DIR))
  writeFileSync(join(outDir, 'agent.cordis.yml'), `${RENDER_STAMP}\n${subComposition}`, 'utf8')

  // 2) 宿主模块元数据：新布局 module.yml = 参数 + 元数据一体。
  //    已存在参数文件（种子化/新建复制）时只合并元数据键（name/description/order/meta），
  //    保留 params/modules/promptConfigs/content——不得整体覆盖（会摧毁参数源）。
  const meta = spec.meta !== null && typeof spec.meta === 'object' ? spec.meta as Record<string, unknown> : {}
  const sourceYamlPath = options.sourceDir !== undefined || !existsSync(join(targetDir, MODULE_DEFINITION_FILE))
    ? join(templateDir, MODULE_DEFINITION_FILE) : join(targetDir, MODULE_DEFINITION_FILE)
  const existingPresetYaml = existsSync(sourceYamlPath)
    ? readFileSync(sourceYamlPath, 'utf8')
    : undefined
  if (existingPresetYaml !== undefined && existingPresetYaml.trim().length > 0) {
    const doc = parseDocument(existingPresetYaml, { logLevel: 'silent' })
    if (doc.errors.length > 0) throw new Error(`invalid preset.yml: ${doc.errors[0]!.message}`)
    doc.set('id', outputId)
    // 元数据合并：目标已有值优先，缺失/空白才使用来源定义。
    const ensureMetaKey = (key: string, value: unknown): void => {
      if (value === undefined || value === null) return
      const current = doc.get(key)
      if (current === undefined || current === null
        || (typeof current === 'string' && current.trim().length === 0)) {
        doc.setIn([key], value)
      }
    }
    ensureMetaKey('name', typeof spec.name === 'string' && spec.name.length > 0 ? spec.name : undefined)
    ensureMetaKey('description', typeof spec.description === 'string' && spec.description.length > 0 ? spec.description : undefined)
    ensureMetaKey('meta', Object.keys(meta).length > 0 ? meta : undefined)
    writeFileSync(join(outDir, MODULE_DEFINITION_FILE), doc.toString(), 'utf8')
  } else {
    writeFileSync(join(outDir, MODULE_DEFINITION_FILE), stringifyYaml(meta) + '\n', 'utf8')
  }

  // 2.5) 内容资产:preset.md / agents.md(与组合文件同层;大文本存文件而非 settings)。
  //      空白模块（custom 等无 content）不生成空内容资产——prompt-injector 无文本即禁用。
  if (prompt.trim().length > 0) {
    writeFileSync(join(outDir, 'preset.md'), prompt, 'utf8')
  } else if (existsSync(join(templateDir, 'preset.md'))) {
    cpSync(join(templateDir, 'preset.md'), join(outDir, 'preset.md'))
  }
  if (typeof options.agentsInstructionText === 'string' && options.agentsInstructionText.trim().length > 0) {
    writeFileSync(join(outDir, 'agents.md'), options.agentsInstructionText, 'utf8')
  } else if (existsSync(join(templateDir, 'agents.md'))) {
    cpSync(join(templateDir, 'agents.md'), join(outDir, 'agents.md'))
  }

  // 2.6) 模板目录本地文件复制（官方格式模块的组合引用 ./xxx.mjs 等相对路径模块，
  // 必须随模块进入生成目录；跳过定义文件 module.yml / agent.cordis.yml 与
  // 内容资产 preset.md / agents.md——后者由运行时 prompt 决定）。
  const templateEntries = readdirSync(templateDir, { withFileTypes: true })
  for (const entry of templateEntries) {
    if (entry.name === MODULE_DEFINITION_FILE || entry.name === 'agent.cordis.yml'
      || entry.name === 'preset.md' || entry.name === 'agents.md') continue
    const source = join(templateDir, entry.name)
    const target = join(outDir, entry.name)
    if (entry.isDirectory()) cpSync(source, target, { recursive: true, force: true })
    else cpSync(source, target, { force: true })
  }

  // 4) 提示词配置:引擎默认(按 params)< 模板覆盖 < settings。
  const promptConfigsDir = join(outDir, MODULE_CONFIGS_DIR)
  rmSync(promptConfigsDir, { recursive: true, force: true })
  mkdirSync(promptConfigsDir, { recursive: true })
  // 模型参数（agent-request）作为引擎默认级注入，优先级低于模板与 settings。
  // 指令文件卡不再物化：正文与行为由独立指令来源（pre-step 协调器 + 独立策略）按会话
  // 现场解析，生成目录里不再出现 agents-file-*，preset.yml#agentsHints 也不再是开关。
  const merged = mergePromptConfigs(modelRequestConfigs(params), legacy.configs)
  // 模块级模板变量 → prompt-configs/variables.yml（单一文件）：引擎加载时合并进
  // 每条配置 variables（配置自身优先）。唯一来源 = preset.yml 顶层 variables；
  // params 与 runtime 参数不进入变量文件。variablesEnabled=false（卡片
  // 开关停用）时不生成变量文件，并把配置文本中的模块变量引用 {{key}} 剥离
  //（避免字面残留与官方 unknown variable 报错）。
  const presetVariables: Record<string, string> = {}
  for (const [key, value] of Object.entries(spec.variables ?? {})) {
    // 空值占位键也写入（ST 未定义宏登记的变量）：引擎插值时 hasOwnProperty
    // 命中即替换为空串，不留 {{key}} 字面；UI 模板变量卡可编辑默认值覆盖。
    if (typeof value === 'string') presetVariables[key] = value
  }
  const variablesEnabled = spec.variablesEnabled !== false
  const presetVariableKeys = new Set(Object.keys(presetVariables))
  if (variablesEnabled && presetVariableKeys.size > 0) {
    writeFileSync(join(promptConfigsDir, 'variables.yml'), stringifyYaml(presetVariables), 'utf8')
  }
  const configOrder = readConfigOrder(spec.configOrder)
  for (const [index, source] of merged.entries()) {
    // 浅克隆：merged 元素可能是 settings 层/模板 spec 的引用（mergePromptConfigs
    // 不拷贝），循环内的变异（prompt-injector 参数桥/变量剥离/瘦身）不得污染
    // 参数源与 presetSpecCache 缓存。
    const config: PromptConfigSpec = {
      ...source,
      params: source.params !== undefined && source.params !== null ? { ...source.params } : source.params,
    }
    // 停用模板变量插值：剥离配置文本（texts/text/params.text）中的模块变量引用，
    // 内置变量（{{DSH_HOME}}/{{WORKSPACE}}/{{CWD}}）保留。
    if (!variablesEnabled && presetVariableKeys.size > 0) {
      const strip = (item: string): string => stripVariableRefs(item, presetVariableKeys)
      config.texts = (config.texts ?? []).map(strip)
      if (typeof config.text === 'string') config.text = strip(config.text)
      if (typeof config.params?.text === 'string') {
        config.params = { ...config.params, text: strip(config.params.text as string) }
      }
    }
    // 禁用大条目瘦身：enabled=false 且正文超阈值时产物不落正文（参数源 preset.yml
    // 原文保留，重新启用后下次物化恢复全文）——只省 IO 与解析，不动注入语义。
    const textVolume = (typeof config.text === 'string' ? config.text.length : 0)
      + (Array.isArray(config.texts)
        ? config.texts.reduce((sum, item) => sum + (typeof item === 'string' ? item.length : 0), 0)
        : 0)
    if (config.enabled === false && textVolume > DISABLED_TEXT_SLIM_THRESHOLD) {
      delete config.text
      config.texts = []
    }
    const sequence = configOrder[config.id] ?? index * 10
    writeFileSync(join(promptConfigsDir, configFileName(sequence, config.id)), renderPromptConfigYaml(config), 'utf8')
  }

  // 4.5) 自定义工具（preset.yml 顶层 customTools 段）→ custom-tools/<n>-<id>.yml：
  //      tool-config-engine 引擎行按 configsDir 加载并运行时注册。结构坏条目跳过。
  const customToolsDir = join(outDir, 'custom-tools')
  rmSync(customToolsDir, { recursive: true, force: true })
  mkdirSync(customToolsDir, { recursive: true })
  const customTools = Array.isArray(spec.customTools) ? spec.customTools : []
  const identityErrors = validateCustomToolIdentities(customTools)
  if (identityErrors.length > 0) throw new Error(identityErrors.join('; '))
  const warn = options.warn ?? (() => {})
  for (const [index, tool] of customTools.entries()) {
    const materialized = materializeCustomTool(tool as Record<string, unknown>, warn)
    if (materialized === undefined) continue
    writeFileSync(
      join(customToolsDir, configFileName(index + 1, String(materialized.id))),
      stringifyYaml(materialized, { lineWidth: 0 }),
      'utf8',
    )
  }


  // 4.6) 子代理工具策略（preset.yml 顶层 subagentToolPolicy 段）→ subagent-tools/policy.yml：
  //      策略经统一 resolver 校验（非法拒绝整次保存）；非空策略生成物 + 运行时模块自动装配。
  // writePreset 只负责策略物化（策略在 bridge POST 已统一校验并自动追加运行时模块，
  // 保持本函数同步与"preset.yml 单一来源"）；生成物 = subagent-tools/policy.yml。
  const subagentToolsDir = join(outDir, 'subagent-tools')
  rmSync(subagentToolsDir, { recursive: true, force: true })
  if (spec.subagentToolPolicy !== undefined && spec.subagentToolPolicy !== null) {
    mkdirSync(subagentToolsDir, { recursive: true })
    writeFileSync(join(subagentToolsDir, 'policy.yml'), stringifyYaml(spec.subagentToolPolicy, { lineWidth: 0 }), 'utf8')
  }

  // 4.7) 触发器声明（preset.yml 顶层 triggers 段）→ triggers.yml：
  //      声明以**裸数组**落盘（与 preset.yml 里的段同形，读回不需要再拆一层包装）；
  //      本次没有声明时删掉旧文件——否则上一版的声明会残留并继续生效。
  const triggersFile = join(outDir, 'triggers.yml')
  rmSync(triggersFile, { force: true })
  if (Array.isArray(spec.triggers) && spec.triggers.length > 0) {
    writeFileSync(triggersFile, stringifyYaml(spec.triggers, { lineWidth: 0 }), 'utf8')
  }

  // 候选模式在此结束，安装事务由调用方单独执行，绝不进入原地覆盖回退。
  if (options.materializeOnly) return outDir

  // 7) 原子提交:新目录完全写好后替换旧目录;失败时恢复旧目录并清理临时目录。
  //    目录被占用（Windows 打开句柄/进程 cwd 拒绝整目录改名，如模块内 skills 被
  //    技能监听器持有）时退回原地合并写，语义与整目录交换一致：同名项覆盖、
  //    多余项删除，被占用的目录只刷新内容。
  const backupDir = join(moduleDir, `.${templateName}.bak-${Date.now().toString(36)}`)
  let oldMoved = false
  let inPlace = false
  if (existsSync(targetDir)) {
    try {
      withLockRetry(() => renameSync(targetDir, backupDir))
      oldMoved = true
    } catch (error) {
      if (!isLockError(error)) throw error
      inPlace = true
    }
  }
  if (inPlace) {
    syncDirInPlace(outDir, targetDir)
    rmSync(outDir, { recursive: true, force: true })
  } else {
    try {
      withLockRetry(() => renameSync(outDir, targetDir))
    } catch (error) {
      if (oldMoved) {
        try {
          withLockRetry(() => renameSync(backupDir, targetDir))
        } catch {
          // 恢复失败时保留 backup 供人工处理,不再覆盖现场。
        }
      }
      throw error
    }
    if (oldMoved) rmSync(backupDir, { recursive: true, force: true })
  }
  return targetDir
  } catch (error) {
    rmSync(tmpDir, { recursive: true, force: true })
    throw error
  }
}
