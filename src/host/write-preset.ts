/**
 * write-preset — 单一参数 YAML 驱动的官方预设目录物化器。
 *
 * 用户只需编写 preset/<template>/preset.yml(纯参数):
 *   meta + content + modules(模块清单)+ params(直读参数)+ 可选 promptConfigs 覆盖。
 * 默认提示词配置与组合 token 都由引擎按 params 生成,参数文件不含任何模板语法。
 * 输出 = 官方对齐布局：presetDir/<template>/（预设目录，agent.cordis.yml 组合本体
 * 直接可挂载）+ presetDir/.engine/（共享引擎，点前缀不占预设槽）。
 */

import { writeFileSync, mkdirSync, rmSync, cpSync, mkdtempSync, renameSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument, stringify as stringifyYaml } from 'yaml'
import { DEFAULT_PRESET_DIR } from './paths.ts'
import { PARAM_KEYS } from '../shared/param-keys.ts'
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

/** 包内引擎指纹（相对路径 + size）：引擎文件未变时共享引擎不重刷。
 *  每次 settings 变更都会 rebuildPreset → writePreset，引擎重刷（130 文件复制 +
 *  Windows 锁等待）是纯浪费；指纹 stat 遍历约 2-5ms，远小于复制成本。 */
function engineFingerprint(): string {
  const parts: string[] = []
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(ENGINE_DIR, rel), { withFileTypes: true })) {
      const child = rel.length === 0 ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        // 生成期资产（组合库/源）运行时不需要，不复制也不计入指纹。
        if (rel.length === 0 && entry.name === 'compositions') continue
        walk(child)
      }
      else parts.push(`${child}:${statSync(join(ENGINE_DIR, child)).size}`)
    }
  }
  walk('')
  return parts.sort().join('|')
}

const ENGINE_FINGERPRINT_MARKER = '.pt-engine-fingerprint'

/** 剥离文本中的预设级变量引用（{{key}} → 空串）；内置变量（{{DSH_HOME}} 等）保留。
 *  模板变量插值停用时由 writePreset 调用，避免 {{key}} 残留导致官方渲染 unknown variable。 */
function stripVariableRefs(text: string, keys: ReadonlySet<string>): string {
  return text.replace(/\{\{([A-Za-z0-9_.\u4e00-\u9fff-]+)\}\}/g, (whole, key: string) => keys.has(key) ? '' : whole)
}

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
  /** 子代理自定义模型人设（per-child shadow；缺省 = 经 scope 链继承主会话 persona 模块）。 */
  subagentPersona?: string
  /** 委派工具集白名单（toolFilter.allow；支持数组或逗号/空格分隔字符串）。 */
  toolFilterAllow?: string[] | string
  /** 委派工具集黑名单（toolFilter.deny）。 */
  toolFilterDeny?: string[] | string
  /** 委派递归深度上限（0 禁止委派 / provider-managed / 正整数）。 */
  maxDepth?: number | 'provider-managed' | string
  /** 注入 kind 白名单（context-gate allowKinds；数组或逗号分隔字符串）。 */
  allowKinds?: string[] | string
  /** custom-fallback 锚定词（prompt-injector params.firstTurnWord）。 */
  firstTurnWord?: string
  /** 是否注入 agents.md 内容到 instruction-hint（false 时 instruction-hint 走引擎默认提示/动态探测）。 */
  injectAgentsPrompt?: boolean
  bootstrapMaxTokens: number
  /** PTC (Code Mode) 呈现开关；undefined = 模板 preset.yml params / 引擎默认（false）。 */
  usePtcMode: boolean | undefined
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

