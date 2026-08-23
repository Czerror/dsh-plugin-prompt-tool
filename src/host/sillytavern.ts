/**
 * SillyTavern 预设 → 本项目单文件预设转换引擎（纯函数，无文件 IO）。
 *
 * 按需转换原则：只按注入层级映射 SillyTavern 实际内容，不注入本项目默认内容。
 *   - prompts[] → promptConfigs：system_prompt+role=system → system-section（可拼接）；
 *     其余 → pre-step（role/position/dedupe 按 ST 语义）；
 *   - 角色卡正文（chara_card_v3：data 内层；旧版顶层直存）→ promptConfigs：
 *     description/personality/scenario 拼接为「角色设定」system-section，
 *     system_prompt / post_history_instructions → system-section，
 *     first_mes → pre-step 开场白（dedupe=session 每会话一次）；
 *   - 采样参数（temperature/openai_max_tokens/reasoning_effort）**不转译**：
 *     模型参数由「模型设置」UI 统一管理（预设级 params.model*，writePreset 渲染
 *     agent-request patch），ST 卡固化值会覆盖用户在模型设置里的设置，故剥离；
 *   - modules 按需组装：prompt-config-engine 始终，system-section 注入需要
 *     persona（complete: false 允许 system-section 生效）。
 */
import { createHash } from 'node:crypto'
import type { PresetSpec } from './manifest.ts'

/** ST 运行时指令（渲染时执行、不发送给模型）：setvar/getvar/ERA/trim/注释 → 剥离。 */
const ST_DIRECTIVE = /\{\{(setvar|getvar|ERA|trim|\/\/)[^}]*\}\}/gi

/**
 * 处理 SillyTavern 文本，ST 变量语义 → 本项目 params fallback 插值：
 *   {{setvar::k::v}}        → 收集 k=v 进 params（会话变量初始值 = fallback 基准），指令剥离；
 *   {{getvar::k}}           → 改写为 {{k}}（引擎按 params 插值，无值保留原样）；
 *   {{getvar::k::default}}  → 改写为 {{k}} 且 variables 缺 k 时写入 default（fallback 落顶层 variables）；
 *   {{trim}}/{{//注释}}/{{ERA:...}} → 剥离（格式化/注释/第三方运行时）；
 *   {{user}}/{{char}}       → 替换占位符。
 */
