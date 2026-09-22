/**
 * SillyTavern 预设 → 本项目单文件预设转换引擎（纯函数，无文件 IO）。
 *
 * 按需转换原则：只按注入层级映射 SillyTavern 实际内容，不注入本项目默认内容。
 *   - prompts[] → promptConfigs：role=system → system-section（可拼接）；
 *     其余 → pre-step（role/position/dedupe 按 ST 语义）；
 *   - 角色卡正文（chara_card_v3：data 内层；旧版顶层直存）→ promptConfigs：
 *     description/personality/scenario 拼接为「角色设定」system-section，
 *     system_prompt / post_history_instructions → system-section，
 *     first_mes → pre-step 开场白（dedupe=session 每会话一次）；
 *   - 采样参数（temperature/openai_max_tokens/reasoning_effort）**不转译**：
 *     模型参数由「模型设置」UI 统一管理（预设级 params.model*，writePreset 渲染
 *     agent-request patch），ST 卡固化值会覆盖用户在模型设置里的设置，故剥离；
 *   - modules 按需组装：prompt-config-engine 始终，system-section 注入需要
 *     persona（complete: false 允许 system-section 生效），世界书条目需要 world-book-tools。
 */
import { createHash } from 'node:crypto'
import type { PresetSpec } from './manifest.ts'
import { readPresetLayerSettings } from './preset-layer-settings.ts'
import type { PersonaSpec } from '../shared/persona-section.ts'
import type {
  StConversionDiagnostic,
  StConversionEntryReport,
  StConversionReport,
} from '../shared/bridge-contract.ts'
import { buildWorldBookEntry } from './worldbook.ts'
import { prepareStText, renderStText } from '../../engine/st-macros.mjs'

/** 转换器版本：报告用它解释本次生成使用了哪一版语义（语义调整时同步递增）。
 *  v2：pre-step 角色统一降级为 user（原角色只作来源元数据）+ 选组优先级修正常量事实。
 *  v3：世界书触发键（keys/secondaryKeys）的未定义宏登记为空占位并产出可见诊断。 */
export const ST_CONVERTER_VERSION = 'st-to-preset/3'

/** 报告的展示上限：只截断观测数据，不改变转换结果。 */
const REPORT_ENTRY_LIMIT = 500
const REPORT_DIAGNOSTIC_LIMIT = 200

/**
 * pre-step 只接受 user：宿主把本批消息逐条写成 `user/message` 事件，事件校验要求
 * `role === 'user'`。ST 侧的 assistant/system 角色在导入期统一降级为 user，原角色
 * 保留在 stSource.role / stWorldBook.role，条目按 degraded 记录并带同一原因码。
 */
const ST_PRE_STEP_ROLE = 'user'
const ST_ROLE_DOWNGRADE_CODE = 'assistant-role-downgrade'

/**
 * `enable_web_search: false` 时被拒绝的 web 工具名。
 * 三个声明式触发器（assembly / sdk-strip / guard）共用这一份名单——呈现过滤与执行
 * 边界必须同一判据，不得各写一份（见 engine/actions.mjs 的 (5) 类说明）。
 */
const ST_WEB_TOOLS = ['web_search', 'web_fetch'] as const

/** ST marker prompts（marker: true）：content 不发送给模型（仅标记注入位置，ST
 *  以运行时内容填充该位置）；SPresetSettings 是旧版 ST 的预设设置 dump（正则
 *  脚本/扩展配置/ToolBindings，动辄数百 KB）。两者转换时整体丢弃并计数进
 *  meta.stDroppedMarkers——防止设置 dump 与位置占位污染 promptConfigs 与注入。 */

/** 显式文本求值工具；导入本身仅 prepare，避免执行禁用卡的副作用。 */
export function processStText(text: string, cardName: string, variables: Record<string, string | number>): string {
  return renderStText(prepareStText(text, cardName), { variables, local: variables }).trim()
}

/** 合并后的最终 id 映射：来源索引 → 该来源 promptConfigs 下标 → 合并后的配置 id。 */
export type MergeIdMap = Map<number, Map<number, string>>

/**
 * 合并多个转换结果为一个预设，并返回「来源 + 生成配置下标 → 最终 id」的同一份映射。
 *
 * 报告必须消费这份映射，而不是按后缀规则另行推测：后缀分配只发生在这里一次。
 */
export function mergeStPresetsWithReport(specs: PresetSpec[]): { spec: PresetSpec; idMap: MergeIdMap } {
  const promptConfigs: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  const idMap: MergeIdMap = new Map()
  for (const [sourceIndex, spec] of specs.entries()) {
    const perSource = new Map<number, string>()
    for (const [entryIndex, config] of (spec.promptConfigs ?? []).entries()) {
      if (config === null || typeof config !== 'object' || Array.isArray(config)) continue
      const entry = config as Record<string, unknown>
      const base = String(entry.id ?? '')
      // 防御：无 id 配置（异常输入）跳过，避免合并出空 id / -2 后缀的垃圾条目。
      if (base.length === 0) continue
      let id = base
      for (let suffix = 2; seen.has(id); suffix++) id = `${base}-${suffix}`
      seen.add(id)
      perSource.set(entryIndex, id)
      promptConfigs.push({ ...entry, id, variables: { ...(spec.variablesEnabled === false ? {} : spec.variables), ...entry.variables as Record<string, string> | undefined } })
    }
    idMap.set(sourceIndex, perSource)
  }
  const params: Record<string, unknown> = {}
  const layerSettings: NonNullable<PresetSpec['layerSettings']> = {}
  for (const spec of specs) {
    readPresetLayerSettings(spec)
    Object.assign(params, spec.params ?? {})
    for (const [layer, fields] of Object.entries(spec.layerSettings ?? {})) layerSettings[layer] = { ...layerSettings[layer], ...fields }
  }
  const variables = Object.fromEntries(specs.filter(spec => spec.variablesEnabled !== false).flatMap(spec => Object.entries(spec.variables ?? {})))
  const warnings = [...new Set(specs.flatMap(spec => Array.isArray(spec.meta?.stWarnings) ? spec.meta.stWarnings.filter((value): value is string => typeof value === 'string') : []))]
  const modules: string[] = []
  for (const spec of specs) {
    for (const name of spec.modules ?? []) {
      if (!modules.includes(name)) modules.push(name)
    }
  }
  const managementModules = [
    'character-tools',
    ...(promptConfigs.some((config) => config.strategy === 'world-book') ? ['world-book-tools'] : []),
    'session-var-tools',
    'tool-config-engine',
  ]
  for (const name of managementModules) if (!modules.includes(name)) modules.push(name)
  const moduleConfigs: Record<string, Record<string, unknown>> = {}
  for (const spec of specs) {
    for (const [key, value] of Object.entries(spec.moduleConfigs ?? {})) {
      moduleConfigs[key] = { ...moduleConfigs[key], ...value }
    }
  }
  // 顶层 persona 段（ST 转换只在含 system-section 时声明）合并保留：丢失会让
  // 合并预设回落宿主部署人设，导入的 system-section 被 complete 人设抑制。
  const persona = specs.find((spec) => spec.persona !== undefined)?.persona
  // 触发器声明按 id 去重合并：多源合并不丢「任一来声明过」的 web 拒绝名单（与 persona 同理）。
  // 同名 id 保留首个来源的载荷——同一 id 在两份来源里必然表达同一意图，不叠加两份 mask。
  const triggerDeclarations: unknown[] = []
  const triggerIds = new Set<string>()
  for (const source of specs) {
    for (const declaration of source.triggers ?? []) {
      const id = declaration !== null && typeof declaration === 'object' ? (declaration as { id?: unknown }).id : undefined
      if (typeof id === 'string' && triggerIds.has(id)) continue
      if (typeof id === 'string') triggerIds.add(id)
      triggerDeclarations.push(declaration)
    }
  }
  const stripSuffix = (name: string): string => name.replace(/（SillyTavern 转换）$/, '')
  const spec: PresetSpec = {
    // 多源合并：id 拼接（2 + beta-2-42 → 2-beta-2-42），避免与任一源预设冲突。
    id: specs.length > 1 ? specs.map((item) => item.id).join('-') : specs[0]!.id,
    name: specs.map((item) => stripSuffix(item.name)).join(' × ') + '（SillyTavern 合并）',
    version: '1.0.0',
    engineCompat: '>=0.4.2',
    meta: { source: 'sillytavern', ...(warnings.length > 0 ? { stWarnings: warnings } : {}) },
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(Object.keys(layerSettings).length > 0 ? { layerSettings } : {}),
    ...(Object.keys(variables).length > 0 ? { variables } : {}),
    ...(persona === undefined ? {} : { persona }),
    ...(triggerDeclarations.length > 0 ? { triggers: triggerDeclarations } : {}),
    modules,
    moduleConfigs,
    promptConfigs,
  }
  return { spec, idMap }
}