function runtimeOf(options: WritePresetOptions, prompt: string): Record<string, unknown> {
  return {
    promptText: prompt,
    firstTurnAnchor: options.firstTurnAnchor === true,
    firstTurnCustom: options.firstTurnCustom === true,
    firstTurnText: typeof options.firstTurnText === 'string' ? options.firstTurnText : '',
    guideCustom: options.guideCustom === true,
    guideText: typeof options.guideText === 'string' ? options.guideText : '',
    injectPrompt: options.injectPrompt !== false,
    // 透传：未声明 = 模板 preset.yml params / 引擎默认（false）兜底，不再强制 true。
    usePtcMode: typeof options.usePtcMode === 'boolean' ? options.usePtcMode : undefined,
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
    // firstTurnWord 空应回退 preset.yml 模板默认（we）。
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
  // 安全边界：templateName 现在是写入路径段（presetDir/<template>/），同时必须是
  // 官方 agent-presets 可发现的预设 id（PRESET_ID = /^[a-z0-9][a-z0-9-]*$/）——
  // 含中文等非法 id 会被宿主 discovery 静默跳过（会话 resume 报 preset not found），
  // 这里 fail loud 拒绝，防止生成官方不可见目录。
  if (!/^[a-z0-9][a-z0-9-]*$/.test(templateName)) {
    throw new Error(`invalid presetTemplate ${JSON.stringify(templateName)}: must match official agent-presets id /^[a-z0-9][a-z0-9-]*$/`)
  }
  const templateDir = resolvePresetDir(templateName)
  const spec = loadPresetSpec(templateDir)
  // 世界书旧存储段一次性迁移：旧版 preset.yml 顶层 worldBook 段（injectMode + entries）
  // → world-book 策略配置并入 spec.promptConfigs（模块体系），并删除段写回。
  // 必须在第 2 步 preset.yml 生成之前执行——否则 existingPresetYaml 读到未删段的
  // 旧文件，原子替换会把段带回来。新版转换/apply 直接写 promptConfigs，不再产生段。
  const worldBook = spec.worldBook
  if (worldBook !== undefined && worldBook !== null && Array.isArray(worldBook.entries)) {
    const fullMode = worldBook.injectMode === 'full'
    const migrated: PromptConfigSpec[] = []
    for (const entry of worldBook.entries) {
      if (entry === null || typeof entry !== 'object') continue
      const content = typeof entry.text === 'string' ? entry.text : ''
      if (content.trim().length === 0) continue
      const id = String(entry.id ?? '')
      if (id.length === 0) continue
      const keys = Array.isArray(entry.keys) ? entry.keys.map(String).filter((key) => key.trim().length > 0) : []
      const secondaryKeys = Array.isArray(entry.secondaryKeys)
        ? entry.secondaryKeys.map(String).filter((key) => key.trim().length > 0) : []
      const constant = entry.constant === true || fullMode || (keys.length === 0 && secondaryKeys.length === 0)
      migrated.push({
        id,
        name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : id,
        enabled: entry.enabled !== false,
        strategy: 'world-book',
        order: typeof entry.order === 'number' ? entry.order : 100,
        text: content,
        layer: 'pre-step',
        position: 'before-all',
        params: {
          constant,
          ...(keys.length > 0 ? { keys } : {}),
          ...(secondaryKeys.length > 0 ? { secondaryKeys } : {}),
          ...(entry.caseSensitive === true ? { caseSensitive: true } : {}),
          ...(entry.wholeWords === true ? { wholeWords: true } : {}),
          // useRegex 不迁移：正则形态键由 anchor-match 自动检测（ST 语义），
          // 旧 useRegex=true 的条目其正则键同样命中，无需显式标记。
        },
      } satisfies PromptConfigSpec)
    }
    if (migrated.length > 0) {
      spec.promptConfigs = [...(Array.isArray(spec.promptConfigs) ? spec.promptConfigs : []), ...migrated]
      // 删除段并写回（一次性迁移；模板 preset.yml 无段时零开销跳过）。
      const presetYamlPath = join(presetDir, templateName, 'preset.yml')
      if (existsSync(presetYamlPath)) {
        try {
          const doc = parseDocument(readFileSync(presetYamlPath, 'utf8'), { logLevel: 'silent' })
          doc.deleteIn(['worldBook'])
          writeFileSync(presetYamlPath, doc.toString(), 'utf8')
        } catch {
          // 迁移写回失败不阻断（下次写入重试）；组合渲染用迁移后的 spec。
        }
      }
    }
  }
  const runtime = runtimeOf(options, prompt)
  const params = resolvePresetParams(spec, runtime)

  // 官方对齐布局：presetDir 是预设根（官方 USER_PRESET_DIR），每个预设一个
  // 官方预设目录 presetDir/<template>/（agent.cordis.yml 组合本体直接可挂载），
  // 共享引擎物化一份于 presetDir/.engine（点前缀，官方 discovery 跳过）。
  const targetDir = join(presetDir, templateName)
  mkdirSync(presetDir, { recursive: true })
  const tmpDir = mkdtempSync(join(presetDir, `.${templateName}.tmp-`))
  const outDir = tmpDir
  try {
  // 0) 保留用户参数覆盖文件（重建/升级不丢用户修改；随子预设隔离）。
  const overridesSrc = join(targetDir, 'prompt-tool.overrides.yml')
  if (existsSync(overridesSrc)) {
    cpSync(overridesSrc, join(outDir, 'prompt-tool.overrides.yml'), { force: true })
  }

  // 1) 组合文件:modules 模块库装配 + token 渲染 + moduleConfigs 行级合并 + YAML 校验。
  const composition = renderComposition(spec, runtime, templateDir)
  assertCompositionArray(composition, spec)
  // 共享引擎路径重写（引擎只物化一份于预设根 .engine）：组合的引擎引用
  // ./engine/ → ../.engine/（相对预设目录 = 预设根/.engine）；configsDir 相对
  // 引擎文件（.engine/）解析 → ../<template>/prompt-configs（指向本预设目录）。
  const subComposition = composition
    .replaceAll('./engine/', '../.engine/')
    .replaceAll('../prompt-configs', `../${templateName}/prompt-configs`)
  writeFileSync(join(outDir, 'agent.cordis.yml'), subComposition, 'utf8')

  // 2) 宿主预设元数据：新布局 preset.yml = 参数 + 元数据一体。
  //    已存在参数文件（种子化/新建复制）时只合并元数据键（name/description/order/meta），
  //    保留 params/modules/promptConfigs/content——不得整体覆盖（会摧毁参数源）。
  const meta = spec.meta !== null && typeof spec.meta === 'object' ? spec.meta as Record<string, unknown> : {}
  const existingPresetYaml = existsSync(join(targetDir, 'preset.yml'))
    ? readFileSync(join(targetDir, 'preset.yml'), 'utf8')
    : undefined
  if (existingPresetYaml !== undefined && existingPresetYaml.trim().length > 0) {
    const doc = parseDocument(existingPresetYaml, { logLevel: 'silent' })
    doc.setIn(['order'], options.presetOrder)
    if (typeof spec.name === 'string' && spec.name.length > 0) doc.setIn(['name'], spec.name)
    if (typeof spec.description === 'string' && spec.description.length > 0) {
      doc.setIn(['description'], spec.description)
    }
    if (Object.keys(meta).length > 0) doc.setIn(['meta'], meta)
    writeFileSync(join(outDir, 'preset.yml'), doc.toString(), 'utf8')
  } else {
    writeFileSync(join(outDir, 'preset.yml'), stringifyYaml({ ...meta, order: options.presetOrder }) + '\n', 'utf8')
  }

  // 2.5) 内容资产:preset.md / agents.md(与组合文件同层;大文本存文件而非 settings)。
  //      空白预设（custom 等无 content）不生成空内容资产——prompt-injector 无文本即禁用。
  if (prompt.trim().length > 0) {
    writeFileSync(join(outDir, 'preset.md'), prompt, 'utf8')
  }
  if (typeof options.agentsInstructionText === 'string' && options.agentsInstructionText.trim().length > 0) {
    writeFileSync(join(outDir, 'agents.md'), options.agentsInstructionText, 'utf8')
  }

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

  // 3) 共享引擎：引擎代码只物化一份于预设根 .engine（全部预设组合以 ../.engine 引用）。
  //    每次写入重刷保证与包内引擎一致，并清理旧版子预设的 engine/ 残留
  //    （全量/按需复制时代的迁移）。compositions/（生成期资产）不复制。
  //    指纹标记：包内引擎未变时跳过 rmSync+cpSync（settings 每次变更都会重建，
  //    引擎重刷是纯浪费且引入 Windows 锁等待）。
  const sharedEngine = join(presetDir, '.engine')
  const fingerprint = engineFingerprint()
  let currentMarker = ''
  try {
    currentMarker = readFileSync(join(sharedEngine, ENGINE_FINGERPRINT_MARKER), 'utf8')
  } catch {
    // 无标记 = 首次写入或旧版布局，重刷。
  }
  if (currentMarker !== fingerprint) {
    withLockRetry(() => {
      rmSync(sharedEngine, { recursive: true, force: true })
      mkdirSync(sharedEngine, { recursive: true })
      for (const entry of readdirSync(ENGINE_DIR, { withFileTypes: true })) {
        if (entry.name === 'compositions') continue
        cpSync(join(ENGINE_DIR, entry.name), join(sharedEngine, entry.name), { recursive: true, force: true })
      }
    })
    writeFileSync(join(sharedEngine, ENGINE_FINGERPRINT_MARKER), fingerprint, 'utf8')
  }
  for (const entry of readdirSync(presetDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'engine' || entry.name.startsWith('.')) continue
    try {
      rmSync(join(presetDir, entry.name, 'engine'), { recursive: true, force: true })
    } catch {
      // Windows 瞬时锁：残留无害（无引用），下次写入再试。
    }
  }

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
  // 预设级模板变量 → prompt-configs/variables.yml（单一文件）：引擎加载时合并进
  // 每条配置 variables（官方插值源，配置自身优先）。来源 = preset.yml 顶层
  // variables 段（新）优先 + params 内容键（旧布局兼容）；UI 已管理键（PARAM_KEYS）
  // 与 runtime 参数（promptText 等）不进变量文件。variablesEnabled=false（卡片
  // 开关停用）时不生成变量文件，并把配置文本中的预设变量引用 {{key}} 剥离
  //（避免字面残留与官方 unknown variable 报错）。
  const presetVariables: Record<string, string> = {}
  for (const [key, value] of Object.entries(spec.params ?? {})) {
    if (PARAM_KEYS.has(key)) continue
    if (value === undefined || value === null) continue
    const text = String(value)
    presetVariables[key] = text
  }
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
  for (const [index, config] of merged.entries()) {
    // 内容资产单一事实源（大文本存生成目录文件，settings 覆盖层只保留轻字段）：
    // prompt-injector 的注入文本永远来自 preset.md（presetPrompt），settings 条目即使带 text 也强制清空，
    // 避免「settings 覆盖层整体替换模板条目」时把渲染产物 params.text 挤掉。
    if (config.id === 'prompt-injector') {
      delete config.text
      config.texts = []
      // 无注入内容（空白预设）时禁用，避免注入空消息。
      config.enabled = params.injectPrompt !== false && prompt.trim().length > 0
      config.params = {
        ...config.params,
        text: prompt,
        firstTurnWord: asString(config.params?.firstTurnWord ?? params.firstTurnWord, 'we'),
      }
    }
    // instruction-hint：agents.md 内容经 injectAgentsPrompt 开关注入 params.text
    //（关闭时保持无 text，引擎回退 agents-instruction.txt / 动态探测）。
    // agentsInstructionPath：共享引擎后 fillers 相对 .engine 解析，必须显式指向本预设目录文件。
    if (config.fill === 'instruction-hint') {
      config.params = {
        ...config.params,
        agentsInstructionPath: `../${templateName}/agents-instruction.md`,
        ...(options.injectAgentsPrompt === true ? { text: asString(options.agentsInstructionText) } : {}),
      }
    }
    // 停用模板变量插值：剥离配置文本（texts/text/params.text）中的预设变量引用，
    // 内置变量（{{DSH_HOME}}/{{WORKSPACE}}/{{CWD}}）保留。
    if (!variablesEnabled && presetVariableKeys.size > 0) {
      const strip = (item: string): string => stripVariableRefs(item, presetVariableKeys)
      config.texts = (config.texts ?? []).map(strip)
      if (typeof config.text === 'string') config.text = strip(config.text)
      if (typeof config.params?.text === 'string') {
        config.params = { ...config.params, text: strip(config.params.text as string) }
      }
    }
    writeFileSync(join(promptConfigsDir, `${String(index * 10).padStart(2, '0')}-${config.id}.yml`), renderPromptConfigYaml(config), 'utf8')
  }

  // 5) 历史残留清理(模板参数声明,writer 只执行)。
  for (const legacy of spec.legacyCleanup ?? []) {
    rmSync(join(outDir, legacy), { force: true })
  }

  // 6) agents-instruction.md(模板内容资产经 settings 覆盖时写入；清旧 .txt 残留)。
  const agentsInstructionPath = join(outDir, 'agents-instruction.md')
  if (typeof options.agentsInstructionText === 'string' && options.agentsInstructionText.trim().length > 0) {
    writeFileSync(agentsInstructionPath, options.agentsInstructionText, 'utf8')
  } else {
    rmSync(agentsInstructionPath, { force: true })
  }
  rmSync(join(outDir, 'agents-instruction.txt'), { force: true })

  // 7) 原子提交:新目录完全写好后替换旧目录;失败时恢复旧目录并清理临时目录。
  const backupDir = join(presetDir, `.${templateName}.bak-${Date.now().toString(36)}`)
  let oldMoved = false
  if (existsSync(targetDir)) {
    withLockRetry(() => renameSync(targetDir, backupDir))
    oldMoved = true
  }
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
  } catch (error) {
    rmSync(tmpDir, { recursive: true, force: true })
    throw error
  }
}
