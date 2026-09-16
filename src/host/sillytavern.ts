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
import type { PersonaSpec } from '../shared/persona-section.ts'
import type {
  StConversionDiagnostic,
  StConversionEntryReport,
  StConversionReport,
} from '../shared/bridge-contract.ts'
import { buildWorldBookEntry } from './worldbook.ts'
import { prepareStText, renderStText } from '../../engine/st-macros.mjs'

/** 转换器版本：报告用它解释本次生成使用了哪一版语义（语义调整时同步递增）。 */
export const ST_CONVERTER_VERSION = 'st-to-preset/1'

/** 报告的展示上限：只截断观测数据，不改变转换结果。 */
const REPORT_ENTRY_LIMIT = 500
const REPORT_DIAGNOSTIC_LIMIT = 200

/** ST marker prompts（marker: true）：content 不发送给模型（仅标记注入位置，ST
 *  以运行时内容填充该位置）；SPresetSettings 是旧版 ST 的预设设置 dump（正则
 *  脚本/扩展配置/ToolBindings，动辄数百 KB）。两者转换时整体丢弃并计数进
 *  meta.stDroppedMarkers——防止设置 dump 与位置占位污染 promptConfigs 与注入。 */

/** 显式文本求值工具；导入本身仅 prepare，避免执行禁用卡的副作用。 */
export function processStText(text: string, cardName: string, variables: Record<string, string | number>): string {
  return renderStText(prepareStText(text, cardName), { variables, local: variables }).trim()
}

/** 合并多个转换结果为一个预设（角色卡 × 响应预设 → 单预设）。 */
export function mergeStPresets(specs: PresetSpec[]): PresetSpec {
  const promptConfigs: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  for (const spec of specs) {
    for (const config of spec.promptConfigs ?? []) {
      if (config === null || typeof config !== 'object' || Array.isArray(config)) continue
      const entry = config as Record<string, unknown>
      const base = String(entry.id ?? '')
      // 防御：无 id 配置（异常输入）跳过，避免合并出空 id / -2 后缀的垃圾条目。
      if (base.length === 0) continue
      let id = base
      for (let suffix = 2; seen.has(id); suffix++) id = `${base}-${suffix}`
      seen.add(id)
      promptConfigs.push({ ...entry, id, variables: { ...(spec.variablesEnabled === false ? {} : spec.variables), ...entry.variables as Record<string, string> | undefined } })
    }
  }
  const params: Record<string, unknown> = {}
  for (const spec of specs) Object.assign(params, spec.params ?? {})
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
    'tool-filter',
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
  const stripSuffix = (name: string): string => name.replace(/（SillyTavern 转换）$/, '')
  return {
    // 多源合并：id 拼接（2 + beta-2-42 → 2-beta-2-42），避免与任一源预设冲突。
    id: specs.length > 1 ? specs.map((spec) => spec.id).join('-') : specs[0]!.id,
    name: specs.map((spec) => stripSuffix(spec.name)).join(' × ') + '（SillyTavern 合并）',
    version: '1.0.0',
    engineCompat: '>=0.4.2',
    meta: { source: 'sillytavern', ...(warnings.length > 0 ? { stWarnings: warnings } : {}) },
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(Object.keys(variables).length > 0 ? { variables } : {}),
    ...(persona === undefined ? {} : { persona }),
    modules,
    moduleConfigs,
    promptConfigs,
  }
}