export function processStText(text: string, cardName: string, variables: Record<string, string>): string {
  // 顺序敏感：先收集 setvar（同文本后续 getvar 可读到），再改写 getvar，最后剥离残留指令——
  // 否则 ST_DIRECTIVE 会先把 setvar/getvar 整段剥掉，收集正则匹配不到。
  // setvar：{{setvar::k::v}} → 收集 k=v（会话变量初始值 = fallback 基准），指令剥离。
  let cleaned = text.replace(/\{\{setvar::([A-Za-z0-9_.\u4e00-\u9fff-]+)::([^}]*)\}\}/g, (_whole, key: string, value: string) => {
    variables[key] = value
    return ''
  })
  // getvar 带默认值（fallback）：{{getvar::k::default}} → {{k}} + params.k ??= default。
  cleaned = cleaned.replace(/\{\{getvar::([A-Za-z0-9_.\u4e00-\u9fff-]+)::([^}]*)\}\}/g, (_whole, key: string, fallback: string) => {
    // 仅检查自有属性（ST 变量名来自外部文本，避开 constructor/__proto__ 等原型链键）。
    if (!Object.prototype.hasOwnProperty.call(variables, key) && fallback.length > 0) variables[key] = fallback
    return `{{${key}}}`
  })
  // getvar 无默认：{{getvar::k}} → 有值 {{k}}（引擎按 variables 插值），无值空串（ST 语义）。
  cleaned = cleaned.replace(/\{\{getvar::([A-Za-z0-9_.\u4e00-\u9fff-]+)\}\}/g, (_whole, key: string) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? `{{${key}}}` : '')
  // 剥离残留运行时指令与注释（trim/ERA/注释；顺序在收集之后）。
  cleaned = cleaned.replace(ST_DIRECTIVE, '')
  cleaned = cleaned
    .replace(/\{\{char\}\}/gi, cardName.trim().length > 0 ? cardName.trim() : '角色')
    .replace(/\{\{user\}\}/gi, '用户')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return cleaned
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
      promptConfigs.push({ ...entry, id })
    }
  }
  const params: Record<string, unknown> = {}
  for (const spec of specs) Object.assign(params, spec.params ?? {})
  const modules: string[] = []
  for (const spec of specs) {
    for (const name of spec.modules ?? []) {
      if (!modules.includes(name)) modules.push(name)
    }
  }
  const moduleConfigs: Record<string, Record<string, unknown>> = {}
  for (const spec of specs) {
    for (const [key, value] of Object.entries(spec.moduleConfigs ?? {})) {
      moduleConfigs[key] = { ...moduleConfigs[key], ...value }
    }
  }
  const stripSuffix = (name: string): string => name.replace(/（SillyTavern 转换）$/, '')
  return {
    // 多源合并：id 拼接（2 + beta-2-42 → 2-beta-2-42），避免与任一源预设冲突。
    id: specs.length > 1 ? specs.map((spec) => spec.id).join('-') : specs[0]!.id,
    name: specs.map((spec) => stripSuffix(spec.name)).join(' × ') + '（SillyTavern 合并）',
    version: '1.0.0',
    engineCompat: '>=0.4.2',
    meta: { source: 'sillytavern' },
    ...(Object.keys(params).length > 0 ? { params } : {}),
    modules,
    moduleConfigs,
    promptConfigs,
  }
}