/** 合并多个转换结果为一个预设（角色卡 × 响应预设 → 单预设）。 */
export function mergeStPresets(specs: PresetSpec[]): PresetSpec {
  return mergeStPresetsWithReport(specs).spec
}

/** 转换选项：多 prompt_order 分组时显式选择来源角色，避免照搬「默认任取首组」。 */
export interface StConversionOptions {
  characterId?: string
}

/** prompt_order 分组候选：预览选组 UI 与实际转换消费同一份事实。 */
export interface StOrderGroupSummary {
  characterId: string
  entries: number
}

/** prompt_order 选择结果：命中组、候选与拒绝原因三者互斥。 */
interface StOrderResolution {
  groups: Array<Record<string, unknown>>
  /** 实际采用的顺序表；undefined = 无顺序表可用（回退 prompts 数组顺序）。 */
  group?: Record<string, unknown>
  /** 多组且按优先级无法明确选择时的有界候选（不宣称已转换）。 */
  needsSelection?: StOrderGroupSummary[]
  /** 输入本身非法（显式选择不存在、重复 character_id、多组歧义）。 */
  error?: string
}

/**
 * 选组优先级（唯一实现，转换与预览共用）：
 *   请求显式选择 → 文件内 character_id → 全局组 100001 → 仅有一组时回退。
 * 显式选择必须命中，命中失败不回落；重复 character_id 无法明确对应，一律拒绝。
 */
function resolveStOrder(record: Record<string, unknown>, options: StConversionOptions): StOrderResolution {
  if (!Array.isArray(record.prompt_order)) return { groups: [] }
  const groups = record.prompt_order.filter((entry): entry is Record<string, unknown> =>
    entry !== null && typeof entry === 'object' && Array.isArray(entry.order))
  const summaries = (list: Array<Record<string, unknown>>): StOrderGroupSummary[] =>
    list.map((entry) => ({ characterId: String(entry.character_id ?? ''), entries: (entry.order as unknown[]).length }))
  if (groups.length === 0) return { groups }
  const explicit = typeof options.characterId === 'string' && options.characterId.length > 0 ? options.characterId : undefined
  const fileCharacterId = record.character_id === undefined || record.character_id === null ? undefined : String(record.character_id)
  const find = (id: string | undefined): Record<string, unknown> | undefined =>
    id === undefined ? undefined : groups.find((entry) => String(entry.character_id) === id)
  let group = find(explicit)
  if (explicit !== undefined && group === undefined) {
    return { groups, needsSelection: summaries(groups), error: `SillyTavern prompt_order 不包含 character_id ${JSON.stringify(explicit)} 的顺序表` }
  }
  group ??= find(fileCharacterId)
  group ??= find('100001')
  if (group === undefined && groups.length === 1) [group] = groups
  if (group === undefined) {
    return {
      groups,
      ...(groups.length > 1
        ? { needsSelection: summaries(groups) }
        : {}),
    }
  }
  const picked = String(group.character_id ?? '')
  if (groups.filter((entry) => String(entry.character_id ?? '') === picked).length > 1) {
    return { groups, error: `SillyTavern prompt_order 中 character_id ${JSON.stringify(picked)} 重复，无法明确对应顺序表` }
  }
  return { groups, group }
}

/**
 * 预览选组状态：多组且按优先级无法明确选择时给出候选，让 UI 先让用户选组再重新预览；
 * 候选状态不代表已转换，调用方不得据此启用确认或提交。
 */
export function stOrderSelectionState(card: unknown, options: StConversionOptions = {}):
  { needsSelection: true; candidates: StOrderGroupSummary[] }
  | { needsSelection: false; error?: string } {
  const record = card !== null && typeof card === 'object' ? card as Record<string, unknown> : {}
  const resolved = resolveStOrder(record, options)
  if (resolved.error !== undefined) return { needsSelection: false, error: resolved.error }
  if (resolved.needsSelection !== undefined) return { needsSelection: true, candidates: resolved.needsSelection }
  return { needsSelection: false }
}

/** SillyTavern JSON 预设卡片 → 本项目 PresetSpec（导入端点直接消费）。 */
export function convertStToPreset(card: unknown, baseName: string, options: StConversionOptions = {}): PresetSpec {
  return convertStToPresetWithReport(card, baseName, options).spec
}

/**
 * 同源转换 + 结构化报告：预览与实际提交共用这一个纯函数实现，
 * 报告只是派生元数据（不进 preset.yml、不作写入凭证）。
 */