/** 转换选项：多 prompt_order 分组时显式选择来源角色，避免照搬「默认任取首组」。 */
export interface StConversionOptions {
  characterId?: string
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
  if (Array.isArray(record.prompt_order)) {
    const groups = record.prompt_order.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object' && Array.isArray(entry.order))
    const group = groups.find(entry => String(entry.character_id) === String(record.character_id ?? options.characterId ?? 100001))
      ?? (groups.length === 1 ? groups[0] : undefined)
    if (groups.length > 1 && group === undefined) throw new TypeError('SillyTavern prompt_order 包含多个角色，请提供 character_id 或导出全局预设')
    for (const entry of groups) {
      orderGroups.push({ characterId: String(entry.character_id ?? ''), selected: entry === group, entries: (entry.order as unknown[]).length })
    }
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
  const configs: Array<Record<string, unknown>> = []
  const droppedMarkers: string[] = []
  const diagnostics: StConversionDiagnostic[] = []
  const reportEntries: StConversionEntryReport[] = []
  let reportTruncated = false
  let sourceInputs = 0
  // 结构化诊断是唯一事实来源：旧 meta.stWarnings 由它派生，避免两套判断漂移。
  const note = (code: string, message: string, extra: { entryId?: string; field?: string } = {}): void => {
    if (diagnostics.some((item) => item.code === code && item.entryId === extra.entryId)) return
    if (diagnostics.length >= REPORT_DIAGNOSTIC_LIMIT) { reportTruncated = true; return }
    diagnostics.push({
      code, severity: 'warning', message,
      ...(extra.entryId !== undefined ? { entryId: extra.entryId } : {}),
      ...(extra.field !== undefined ? { field: extra.field } : {}),
    })
  }
  const recordEntry = (entry: StConversionEntryReport): void => {
    if (reportEntries.length >= REPORT_ENTRY_LIMIT) { reportTruncated = true; return }
    reportEntries.push(entry)
  }
  /** info 级诊断：进入报告但**不**改变既有 stWarnings 表现。 */
  const noteInfo = (code: string, message: string, extra: { entryId?: string; field?: string } = {}): void => {
    if (diagnostics.some((item) => item.code === code && item.entryId === extra.entryId)) return
    if (diagnostics.length >= REPORT_DIAGNOSTIC_LIMIT) { reportTruncated = true; return }
    diagnostics.push({
      code, severity: 'info', message,
      ...(extra.entryId !== undefined ? { entryId: extra.entryId } : {}),
      ...(extra.field !== undefined ? { field: extra.field } : {}),
    })
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
        configs.push({ id: `dialogue-example-${++index}`, name: `示例对话 ${index}`, strategy: 'static', text,
          layer: 'pre-step', role: part.role, position: 'before-all', dedupe: 'session', order: -60 + index / 1000 })
      }
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
        matchCharacterDescription: 'match_character_description', matchCharacterPersonality: 'match_character_personality',
        matchScenario: 'match_scenario', matchPersonaDescription: 'match_persona_description' })) {
        // ST 内嵌 extensions 的导出形状为蛇形（use_probability）；既有驼峰拼写仍是主名。
        const value = option(source, target, ...(target === 'useProbability' ? ['use_probability'] : []))
        if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') stWorldBook[target] = value
      }
      const sourceRole = stWorldBook.role
      const entryCodes: string[] = []
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
      }
      if (option('vectorized') === true || option('outlet_name') || (Array.isArray(option('triggers')) && (option('triggers') as unknown[]).length > 0) || option('automation_id')) {
        entryCodes.push('unsupported-controls')
        note('st-worldbook-controls', 'ST 世界书向量、outlet、生成类型或自动化控制需要宿主专门适配', { entryId: sourceId, field: 'extensions' })
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
      configs.push({ ...worldConfig, role: sourceRole === 2 ? 'assistant' : 'user',
        position: position === 4 ? 'after-all' : 'before-all',
        params: { ...worldConfig.params as Record<string, unknown>, stWorldBook } })
      recordEntry({ sourceId, sourceIndex: index, targetId: `lore-${sourceId}`,
        layer: 'pre-step', order: stOrder, role: sourceRole === 2 ? 'assistant' : 'user',
        position: position === 4 ? 'after-all' : 'before-all',
        classification: entryCodes.includes('unsupported-controls') ? 'unsupported'
          : entryCodes.some((code) => code !== 'disabled') ? 'degraded' : 'equivalent',
        codes: entryCodes })
    }
  }
  const firstMes = clean(bodyText('first_mes'))
  if (firstMes.length > 0) {
    sourceInputs += 1
    // 开场白：assistant 侧 + 每会话一次（dedupe=session 避免每轮重复注入）。
    configs.push({
      id: 'first-mes', name: '开场白', strategy: 'static', order: -40, text: firstMes,
      layer: 'pre-step', mergeMode: 'merged', role: 'assistant', position: 'before-all', dedupe: 'session',
    })
  }
  // 备用开场白（alternate_greetings）：首条已启用；备用条目转禁用配置（UI 可切换启用，
  // fallback 起点——引擎按 order 排序，同一 dedupe=session 身份不重复注入）。
  const alternateGreetings = Array.isArray(body.alternate_greetings)
    ? (body.alternate_greetings as unknown[]).map((item) => typeof item === 'string' ? item : '').map(clean).filter((item) => item.length > 0)
    : []
  for (const [index, greeting] of alternateGreetings.entries()) {
    sourceInputs += 1
    configs.push({
      id: `first-mes-${index + 2}`,
      name: `开场白 ${index + 2}`,
      strategy: 'static',
      enabled: false,
      order: -40 + index + 1,
      text: greeting,
      layer: 'pre-step',
      mergeMode: 'merged',
      role: 'assistant',
      position: 'before-all',
      dedupe: 'session',
    })
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
    // user/assistant 进 pre-step；'model'（第三方扩展角色，ST 官方枚举外）按
    // getPromptRole 的 default 语义归 system，但本项目映射 assistant（模型侧）
    // 更贴近其「模型思维链消息」用途。
    const role = prompt.role === 'assistant' || prompt.role === 'model'
      ? 'assistant'
      : prompt.role === 'system' ? 'system' : 'user'
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
      ...((prompt.injection_position === 1 || Array.isArray(prompt.injection_trigger)) ? { params: { stSource: {
        position: prompt.injection_position ?? 0, depth: prompt.injection_depth ?? 4,
        order: prompt.injection_order ?? 100, role,
        ...(Array.isArray(prompt.injection_trigger) ? { triggers: prompt.injection_trigger } : {}),
      } } } : {}),
    }
    const codes: string[] = []
    if (prompt.injection_position === 1) {
      codes.push('depth-collapsed')
      note('st-prompt-depth', 'ST prompt 深度注入暂按 DSH 插入点降级，原 position/depth/order/role 保留在 stSource', { entryId: sourceId, field: 'injection_position' })
    }
    if (Array.isArray(prompt.injection_trigger) && prompt.injection_trigger.length > 0) {
      codes.push('generation-trigger')
      note('st-prompt-triggers', 'ST prompt 的生成类型触发条件在 DSH 不等价，保留在 stSource.triggers', { entryId: sourceId, field: 'injection_trigger' })
    }
    if (base.enabled === false) codes.push(ordered && orderIndex.get(rawId) === undefined ? 'not-in-order-group' : 'disabled')
    if (role === 'system') {
      // 多个 system-section 可拼接：mergeMode=merged 时引擎按 order 升序拼为一条 system prompt。
      configs.push({ ...base, layer: 'system-section', mergeMode: 'merged' })
      systemSectionCount += 1
    } else {
      configs.push({
        ...base,
        layer: 'pre-step',
        mergeMode: 'merged',
        role,
        // ST injection_position：0=相对（聊天气泡上方，按 prompt_order 排列）；
        // 1=in-chat（注入对话内 depth 处）。本项目无深度注入，after-user 近似
        // in-chat 的「贴近消息区」语义；相对注入用 before-all（对话前消息批）。
        position: prompt.injection_position === 0 ? 'before-all' : 'after-user',
        dedupe: 'none',
      })
    }
    recordEntry({ sourceId, sourceIndex: index, targetId: id,
      layer: role === 'system' ? 'system-section' : 'pre-step', order: base.order,
      role: role === 'system' ? undefined : role,
      position: role === 'system' ? undefined : (prompt.injection_position === 0 ? 'before-all' : 'after-user'),
      classification: codes.includes('depth-collapsed') || codes.includes('generation-trigger') ? 'degraded' : 'equivalent',
      codes })
  }

  // modules 按需组装：prompt-config-engine 始终。
  const modules = ['prompt-config-engine', 'character-tools']
  if (configs.some((config) => config.strategy === 'world-book')) modules.push('world-book-tools')
  modules.push('session-var-tools', 'tool-config-engine', 'tool-filter')
  const moduleConfigs: Record<string, Record<string, unknown>> = {}
  // 含 system-section 段时用顶层 persona 段声明官方人设行：空 prefix 只做 scope
  // shadow（不注入标准编码 Agent 人设），complete: false 允许导入的 system-section
  // 生效（宿主部署人设 complete: true 会抑制它们）。
  const persona: PersonaSpec | undefined = systemSectionCount > 0 ? { prefix: '', complete: false } : undefined
  // tool-filter 始终装配，enable_web_search 按原 JSON 开关配置：
  //   true  → 同时组装 tool-web（fetch: true 启用）；
  //   false → 不组装 tool-web，写入黑名单（deny web_search/web_fetch），
  //           即使宿主/其他模块装配了 tool-web，本预设会话也不暴露 web 工具。
  if (record.enable_web_search === true) {
    modules.push('tool-web')
    moduleConfigs['tool-web'] = { fetch: true }
  } else if (record.enable_web_search === false) {
    moduleConfigs['tool-filter'] = { includeSubagents: false, deny: ['web_search', 'web_fetch'] }
  }

  const presetId = stPresetId(baseName)
  // 未定义自定义宏登记：卡内文本引用了但无变量源的 {{key}}（非内置 / 非运行时宏）
  // → 预设 variables 空值占位——插值替换为空不留字面；模板变量卡片可编辑默认值；
  // 会话变量工具（session_var）可运行时覆盖（对应 ST 正则/STscript 更新语义）。
  const RUNTIME_MACROS = new Set(['lastusermessage', 'lastcharmessage', 'charifnotgroup', 'time', 'date', 'weekday', 'isotime', 'isodate', 'random', 'pick', 'roll', 'chance', 'newline', 'pipe'])
  const BUILTIN_KEYS = new Set(['DSH_HOME', 'WORKSPACE', 'CWD'])
  const MACRO_RE = /\{\{([A-Za-z0-9_.\u4e00-\u9fff-]+)\}\}/g
  const knownKeys = new Set(Object.keys(variables).map((key) => key.toLowerCase()))
  for (const config of configs) {
    config.params = { ...config.params as Record<string, unknown> | undefined, stMacros: true }
    const configRecord = config as { params?: { text?: unknown } }
    const texts = [
      ...(typeof config.text === 'string' && config.text.length > 0 ? [config.text] : []),
      ...(Array.isArray(config.texts) ? config.texts : []),
      ...(typeof configRecord.params?.text === 'string' ? [configRecord.params.text] : []),
    ]
    for (const raw of texts) {
      const text = String(raw)
      MACRO_RE.lastIndex = 0
      for (const match of text.matchAll(MACRO_RE)) {
        const key = match[1]!
        const lower = key.toLowerCase()
        if (knownKeys.has(lower) || RUNTIME_MACROS.has(lower) || BUILTIN_KEYS.has(key)) continue
        knownKeys.add(lower)
        variables[key] = ''
      }
    }
  }
  // 结构化诊断 → 旧字符串表现（唯一事实来源；消息去重保持既有 stWarnings 语义）。
  const stWarnings = [...new Set(diagnostics.filter((item) => item.severity === 'warning').map((item) => item.message))]
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
      excluded: reportEntries.filter((entry) => entry.classification === 'excluded').length,
      unsupported: reportEntries.filter((entry) => entry.classification === 'unsupported').length,
      degraded: reportEntries.filter((entry) => entry.classification === 'degraded').length,
      needsReview: diagnostics.filter((item) => item.severity === 'warning').length,
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
    modules,
    moduleConfigs,
    promptConfigs: configs,
  }
  return { spec, report }
}

/** 多文件导入（角色卡 × 响应预设）合并各自报告：条目/诊断有界截断，计数求和。 */
export function mergeStConversionReports(reports: StConversionReport[]): StConversionReport {
  const entries = reports.flatMap((report) => report.entries).slice(0, REPORT_ENTRY_LIMIT)
  const diagnostics = reports.flatMap((report) => report.diagnostics).slice(0, REPORT_DIAGNOSTIC_LIMIT)
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