/** SillyTavern JSON 预设卡片 → 本项目 PresetSpec（导入端点直接消费）。 */
export function convertStToPreset(card: unknown, baseName: string): PresetSpec {
  const record = card !== null && typeof card === 'object' ? card as Record<string, unknown> : {}
  const prompts = Array.isArray(record.prompts)
    ? (record.prompts as Array<Record<string, unknown>>).filter((item) => item !== null && typeof item === 'object')
    : []
  // prompt_order（per-character 顺序 + 禁用标记）：ST 中 RELATIVE 注入的排列顺序
  // 完全由 prompt_order 数组顺序决定（injection_order 只对 in-chat 注入有效）；
  // 缺失/无效时回退 prompts 数组顺序。enabled=false 的条目即使 prompts 内未标也禁用。
  const orderIndex = new Map<string, number>()
  const orderDisabled = new Set<string>()
  if (Array.isArray(record.prompt_order)) {
    let rank = 0
    for (const entry of record.prompt_order as Array<Record<string, unknown>>) {
      if (entry === null || typeof entry !== 'object') continue
      const id = typeof entry.identifier === 'string' ? entry.identifier : ''
      if (id.length === 0) continue
      if (!orderIndex.has(id)) orderIndex.set(id, rank)
      if (entry.enabled === false) orderDisabled.add(id)
      rank += 1
    }
  }
  const configs: Array<Record<string, unknown>> = []
  let systemSectionCount = 0
  // 角色卡正文：chara_card_v3 实际内容在 data 内层（顶层为同步冗余），旧版顶层直存。
  const body = (record.data !== null && typeof record.data === 'object' ? record.data as Record<string, unknown> : record) as Record<string, unknown>
  // 扩展注入物剥离（TavernHelper 等 ST 扩展脚本/文档）：本引擎不执行 JS，
  // 原样注入只会污染模型上下文。显式剔除 extensions 下的脚本注入字段，
  // 防御未来转换逻辑读取 data 全字段时带入（当前只读正文/世界书，本步为显式边界）。
  const extensions = body.extensions !== null && typeof body.extensions === 'object'
    ? body.extensions as Record<string, unknown>
    : undefined
  if (extensions !== undefined) {
    for (const key of Object.keys(extensions)) {
      if (/helper|script|regex|tavern/i.test(key)) delete extensions[key]
    }
  }
  const bodyText = (key: string): string => typeof body[key] === 'string' ? (body[key] as string).trim() : ''
  const cardName = (typeof record.name === 'string' && record.name.trim().length > 0 ? record.name.trim()
    : typeof body.name === 'string' && body.name.trim().length > 0 ? (body.name as string).trim() : '')
  // ST 变量初始值（setvar/getvar fallback）进顶层 variables（{{key}} 插值源；
  // 与引擎行为参数 params 分离，写 preset.yml 顶层 variables 段）。
  const variables: Record<string, string> = {}
  const clean = (text: string): string => processStText(text, cardName, variables)
  // 角色卡正文 → 提示词配置：角色设定（描述/性格/场景）拼接、系统提示、后续指令、开场白。
  // order 取负值使角色卡内容排在响应预设 prompts（order≥100）之前。
  const characterDefinition = [bodyText('description'), bodyText('personality'), bodyText('scenario')]
    .filter((text) => text.length > 0).join('\n\n')
  const characterDefinitionClean = clean(characterDefinition)
  if (characterDefinitionClean.length > 0) {
    configs.push({ id: 'character-definition', name: '角色设定', strategy: 'static', order: -30, text: characterDefinitionClean, layer: 'system-section', mergeMode: 'merged' })
    systemSectionCount += 1
  }
  const systemPrompt = bodyText('system_prompt')
  const systemPromptClean = clean(systemPrompt)
  if (systemPromptClean.length > 0) {
    configs.push({ id: 'system-prompt', name: '系统提示', strategy: 'static', order: -20, text: systemPromptClean, layer: 'system-section', mergeMode: 'merged' })
    systemSectionCount += 1
  }
  const postHistory = bodyText('post_history_instructions')
  const postHistoryClean = clean(postHistory)
  if (postHistoryClean.length > 0) {
    configs.push({ id: 'post-history-instructions', name: '后续指令', strategy: 'static', order: -10, text: postHistoryClean, layer: 'system-section', mergeMode: 'merged' })
    systemSectionCount += 1
  }
  // 世界书（lorebook / character_book）→ world-book 策略配置（promptConfigs，
  // 与模块体系统一）：无 keys 条目恒注入（全局条目）、有 keys 条目命中触发
  // （keyword 语义由 resolver 的 constant/keys 判定）。
  // 形态兼容：entries 可能是数组（角色卡 CCv2/CCv3、spec v2）或对象
  // （ST 编辑器内部格式，键为字符串序数）。
  // 别名收敛：角色卡用 keys/secondary_keys/insertion_order/enabled/id，
  // ST 编辑器内部格式用 key/keysecondary/order/disable/uid——两套名字都真实
  // 存在，漏读会让关键词条目 keys 为空、退化为常驻注入（引擎对无 keys 条目恒注入）。
  const book = (body as Record<string, unknown>).character_book
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
      if (content.length === 0) continue
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
      configs.push({
        id: `lore-${String(entry.id ?? entry.uid ?? index)}`,
        name: comment,
        // ST 启用状态保留；无 keys 条目由 resolver 按全局（constant 语义）每次注入。
        enabled,
        strategy: 'world-book',
        order: typeof entry.insertion_order === 'number'
          ? entry.insertion_order
          : (typeof entry.order === 'number' ? entry.order : 100),
        text: content,
        layer: 'pre-step',
        position: 'before-all',
        params: {
          constant,
          ...(keys.length > 0 ? { keys } : {}),
          ...(secondaryKeys.length > 0 ? { secondaryKeys } : {}),
          ...((entry.case_sensitive ?? entry.caseSensitive) === true ? { caseSensitive: true } : {}),
          ...((entry.match_whole_words ?? entry.matchWholeWords) === true ? { wholeWords: true } : {}),
          ...((entry.use_regex ?? entry.useRegex) === true ? { useRegex: true } : {}),
          // selectiveLogic（ST world_info_logic 0/1/2/3）：选择性触发组合逻辑，
          // 由 anchor-match 引擎消费（any/all/not）。保留不再丢弃。
          ...(typeof entry.selectiveLogic === 'number'
            ? { selectiveLogic: entry.selectiveLogic }
            : (typeof entry.selective_logic === 'number' ? { selectiveLogic: entry.selective_logic } : {})),
        },
      })
    }
  }
  const firstMes = clean(bodyText('first_mes'))
  if (firstMes.length > 0) {
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
    const content = clean(typeof prompt.content === 'string' ? prompt.content : '')
    if (content.length === 0) continue
    const rawId = typeof prompt.identifier === 'string' ? prompt.identifier : ''
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
      enabled: orderDisabled.has(rawId) ? false : prompt.enabled !== false,
      strategy: 'static',
      // RELATIVE 注入顺序 = prompt_order 数组顺序（ST 忽略 injection_order）；
      // 无映射时按数组索引，保持 ST 预设内相对顺序。
      order: ((rawId.length > 0 ? orderIndex.get(rawId) : undefined) ?? index) * 10,
      text: content,
    }
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
  }

  // modules 按需组装：prompt-config-engine 始终；system-section 注入需要 persona 服务。
  const modules = ['prompt-config-engine']
  const moduleConfigs: Record<string, Record<string, unknown>> = {}
  if (systemSectionCount > 0) {
    modules.unshift('persona')
    // 只覆盖转换必需的键：complete: false 允许 system-section 生效；
    // text/includeRuntimeContext 不声明（用引擎模块库默认，不注入 anchored 内容）。
    moduleConfigs.persona = { complete: false }
  }
  // enable_web_search → 按原 JSON 开关装配：
  //   true  → 组装 tool-web（fetch: true 启用）；
  //   false → 不组装 tool-web，改加 tool-filter 黑名单（deny web_search/web_fetch），
  //           即使宿主/其他模块装配了 tool-web，本预设会话也不暴露 web 工具。
  if (record.enable_web_search === true) {
    modules.push('tool-web')
    moduleConfigs['tool-web'] = { fetch: true }
  } else if (record.enable_web_search === false) {
    modules.push('tool-filter')
    moduleConfigs['tool-filter'] = { includeSubagents: false, deny: ['web_search', 'web_fetch'] }
  }

  const presetId = stPresetId(baseName)
  // 未定义自定义宏登记：卡内文本引用了但无变量源的 {{key}}（非内置 / 非运行时宏）
  // → 预设 variables 空值占位——插值替换为空不留字面；模板变量卡片可编辑默认值；
  // 会话变量工具（session_var）可运行时覆盖（对应 ST 正则/STscript 更新语义）。
  const RUNTIME_MACROS = new Set(['lastusermessage', 'lastcharmessage', 'charifnotgroup'])
  const BUILTIN_KEYS = new Set(['DSH_HOME', 'WORKSPACE', 'CWD'])
  const MACRO_RE = /\{\{([A-Za-z0-9_.\u4e00-\u9fff-]+)\}\}/g
  const knownKeys = new Set(Object.keys(variables).map((key) => key.toLowerCase()))
  for (const config of configs) {
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
  // 预设名优先取卡片 name 字段；缺失/空白时回退文件名（去 .json 的 baseName）。
  return {
    id: presetId,
    name: `${cardName || baseName}（SillyTavern 转换）`,
    version: '1.0.0',
    engineCompat: '>=0.4.2',
    // 来源标记：角色管理页据此列出「从 SillyTavern 导入的预设」。
    meta: { source: 'sillytavern' },
    ...(Object.keys(variables).length > 0 ? { variables } : {}),
    modules,
    moduleConfigs,
    promptConfigs: configs,
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