export function convertStToPresetWithReport(
  card: unknown,
  baseName: string,
  options: StConversionOptions = {},
): { spec: PresetSpec; report: StConversionReport } {
  const record = card !== null && typeof card === 'object' ? card as Record<string, unknown> : {}
  const prompts = Array.isArray(record.prompts)
    ? (record.prompts as Array<Record<string, unknown>>).filter((item) => item !== null && typeof item === 'object')
    : []
  // prompt_order（per-character 顺序 + 禁用标记）：ST 中 RELATIVE 注入的排列顺序
  // 完全由 prompt_order 数组顺序决定（injection_order 只对 in-chat 注入有效）；
  // 缺失/无效时回退 prompts 数组顺序。enabled=false 的条目即使 prompts 内未标也禁用。
  const orderIndex = new Map<string, number>()
  const orderEnabled = new Map<string, boolean>()
  const orderGroups: StConversionReport['orderGroups'] = []
  let ordered = false
  {
    const resolved = resolveStOrder(record, options)
    // 预览已在候选状态下让用户选组；走到转换仍无法明确选择时 fail loud，不默认任取首组。
    if (resolved.error !== undefined) throw new TypeError(resolved.error)
    if (resolved.needsSelection !== undefined) throw new TypeError('SillyTavern prompt_order 包含多个角色，请提供 character_id 或导出全局预设')
    const { groups, group } = resolved
    for (const entry of groups) {
      orderGroups.push({ characterId: String(entry.character_id ?? ''), selected: entry === group, entries: (entry.order as unknown[]).length })
    }
    if (Array.isArray(record.prompt_order)) {
      const order = group === undefined ? record.prompt_order : group.order as unknown[]
      ordered = group !== undefined || order.some(entry => entry !== null && typeof entry === 'object' && typeof (entry as Record<string, unknown>).identifier === 'string')
      let rank = 0
      for (const entry of order as Array<Record<string, unknown>>) {
        if (entry === null || typeof entry !== 'object') continue
        const id = typeof entry.identifier === 'string' ? entry.identifier : ''
        if (id.length === 0) continue
        if (!orderIndex.has(id)) orderIndex.set(id, rank)
        orderEnabled.set(id, entry.enabled === true)
        rank += 1
      }
    }
  }
  const configs: Array<Record<string, unknown>> = []
  /** preset.yml 顶层触发器声明（`enable_web_search: false` 的 web 拒绝名单在此登记）。 */
  const triggers: unknown[] = []
  // 世界书配置 id → 来源条目 id：键宏诊断必须定位到源条目，不按 id 前缀反推。
  const worldBookSources = new Map<string, string>()
  const droppedMarkers: string[] = []
  const diagnostics: StConversionDiagnostic[] = []
  const reportEntries: StConversionEntryReport[] = []
  const diagnosticKeys = new Set<string>()
  const warnings = new Set<string>()
  const classifications = { equivalent: 0, degraded: 0, unsupported: 0, excluded: 0 }
  let needsReview = 0
  let reportTruncated = false
  let sourceInputs = 0
  // 同一生成点维护完整事实；展示限长不能抹掉后续告警或兼容字段。
  const note = (code: string, message: string, extra: { entryId?: string; field?: string } = {}, severity: StConversionDiagnostic['severity'] = 'warning'): void => {
    const key = JSON.stringify([code, extra.entryId])
    if (diagnosticKeys.has(key)) return
    diagnosticKeys.add(key)
    if (severity === 'warning') {
      needsReview += 1
      warnings.add(message)
    }
    if (diagnostics.length >= REPORT_DIAGNOSTIC_LIMIT) { reportTruncated = true; return }
    diagnostics.push({
      code, severity, message,
      ...(extra.entryId !== undefined ? { entryId: extra.entryId } : {}),
      ...(extra.field !== undefined ? { field: extra.field } : {}),
    })
  }
  const recordEntry = (entry: StConversionEntryReport): void => {
    classifications[entry.classification] += 1
    if (reportEntries.length >= REPORT_ENTRY_LIMIT) { reportTruncated = true; return }
    // 绑定同源生成配置的下标：多文件合并后报告据此把 targetId 重写为最终 id，
    // 不再按后缀规则另行推测（推测会在跨来源重名时给出错误的"看起来正确"的 id）。
    let targetIndex: number | undefined
    if (entry.targetId !== undefined) {
      for (let index = configs.length - 1; index >= 0; index--) {
        if (configs[index]?.id === entry.targetId) { targetIndex = index; break }
      }
    }
    reportEntries.push(targetIndex === undefined ? entry : { ...entry, targetIndex })
  }
  /** info 级诊断：进入报告但**不**改变既有 stWarnings 表现。 */
  const noteInfo = (code: string, message: string, extra: { entryId?: string; field?: string } = {}): void => {
    note(code, message, extra, 'info')
  }
  let systemSectionCount = 0
  // 角色卡正文：chara_card_v3 实际内容在 data 内层（顶层为同步冗余），旧版顶层直存。
  const body = (record.data !== null && typeof record.data === 'object' ? record.data as Record<string, unknown> : record) as Record<string, unknown>
  // 不复制或执行扩展脚本，也不修改调用方持有的原始角色卡。
  const extensions = body.extensions !== null && typeof body.extensions === 'object'
    ? body.extensions as Record<string, unknown>
    : undefined
  if (extensions && Object.keys(extensions).some(key => /helper|script|regex|tavern/i.test(key))) {
    note('st-extension-scripts', 'ST 扩展脚本与正则不执行，依赖它们的界面或状态更新需要单独适配', { field: 'extensions' })
  }
  const bodyText = (key: string): string => typeof body[key] === 'string' ? (body[key] as string).trim() : ''
  const cardName = (typeof record.name === 'string' && record.name.trim().length > 0 ? record.name.trim()
    : typeof body.name === 'string' && body.name.trim().length > 0 ? (body.name as string).trim() : '')
  // 声明字段与自定义占位进 variables；赋值指令保持模板，由运行时帧负责。
  const variables: Record<string, string> = {}
  if (cardName && (body.description !== undefined || body.first_mes !== undefined || body.character_book !== undefined)) {
    variables.char = cardName
    variables.charifnotgroup = cardName
    variables.charIfNotGroup = cardName
  }
  // 导入只保留模板，不执行 set/add/inc：否则禁用卡和重复引用会污染变量。
  const clean = (text: string): string => prepareStText(text, cardName)
  // ST 字段宏 → 内容变量（决策：登记为内容变量，不写进模型人设段）。宏名与键名一致，
  // 登记后由引擎正常解析，工作台「模板变量」卡可编辑；值同样过一遍 ST 清洗，避免
  // {{char}} 之类的字面随值泄漏。字段缺失时不登记——若正文引用了它，由下方
  // 「未定义自定义宏登记」补空占位（保持「不留字面」语义）。
  for (const key of ['description', 'personality', 'scenario', 'persona'] as const) {
    const value = bodyText(key)
    if (value.length > 0) variables[key] = clean(value)
  }
  // ST 的世界书扫描字段来自 globalScanData（script.js:4626-4634）：creatorNotes 取
  // data.creator_notes、characterDepthPrompt 取 data.extensions.depth_prompt.prompt。
  // 这里把 creator_notes 登记为内容变量，供 matchCreatorNotes 扫描开关按需并入；
  // depth_prompt 的变量在同名配置生成处登记（两处都只在有内容时登记，缺省零噪音）。
  const creatorNotes = bodyText('creator_notes')
  if (creatorNotes.length > 0) variables.creator_notes = clean(creatorNotes)
  // 角色卡正文 → 提示词配置：角色设定（描述/性格/场景）拼接、系统提示、后续指令、开场白。
  // order 取负值使角色卡内容排在响应预设 prompts（order≥100）之前。
  const characterDefinition = [bodyText('description'), bodyText('personality'), bodyText('scenario')]
    .filter((text) => text.length > 0).join('\n\n')
  const characterDefinitionClean = clean(characterDefinition)
  if (characterDefinitionClean.length > 0) {
    sourceInputs += 1
    configs.push({ id: 'character-definition', name: '角色设定', strategy: 'static', order: -30, text: characterDefinitionClean, layer: 'system-section', mergeMode: 'merged' })
    recordEntry({ sourceId: 'description/personality/scenario', sourceIndex: 0, targetId: 'character-definition',
      layer: 'system-section', order: -30, classification: 'equivalent', codes: [] })
    systemSectionCount += 1
  }
  const systemPrompt = bodyText('system_prompt')
  const systemPromptClean = clean(systemPrompt)
  if (systemPromptClean.length > 0) {
    sourceInputs += 1
    configs.push({ id: 'system-prompt', name: '系统提示', strategy: 'static', order: -20, text: systemPromptClean, layer: 'system-section', mergeMode: 'merged' })
    recordEntry({ sourceId: 'system_prompt', sourceIndex: 0, targetId: 'system-prompt',
      layer: 'system-section', order: -20, classification: 'equivalent', codes: [] })
    systemSectionCount += 1
  }
  const postHistory = bodyText('post_history_instructions')
  const postHistoryClean = clean(postHistory)
  if (postHistoryClean.length > 0) {
    sourceInputs += 1
    configs.push({ id: 'post-history-instructions', name: '后续指令', strategy: 'static', order: -10, text: postHistoryClean, layer: 'system-section', mergeMode: 'merged' })
    // ST 的 post_history_instructions 语义是「历史之后覆盖」，DSH 只能放 system-section。
    // 只作 info 记录，不改变既有 stWarnings 表现（兼容旧展示与旧断言）。
    noteInfo('st-post-history', 'ST post_history_instructions 放入 system-section，不等于历史后覆盖', { entryId: 'post-history-instructions', field: 'post_history_instructions' })
    recordEntry({ sourceId: 'post_history_instructions', sourceIndex: 0, targetId: 'post-history-instructions',
      layer: 'system-section', order: -10, classification: 'degraded', codes: ['post-history-position'] })
    systemSectionCount += 1
  }
  // 示例对话保留为一次性的角色消息，不与实际开场白拼成同一消息。
  const examples = bodyText('mes_example')
  if (examples.length > 0) {
    const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const marker = new RegExp(`(?:^|\\n)\\s*(\\{\\{user\\}\\}|\\{\\{char\\}\\}|user|assistant${cardName ? `|${escape(cardName)}` : ''})\\s*:\\s*`, 'gi')
    let index = 0
    let exampleDowngraded = false
    for (const block of examples.split(/<START>/gi).filter(text => text.trim().length > 0)) {
      const turns = [...block.matchAll(marker)]
      const parts = turns.length > 0 ? turns.map((turn, at) => ({
        role: /^(?:\{\{user\}\}|user)$/i.test(turn[1]!) ? 'user' : 'assistant',
        text: block.slice(turn.index! + turn[0].length, turns[at + 1]?.index),
      })) : [{ role: 'user', text: block }]
      for (const part of parts) {
        const text = clean(part.text)
        if (!text) continue
        sourceInputs += 1
        const entryIndex = ++index
        const targetId = `dialogue-example-${entryIndex}`
        const order = -60 + entryIndex / 1000
        // pre-step 只发出 user；示例对话的 assistant 轮次降级，原角色留在 stSource.role。
        const downgraded = part.role === 'assistant'
        exampleDowngraded ||= downgraded
        configs.push({ id: targetId, name: `示例对话 ${entryIndex}`, strategy: 'static', text,
          layer: 'pre-step', role: 'user', position: 'before-all', dedupe: 'session', order,
          params: { stSource: { field: 'mes_example', role: part.role } } })
        recordEntry({ sourceId: `mes_example[${entryIndex}]`, sourceIndex: entryIndex - 1, targetId,
          layer: 'pre-step', order, role: 'user', position: 'before-all',
          classification: downgraded ? 'degraded' : 'equivalent',
          codes: downgraded ? [ST_ROLE_DOWNGRADE_CODE] : [] })
      }
    }
    if (exampleDowngraded) {
      noteInfo('st-example-role', 'DSH pre-step 只接受 user 角色：示例对话的 assistant 轮次降级为 user，原角色保留在 stSource.role', { entryId: 'mes_example', field: 'mes_example' })
    }
  }
  // 世界书仍经同一工厂构造，ST 特有触发语义由 params.stWorldBook 显式启用。
  // 形态兼容：entries 可能是数组（角色卡 CCv2/CCv3、spec v2）或对象
  // （ST 编辑器内部格式，键为字符串序数）。
  // 别名收敛：角色卡用 keys/secondary_keys/insertion_order/enabled/id，
  // ST 编辑器内部格式用 key/keysecondary/order/disable/uid——两套名字都真实
  // 存在，漏读会让关键词条目失去触发条件。
  const book = body.character_book ?? (body.entries !== undefined ? body : undefined)
  if (book !== null && typeof book === 'object' && !Array.isArray(book)) {
    const rawEntries = (book as Record<string, unknown>).entries
    const entryList = Array.isArray(rawEntries)
      ? rawEntries as Array<Record<string, unknown>>
      : rawEntries !== null && typeof rawEntries === 'object'
        ? Object.values(rawEntries as Record<string, unknown>)
          .filter((e): e is Record<string, unknown> => e !== null && typeof e === 'object' && !Array.isArray(e))
        : []
    for (const [index, entry] of entryList.entries()) {
      if (entry === null || typeof entry !== 'object') continue
      const content = clean(typeof entry.content === 'string' ? entry.content : '')
      sourceInputs += 1
      const sourceId = String(entry.id ?? entry.uid ?? index)
      if (content.length === 0) {
        recordEntry({ sourceId, sourceIndex: index, classification: 'excluded', codes: ['empty-content'] })
        continue
      }
      const comment = typeof entry.comment === 'string' && entry.comment.trim().length > 0
        ? entry.comment.trim() : `世界书 ${String(entry.id ?? entry.uid ?? index)}`
      const rawKeys = entry.keys ?? entry.key
      const keys = Array.isArray(rawKeys) ? rawKeys.map(String).filter((key) => key.trim().length > 0) : []
      const rawSecondary = entry.secondary_keys ?? entry.keysecondary
      const secondaryKeys = Array.isArray(rawSecondary)
        ? rawSecondary.map(String).filter((key) => key.trim().length > 0) : []
      // 常驻兼容：ST 编辑器内部格式用 constant，角色卡（CCv2/CCv3）world entries 用 add_always。
      const constant = entry.constant === true || entry.add_always === true
      // 启用兼容：disable 是 ST 编辑器内部格式（disable=true 禁用），enabled 是角色卡格式。
      const enabled = entry.disable !== undefined ? entry.disable !== true : entry.enabled !== false
      // ST 降序选择候选后 unshift，最终正文低 order 在前；选择优先级留给选择器。
      const stOrder = typeof entry.insertion_order === 'number'
        ? entry.insertion_order
        : (typeof entry.order === 'number' ? entry.order : 100)
      const ext = entry.extensions !== null && typeof entry.extensions === 'object' && !Array.isArray(entry.extensions)
        ? entry.extensions as Record<string, unknown> : {}
      // 字段别名收敛：每个作用域内按「主名 → 兼容别名」取首个非 undefined 值，
      // extensions 整体优先于条目顶层；用 !== undefined 判定，false/0 不当缺省丢弃。
      const option = (...names: string[]): unknown => {
        for (const scope of [ext, entry]) {
          for (const name of names) if (scope[name] !== undefined) return scope[name]
        }
        return undefined
      }
      const position = option('position') ?? (entry.position === 'after_char' ? 1 : 0)
      const stWorldBook: Record<string, unknown> = {
        selective: entry.selective === true,
        position, depth: option('depth') ?? 4, role: option('role') ?? 0,
        scanDepth: option('scan_depth', 'scanDepth') ?? (book as Record<string, unknown>).scan_depth ?? 2,
      }
      if ((book as Record<string, unknown>).recursive_scanning === true) stWorldBook.recursive = true
      for (const [target, source] of Object.entries({ probability: 'probability', useProbability: 'useProbability', group: 'group',
        groupOverride: 'group_override', groupWeight: 'group_weight', sticky: 'sticky', cooldown: 'cooldown', delay: 'delay',
        recursive: 'recursive_scanning', excludeRecursion: 'exclude_recursion', preventRecursion: 'prevent_recursion',
        // 条目级条件字段（ST 有而我们此前未读）：延迟到递归扫描与组内评分。
        // 磁盘形态是驼峰顶层 / extensions 蛇形，两种拼写都读。
        delayUntilRecursion: 'delay_until_recursion', useGroupScoring: 'use_group_scoring',
        matchCharacterDescription: 'match_character_description', matchCharacterPersonality: 'match_character_personality',
        matchScenario: 'match_scenario', matchPersonaDescription: 'match_persona_description',
        // ST 的 globalScanData 另有 creator notes 与角色深度提示词两个扫描开关
        // （world-info.js:5664/5666，磁盘形态是 extensions 蛇形）。
        matchCreatorNotes: 'match_creator_notes', matchCharacterDepthPrompt: 'match_character_depth_prompt' })) {
        // ST 内嵌 extensions 的导出形状为蛇形（use_probability）；既有驼峰拼写仍是主名。
        const value = option(source, target, ...(target === 'useProbability' ? ['use_probability'] : []))
        if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') stWorldBook[target] = value
      }
      const sourceRole = stWorldBook.role
      // 角色过滤（ST 1.19 条目级条件）：真实形态是嵌套对象 `{ names, tags, isExclude }`
      // （world-info.js:2125-2132 规范化、:4815-4843 求值），不是三个顶层字段。本项目没有
      // 「运行时切换角色」这一层（预设与角色在导入期绑定），因此不实现过滤、也不据此跳过
      // 条目（避免静默丢失），只保留原始字段并对实际启用的条目显式告警。
      const rawFilter = entry.characterFilter
      const filterSource = rawFilter !== null && typeof rawFilter === 'object' && !Array.isArray(rawFilter)
        ? rawFilter as Record<string, unknown> : undefined
      const filterNames = Array.isArray(filterSource?.names) ? filterSource.names as unknown[] : []
      const filterTags = Array.isArray(filterSource?.tags) ? filterSource.tags as unknown[] : []
      if (filterSource !== undefined) {
        stWorldBook.characterFilter = {
          ...filterSource,
          ...(Array.isArray(filterSource.names) ? { names: [...filterSource.names as unknown[]] } : {}),
          ...(Array.isArray(filterSource.tags) ? { tags: [...filterSource.tags as unknown[]] } : {}),
        }
      }
      const entryCodes: string[] = []
      if (filterNames.length > 0 || filterTags.length > 0) {
        entryCodes.push('character-filter-unsupported')
        note('st-worldbook-character-filter', 'ST 角色/标签过滤在本项目不受支持：该条目会对所有角色生效', { entryId: sourceId, field: 'characterFilter' })
      }
      if (position === 4) {
        entryCodes.push('depth-collapsed')
        note('st-worldbook-depth', 'ST 世界书深度位置无法映射到持久历史：保留 position/depth/role，降级为当前消息批末尾', { entryId: sourceId, field: 'position' })
      } else if (![0, 1, 'before_char', 'after_char'].includes(position as number | string)) {
        entryCodes.push('position-downgraded')
        note('st-worldbook-position', 'ST 世界书特殊插入点暂不可用：保留来源位置，降级为当前消息批头部', { entryId: sourceId, field: 'position' })
      }
      if (sourceRole === 0) {
        entryCodes.push('system-role-downgrade')
        note('st-worldbook-role', 'DSH pre-step 不接受 system 角色：世界书 system 消息降级为 user，原角色保留在 stWorldBook', { entryId: sourceId, field: 'role' })
      } else if (sourceRole === 2) {
        // assistant 只能由模型侧事件产生：导入期就降级，运行时出口不会再出现非法角色。
        entryCodes.push(ST_ROLE_DOWNGRADE_CODE)
        noteInfo('st-worldbook-role-assistant', 'DSH pre-step 只接受 user 角色：世界书 assistant 消息降级为 user，原角色保留在 stWorldBook.role', { entryId: sourceId, field: 'role' })
      }
      // STscript 自动化与 outlet：ST 独立世界书的这两个字段是**顶层驼峰**
      // （automationId / outletName），编辑器内部格式写在 extensions 蛇形别名里——只查蛇形
      // 会漏检真实信号。两者都只保留事实，不作为注入依据。
      const rawAutomationId = option('automation_id', 'automationId')
      const rawOutletName = option('outlet_name', 'outletName')
      // 两个字段的类型都是字符串（STscript 脚本名 / outlet 名）：非字符串形态（数字 0、
      // 布尔、对象）视为未设置——否则 String(0)/String(false) 非空会被误报成依赖自动化。
      const automationId = typeof rawAutomationId === 'string' ? rawAutomationId.trim() : ''
      const outletName = typeof rawOutletName === 'string' ? rawOutletName.trim() : ''
      if (automationId.length > 0) stWorldBook.automationId = rawAutomationId
      if (outletName.length > 0) stWorldBook.outletName = rawOutletName
      if (option('vectorized') === true || outletName.length > 0
        || (Array.isArray(option('triggers')) && (option('triggers') as unknown[]).length > 0)) {
        entryCodes.push('unsupported-controls')
        note('st-worldbook-controls', 'ST 世界书向量、outlet 或生成类型控制需要宿主专门适配', { entryId: sourceId, field: 'extensions' })
      }
      if (automationId.length > 0) {
        entryCodes.push('automation-dependent')
        // 无主键且非常驻的条目在 ST 侧同样只能靠自动化触发：文案必须说明它不会自动注入，
        // 否则「保留了字段」会被读成「内容还在生效」。
        const onlyAutomation = keys.length === 0 && secondaryKeys.length === 0 && constant !== true
        note('st-worldbook-automation', onlyAutomation
          ? '该条目依赖 STscript 自动化触发，本项目不执行自动化；它没有主键也非常驻，因此不会自动注入'
          : '该条目依赖 STscript 自动化触发，本项目不执行自动化', { entryId: sourceId, field: 'automationId' })
      }
      if (enabled === false) entryCodes.push('disabled')
      const worldConfig = buildWorldBookEntry({
        id: `lore-${sourceId}`,
        name: comment,
        // 启用状态保留；非常驻且无主键的 ST 条目不再隐式常驻。
        enabled,
        order: stOrder,
        text: content,
        constant,
        keys: keys.length > 0 ? keys : undefined,
        secondaryKeys: secondaryKeys.length > 0 ? secondaryKeys : undefined,
        ...(option('case_sensitive', 'caseSensitive') === true ? { caseSensitive: true } : {}),
        ...(option('match_whole_words', 'matchWholeWords') === true ? { wholeWords: true } : {}),
        // selectiveLogic（ST world_info_logic 0/1/2/3）：选择性触发组合逻辑，
        // 由 anchor-match 引擎消费（any/all/not）。保留不再丢弃。
        ...(typeof option('selectiveLogic', 'selective_logic') === 'number'
          ? { selectiveLogic: option('selectiveLogic', 'selective_logic') as number }
          : {}),
      })
      configs.push({ ...worldConfig, role: ST_PRE_STEP_ROLE,
        position: position === 4 ? 'after-all' : 'before-all',
        params: { ...worldConfig.params as Record<string, unknown>, stWorldBook } })
      worldBookSources.set(String(worldConfig.id), sourceId)
      recordEntry({ sourceId, sourceIndex: index, targetId: `lore-${sourceId}`,
        layer: 'pre-step', order: stOrder, role: ST_PRE_STEP_ROLE,
        position: position === 4 ? 'after-all' : 'before-all',
        classification: entryCodes.includes('unsupported-controls') ? 'unsupported'
          : entryCodes.some((code) => code !== 'disabled') ? 'degraded' : 'equivalent',
        codes: entryCodes })
    }
  }
  // ST 的角色深度提示词（char-data.js:73-76：{ prompt, depth, role }）：ST 只在群聊里
  // 自动注入（group-chats.js:459-464），world-info 的 matchCharacterDepthPrompt 也读它。
  // 本项目没有群聊：默认注入会造成「ST 不注入而我们注入」的反向不等价，因此保留为一条
  // **禁用**配置——内容、来源与原因码都在产物里，用户可手动启用；正文不进模型上下文。
  const depthPromptRaw = extensions?.depth_prompt
  const depthPromptSource = depthPromptRaw !== null && typeof depthPromptRaw === 'object' && !Array.isArray(depthPromptRaw)
    ? depthPromptRaw as Record<string, unknown> : undefined
  const depthPromptText = typeof depthPromptSource?.prompt === 'string' ? clean(depthPromptSource.prompt) : ''
  if (depthPromptText.length > 0) {
    variables.depth_prompt = depthPromptText
    sourceInputs += 1
    const order = -50
    configs.push({
      id: 'st-depth-prompt', name: '角色深度提示词', strategy: 'static', enabled: false, order,
      text: depthPromptText, layer: 'pre-step', mergeMode: 'merged', role: ST_PRE_STEP_ROLE,
      position: 'before-all', dedupe: 'none',
      params: { stSource: { field: 'extensions.depth_prompt', depth: depthPromptSource?.depth ?? 4, role: depthPromptSource?.role ?? 0 } },
    })
    recordEntry({ sourceId: 'extensions.depth_prompt', sourceIndex: 0, targetId: 'st-depth-prompt',
      layer: 'pre-step', order, role: ST_PRE_STEP_ROLE, position: 'before-all',
      classification: 'degraded', codes: ['depth-prompt-group-only'] })
    noteInfo('st-depth-prompt', 'ST 角色深度提示词只在群聊自动注入：本项目保留为默认禁用的 pre-step 配置，可由用户手动启用', { entryId: 'st-depth-prompt', field: 'extensions.depth_prompt' })
  }
  const firstMes = clean(bodyText('first_mes'))
  if (firstMes.length > 0) {
    sourceInputs += 1
    // 开场白：ST 的 assistant 侧开场白在 pre-step 降级为 user + 每会话一次
    // （dedupe=session 避免每轮重复注入），原角色保留在 stSource.role。
    configs.push({
      id: 'first-mes', name: '开场白', strategy: 'static', order: -40, text: firstMes,
      layer: 'pre-step', mergeMode: 'merged', role: ST_PRE_STEP_ROLE, position: 'before-all', dedupe: 'session',
      params: { stSource: { field: 'first_mes', role: 'assistant' } },
    })
    recordEntry({ sourceId: 'first_mes', sourceIndex: 0, targetId: 'first-mes',
      layer: 'pre-step', order: -40, role: ST_PRE_STEP_ROLE, position: 'before-all',
      classification: 'degraded', codes: [ST_ROLE_DOWNGRADE_CODE] })
    noteInfo('st-first-mes-role', 'DSH pre-step 只接受 user 角色：ST 开场白降级为 user，原角色保留在 stSource.role', { entryId: 'first_mes', field: 'first_mes' })
  }
  // 备用开场白（alternate_greetings）：首条已启用；备用条目转禁用配置（UI 可切换启用，
  // fallback 起点——引擎按 order 排序，同一 dedupe=session 身份不重复注入）。
  const alternateGreetings = Array.isArray(body.alternate_greetings)
    ? (body.alternate_greetings as unknown[]).map((item) => typeof item === 'string' ? item : '').map(clean).filter((item) => item.length > 0)
    : []
  if (alternateGreetings.length > 0) {
    noteInfo('st-alternate-greetings-role', 'DSH pre-step 只接受 user 角色：备用开场白降级为 user，原角色保留在 stSource.role', { entryId: 'alternate_greetings', field: 'alternate_greetings' })
  }
  for (const [index, greeting] of alternateGreetings.entries()) {
    sourceInputs += 1
    const targetId = `first-mes-${index + 2}`
    const order = -40 + index + 1
    configs.push({
      id: targetId,
      name: `开场白 ${index + 2}`,
      strategy: 'static',
      enabled: false,
      order,
      text: greeting,
      layer: 'pre-step',
      mergeMode: 'merged',
      role: ST_PRE_STEP_ROLE,
      position: 'before-all',
      dedupe: 'session',
      params: { stSource: { field: `alternate_greetings[${index}]`, role: 'assistant' } },
    })
    recordEntry({ sourceId: `alternate_greetings[${index}]`, sourceIndex: index, targetId,
      layer: 'pre-step', order, role: ST_PRE_STEP_ROLE, position: 'before-all',
      classification: 'degraded', codes: [ST_ROLE_DOWNGRADE_CODE] })
  }

  for (const [index, prompt] of prompts.entries()) {
    const rawId = typeof prompt.identifier === 'string' ? prompt.identifier : ''
    const sourceId = rawId.length > 0 ? rawId : `prompt-${index + 1}`
    sourceInputs += 1
    // ST 系统/标记条目丢弃（计数供 meta 审计）：
    //  - marker: true = ST 权威位置标记信号，content 不发送给模型（ST 以运行时
    //    内容填充该位置）——marker 标志优先于 identifier 判定；
    //  - SPresetSettings = 旧版 ST 预设设置 dump（正则脚本/扩展配置），无论
    //    marker 标志整体丢弃；
    //  - 非 marker 的 main/nsfw 等同名条目保留——社区预设存在借名装真实
    //    提示词的合法用法（enabled 状态照常转换）。
    if (prompt.marker === true || rawId === 'SPresetSettings') {
      if (rawId.length > 0) droppedMarkers.push(rawId)
      recordEntry({ sourceId, sourceIndex: index, classification: 'excluded', codes: ['marker-dropped'] })
      continue
    }
    const content = clean(typeof prompt.content === 'string' ? prompt.content : '')
    if (content.length === 0) {
      recordEntry({ sourceId, sourceIndex: index, classification: 'excluded', codes: ['empty-content'] })
      continue
    }
    const id = rawId.length > 0 && !/^[0-9a-f-]{36}$/i.test(rawId) ? rawId : `st-prompt-${index + 1}`
    // ST 角色：system=系统消息（进 system-section 层，pre-step 无 system 角色）；
    // user/assistant/model 进 pre-step，但 pre-step 只发出 user——ST 的 assistant
    // 与 'model'（第三方扩展角色）在导入期统一降级，原角色保留在 stSource.role。
    const stRole = typeof prompt.role === 'string' ? prompt.role : 'system'
    const preStep = stRole !== 'system'
    const role = preStep ? ST_PRE_STEP_ROLE : 'system'
    const roleDowngraded = preStep && stRole !== 'user'
    // ST 的 prompts[].system_prompt 是「内置/全局 prompt」的管理位（不可删除、不参与导出、
    // 不在 append 候选里），发送角色与位置仍由 role 与 prompt_order 决定
    // （openai.js:1187-1257、PromptManager.js:1723-1729）。因此只保留事实、不改层归属。
    const systemPromptFlag = prompt.system_prompt === true
    const base = {
      id,
      name: typeof prompt.name === 'string' && prompt.name.length > 0 ? prompt.name : id,
      // 保留 SillyTavern 启用状态：prompt_order 禁用标记优先，其次 prompts 内 enabled。
      // 注意用原始 identifier 查表（UUID 会被 id 生成规则替换为 st-prompt-N，查生成 id 永远 miss）。
      enabled: ordered ? orderEnabled.get(rawId) === true : prompt.enabled !== false,
      strategy: 'static',
      // RELATIVE 注入顺序 = prompt_order 数组顺序（ST 忽略 injection_order）；
      // 无映射时按数组索引，保持 ST 预设内相对顺序。
      order: ((rawId.length > 0 ? orderIndex.get(rawId) : undefined) ?? (ordered ? orderIndex.size + index : index)) * 10,
      text: content,
      // stSource 除深度/触发外也承载角色降级与 system_prompt 事实：原角色必须可定位。
      ...((prompt.injection_position === 1 || Array.isArray(prompt.injection_trigger) || roleDowngraded || systemPromptFlag) ? { params: { stSource: {
        position: prompt.injection_position ?? 0, depth: prompt.injection_depth ?? 4,
        order: prompt.injection_order ?? 100, role: stRole,
        ...(Array.isArray(prompt.injection_trigger) ? { triggers: prompt.injection_trigger } : {}),
        ...(systemPromptFlag ? { systemPrompt: true } : {}),
      } } } : {}),
    }
    const codes: string[] = []
    if (systemPromptFlag) {
      noteInfo('st-prompt-system-flag', 'ST 的 prompts[].system_prompt 只标记内置/全局 prompt，不改变发送角色：本条仍按 role 分层', { entryId: sourceId, field: 'system_prompt' })
    }
    if (roleDowngraded) {
      codes.push(ST_ROLE_DOWNGRADE_CODE)
      noteInfo('st-prompt-role', 'DSH pre-step 只接受 user 角色：ST prompt 的 assistant/model 角色降级为 user，原角色保留在 stSource.role', { entryId: sourceId, field: 'role' })
    }
    if (prompt.injection_position === 1) {
      codes.push('depth-collapsed')
      note('st-prompt-depth', 'ST prompt 深度注入暂按 DSH 插入点降级，原 position/depth/order/role 保留在 stSource', { entryId: sourceId, field: 'injection_position' })
    }
    if (Array.isArray(prompt.injection_trigger) && prompt.injection_trigger.length > 0) {
      codes.push('generation-trigger')
      note('st-prompt-triggers', 'ST prompt 的生成类型触发条件在 DSH 不等价，保留在 stSource.triggers', { entryId: sourceId, field: 'injection_trigger' })
    }
    if (base.enabled === false) codes.push(ordered && orderIndex.get(rawId) === undefined ? 'not-in-order-group' : 'disabled')
    if (!preStep) {
      configs.push({ ...base, layer: 'system-section', mergeMode: 'merged' })
      systemSectionCount += 1
    } else {
      configs.push({
        ...base,
        layer: 'pre-step',
        mergeMode: 'merged',
        role,
        position: prompt.injection_position === 0 ? 'before-all' : 'after-user',
        dedupe: 'none',
      })
    }
    recordEntry({ sourceId, sourceIndex: index, targetId: id,
      layer: preStep ? 'pre-step' : 'system-section', order: base.order,
      role: preStep ? role : undefined,
      position: preStep ? (prompt.injection_position === 0 ? 'before-all' : 'after-user') : undefined,
      classification: codes.includes('depth-collapsed') || codes.includes('generation-trigger') || roleDowngraded ? 'degraded' : 'equivalent',
      codes })
  }

  // modules 按需组装：prompt-config-engine 始终。
  const modules = ['prompt-config-engine', 'character-tools']
  if (configs.some((config) => config.strategy === 'world-book')) modules.push('world-book-tools')
  modules.push('session-var-tools', 'tool-config-engine')
  const moduleConfigs: Record<string, Record<string, unknown>> = {}
  // 含 system-section 段时用顶层 persona 段声明官方人设行：空 prefix 只做 scope
  // shadow（不注入标准编码 Agent 人设），complete: false 允许导入的 system-section
  // 生效（宿主部署人设 complete: true 会抑制它们）。
  const persona: PersonaSpec | undefined = systemSectionCount > 0 ? { prefix: '', complete: false } : undefined
  // enable_web_search 的两手（B7 T3「3+1 结合」，取代已删除的 tool-filter 专用模块）：
  //   true  → 组装 tool-web（fetch: true 启用），web 工具行进 modules；
  //   false → ① **web 相关行根本不进 modules**（不组装 tool-web，也不再写 tool-filter 行配置）；
  //           ② 同时产出三条声明式触发器（共用同一份 deny 名单）兜住「宿主/其他模块
  //              仍装配了 tool-web」的情形：assembly 裁呈现、sdk-strip 裁 tools:sdk 正文、
  //              guard 落到 agent scope 的执行边界（旧 tool-filter 只有呈现这一层）。
  if (record.enable_web_search === true) {
    modules.push('tool-web')
    moduleConfigs['tool-web'] = { fetch: true }
  } else if (record.enable_web_search === false) {
    triggers.push(
      { id: 'st-web-assembly', channel: 'system-prompt/assemble', do: { kind: 'assembly', target: { tools: { deny: [...ST_WEB_TOOLS] } } } },
      { id: 'st-web-sdk-strip', channel: 'system-prompt/assemble', do: { kind: 'sdk-strip', mask: { deny: [...ST_WEB_TOOLS] } } },
      { id: 'st-web-guard', channel: 'system-prompt/assemble', do: { kind: 'guard', mask: { deny: [...ST_WEB_TOOLS] } } },
    )
  }

  const presetId = stPresetId(baseName)
  // 出口不变量：pre-step 只发出 user。各来源路径已在生成时逐条降级（原角色进
  // stSource / stWorldBook）；这里兜住任何遗漏，保证写进 preset.yml 的角色可注入。
  for (const config of configs) {
    if (config.layer !== 'pre-step' || config.role === ST_PRE_STEP_ROLE) continue
    const requested = config.role
    config.role = ST_PRE_STEP_ROLE
    noteInfo('st-pre-step-role-fallback', `DSH pre-step 只接受 user 角色：${String(config.id)} 声明的 ${JSON.stringify(requested)} 已降级为 user`, { entryId: String(config.id), field: 'role' })
  }
  // 未定义自定义宏登记：卡内文本引用了但无变量源的 {{key}}（非内置 / 非运行时宏）
  // → 预设 variables 空值占位——插值替换为空不留字面；模板变量卡片可编辑默认值；
  // 会话变量工具（session_var）可运行时覆盖（对应 ST 正则/STscript 更新语义）。
  const RUNTIME_MACROS = new Set(['lastusermessage', 'lastcharmessage', 'charifnotgroup', 'time', 'date', 'weekday', 'isotime', 'isodate', 'random', 'pick', 'roll', 'chance', 'newline', 'pipe'])
  const BUILTIN_KEYS = new Set(['DSH_HOME', 'WORKSPACE', 'CWD'])
  const MACRO_RE = /\{\{([A-Za-z0-9_.\u4e00-\u9fff-]+)\}\}/g
  // 判定基准是「登记开始时的变量表」：同一宏在后续条目里仍算未解析，诊断才能定位到
  // 每一条受影响的条目；登记动作本身幂等。
  const declaredKeys = new Set(Object.keys(variables).map((key) => key.toLowerCase()))
  const knownKeys = new Set(declaredKeys)
  const hasMacroSource = (key: string): boolean =>
    declaredKeys.has(key.toLowerCase()) || RUNTIME_MACROS.has(key.toLowerCase()) || BUILTIN_KEYS.has(key)
  /** 登记未定义宏为空占位；返回识别到的未解析宏名（空数组表示全部已有来源）。 */
  const registerMacros = (raw: unknown): string[] => {
    const missing: string[] = []
    MACRO_RE.lastIndex = 0
    for (const match of String(raw).matchAll(MACRO_RE)) {
      const key = match[1]!
      if (hasMacroSource(key)) continue
      missing.push(key)
      const lower = key.toLowerCase()
      if (!knownKeys.has(lower)) { knownKeys.add(lower); variables[key] = '' }
    }
    return missing
  }
  /** 键宏诊断文案：不记录键正文与卡片内容，只说明失效原因与恢复路径。 */
  const KEY_MACRO_MESSAGE = '世界书触发键含未解析的 ST 宏：已登记为空占位，在「模板变量」中赋值后该键才会命中'
  for (const config of configs) {
    config.params = { ...config.params as Record<string, unknown> | undefined, stMacros: true }
    const configRecord = config as { params?: { text?: unknown; keys?: unknown; secondaryKeys?: unknown } }
    const texts = [
      ...(typeof config.text === 'string' && config.text.length > 0 ? [config.text] : []),
      ...(Array.isArray(config.texts) ? config.texts : []),
      ...(typeof configRecord.params?.text === 'string' ? [configRecord.params.text] : []),
    ]
    for (const raw of texts) registerMacros(raw)
    // 触发键与正文共用同一份排除集与同一张变量表：ST 匹配前会对主键/副键求值
    // （world-info.js:4915/4947），键里的 {{user}} 之类无源宏在本项目同样按空值处理，
    // 不再以字面量参与匹配；受影响条目逐条产出可定位诊断。
    if (config.strategy === 'world-book') {
      const entryId = worldBookSources.get(String(config.id))
      for (const [field, value] of [['keys', configRecord.params?.keys], ['secondaryKeys', configRecord.params?.secondaryKeys]] as const) {
        const missing = (Array.isArray(value) ? value : []).flatMap((key) => registerMacros(key))
        if (missing.length > 0 && entryId !== undefined) note('st-key-macro', KEY_MACRO_MESSAGE, { entryId, field })
      }
    }
  }
  const stWarnings = [...warnings]
  const report: StConversionReport = {
    converter: ST_CONVERTER_VERSION,
    sourceName: baseName,
    orderGroups,
    entries: reportEntries,
    diagnostics,
    summary: {
      inputs: sourceInputs,
      converted: configs.length,
      disabled: configs.filter((config) => config.enabled === false).length,
      excluded: classifications.excluded,
      unsupported: classifications.unsupported,
      degraded: classifications.degraded,
      needsReview,
    },
    ...(reportTruncated ? { truncated: true } : {}),
  }
  // 预设名优先取卡片 name 字段；缺失/空白时回退文件名（去 .json 的 baseName）。
  const spec: PresetSpec = {
    id: presetId,
    name: `${cardName || baseName}（SillyTavern 转换）`,
    version: '1.0.0',
    engineCompat: '>=0.4.2',
    // 来源标记：角色管理页据此列出「从 SillyTavern 导入的预设」；
    // stDroppedMarkers 审计丢弃的系统/标记条目（SPresetSettings 等）。
    meta: {
      source: 'sillytavern',
      ...(stWarnings.length > 0 ? { stWarnings } : {}),
      ...(droppedMarkers.length > 0 ? { stDroppedMarkers: droppedMarkers } : {}),
    },
    ...(Object.keys(variables).length > 0 ? { variables } : {}),
    ...(persona === undefined ? {} : { persona }),
    // 声明式触发器：物化为 triggers.yml，并由 loadCompositionText 自动补 declared-triggers 行。
    ...(triggers.length > 0 ? { triggers } : {}),
    modules,
    moduleConfigs,
    promptConfigs: configs,
  }
  return { spec, report }
}

/** 合并报告的一个来源：显示名 + 该来源的最终 id 映射（来自 {@link mergeStPresetsWithReport}）。 */
export interface MergeReportSource {
  /** 来源显示名（上传文件显示名，不含绝对路径）。 */
  sourceName: string
  /** 该来源的 promptConfigs 下标 → 合并后的最终 id。 */
  idMap?: Map<number, string>
}

/**
 * 多文件导入合并各自报告：条目/诊断有界截断、计数求和。
 *
 * 传入 `sources` 时，条目的 `targetId` 被重写为**合并后的最终 id**（消费
 * `mergeStPresetsWithReport` 的同一份映射），并补上来源显示名与来源序号；
 * 诊断的 `targetId` 同样按映射定位。不传时保持旧行为（不重写）。
 */
export function mergeStConversionReports(
  reports: StConversionReport[],
  sources: MergeReportSource[] = [],
): StConversionReport {
  const finalIdOf = (sourceIndex: number, entry: StConversionEntryReport): string | undefined => {
    if (entry.targetIndex === undefined) return undefined
    return sources[sourceIndex]?.idMap?.get(entry.targetIndex)
  }
  const entries = reports.flatMap((report, sourceIndex) => report.entries.map((entry) => {
    const source = sources[sourceIndex]
    const finalId = finalIdOf(sourceIndex, entry)
    return {
      ...entry,
      ...(source === undefined ? {} : { sourceName: source.sourceName, sourceFileIndex: sourceIndex }),
      ...(finalId === undefined ? {} : { targetId: finalId }),
    }
  })).slice(0, REPORT_ENTRY_LIMIT)
  const diagnostics = reports.flatMap((report, sourceIndex) => report.diagnostics.map((item) => {
    if (item.entryId === undefined) return item
    const entry = report.entries.find((candidate) => candidate.sourceId === item.entryId)
    const finalId = entry === undefined ? undefined : finalIdOf(sourceIndex, entry)
    return finalId === undefined ? item : { ...item, targetId: finalId }
  })).slice(0, REPORT_DIAGNOSTIC_LIMIT)
  const total = (pick: (summary: StConversionReport['summary']) => number): number =>
    reports.reduce((sum, report) => sum + pick(report.summary), 0)
  return {
    converter: ST_CONVERTER_VERSION,
    sourceName: reports.map((report) => report.sourceName).join(' + '),
    orderGroups: reports.flatMap((report) => report.orderGroups),
    entries,
    diagnostics,
    summary: {
      inputs: total((summary) => summary.inputs),
      converted: total((summary) => summary.converted),
      disabled: total((summary) => summary.disabled),
      excluded: total((summary) => summary.excluded),
      unsupported: total((summary) => summary.unsupported),
      degraded: total((summary) => summary.degraded),
      needsReview: total((summary) => summary.needsReview),
    },
    ...(reports.some((report) => report.truncated === true)
      || reports.flatMap((report) => report.entries).length > entries.length
      || reports.flatMap((report) => report.diagnostics).length > diagnostics.length ? { truncated: true } : {}),
  }
}

/** ST 导入预设 id：必须是官方 agent-presets 可发现的目录名（PRESET_ID =
 *  /^[a-z0-9][a-z0-9-]*$/——含中文的目录会被宿主 discovery 静默跳过，会话
 *  resume 报 preset not found）。文件名 slug 化（去中文）；纯中文名退化为
 *  st-<文件名短哈希>（唯一且合法）；显示名 name 仍保留中文原名。 */
export function stPresetId(baseName: string): string {
  const slug = baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || `st-${createHash('sha1').update(baseName).digest('hex').slice(0, 6)}`
}
