/**
 * layers — 非 pre-step 的官方层级接线。
 * 所有注册都只作用于本插件提示词配置;单条失败 warnOnce 后继续。
 */

import {
  MAX_TRACKED_SESSIONS,
  getService,
  isDelegated,
  keepDisposer,
  matchesAudience,
  matchesModel,
  newMessageId,
  sessionState,
} from './shared.mjs'
import { pluginKind } from './source-kind.mjs'
import { INJECTION_LAYERS, KNOWN_STRATEGIES, SESSION_VARIABLES_DISABLED } from './schema.mjs'
import { interpolateVariables, stripUnresolvedRefs, RUNTIME_FACTS, runtimeFactValue, isReservedInterpolationName } from './interpolate.mjs'
import { renderTemplate } from './template-frame.mjs'
import { compareConfigSequence, compareTextPlacement } from './order.mjs'
import { ruleFrame, actionMatches } from './conditions/evaluation.mjs'
import { textRegistrationName, identityStampOf, actionStamp, injectedMessage, findActionDelivery } from './delivery.mjs'

const name = 'prompt-config-engine'
// 同一宿主会话共享投递账本，避免预设作用域重挂后重投同一次结束通知。
// B4 保留原状（不迁 `sessionState`）：外层确实是「按会话索引」的 WeakMap，但它存的不是
// 会话条目而是**第二层索引**——内层 `Map` 按 `${runId}:${config.id}` 去重，那是运行级的键，
// 与统一接口的「按会话索引」不同层；套上去只剩一个改了名字的 WeakMap。内层的
// `delete(最旧)` 也是与 `clear()` 不同的另一档淘汰策略（见下方 `runs` 的保留理由）。
const subagentEndDeliveries = new WeakMap()

/** 单条文本型配置的完整文本:texts 数组按空行拼接（单一文本字段）。
 *  keep=官方变量通道按 assembly 求值的名字，静态 pass 命中即原样保留引用。 */
function configText(config, registries, warnOnce, context) {
  const registry = registries.get(config)
  if (config.params?.templateEvaluation === true) {
    try { return officialChannelText(renderTemplate(config, context, { enabled: config[SESSION_VARIABLES_DISABLED] !== true, warn: warnOnce }), `${config.layer} ${config.id}`, registry, warnOnce) }
    catch (error) { warnOnce(`${name}: template ${config.id} failed: ${String(error?.message ?? error)}`); return '' }
  }
  const variables = config[SESSION_VARIABLES_DISABLED] === true ? {} : config.texts.some(text => text.includes('{{'))
    ? config.variableStore?.read(config.sourceModuleId).effective ?? config.variables : config.variables
  const text = config.texts
    .map((item, index) => interpolateVariables(item, variables, context?.agent?.session, registry?.protect, `${config.id}#${index}`))
    .filter((item) => item.length > 0)
    .join('\n\n')
  return officialChannelText(text, `${config.layer} ${config.id}`, registry, warnOnce)
}

/** 官方 prompt 变量名规则（与官方 system-prompt 的 VARIABLE_NAME 一致）。 */
const OFFICIAL_NAME_RE = /^[a-z][a-z0-9_]*$/
/** 引用形态（仅名字，无 `::` 参数）：事实与内容变量引用都用这一形态。 */
const NAME_REFERENCE_RE = /\{\{\s*([A-Za-z0-9_.\u4e00-\u9fff-]+)\s*\}\}/g

/** 名字哈希（djb2 → base36）：非法官方名改写的确定性后缀。 */
function shortHash(text) {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0
  return hash.toString(36)
}

/** 非法官方名的确定性改写：sv_<ascii slug>_<hash>；slug 为空（纯中文名）时只用 hash。 */
function officialAliasOf(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return `sv_${slug.length > 0 ? `${slug}_` : ''}${shortHash(name)}`
}

/**
 * 注册官方 prompt 变量（systemPrompt.variable，按 assembly 求值）：
 *   - 运行时事实（ST 运行时宏 + 时间类）：值随每次 assembly 现算，不再在注册期冻结为空；
 *   - 官方通道文本里被引用、且已声明的内容变量：值 = 会话变量覆盖 ?? 声明值。
 * 非法官方名（中文/大写/连字符）改写成确定性别名并改写文本引用；注册失败的名字退回静态解析。
 * @returns 各配置独立的引用白名单与别名；同一作用域内等价绑定只注册一次。
 */
function registerOfficialVariables(ctx, configs, warnOnce, keep) {
  const registries = new Map(configs.map((config) => [config, { protect: new Set(), alias: new Map(), registered: new Set() }]))
  const systemPrompt = getService(ctx, 'systemPrompt')
  if (systemPrompt === undefined || typeof systemPrompt.variable !== 'function') return registries
  const references = new Map()
  const reserved = new Set()
  const facts = new Set()
  for (const config of configs) {
    // 持久值在各正文 provider 被调用时读取，使后卡看到前卡刚提交的变量。
    if (config.params?.templateEvaluation === true || config.variableStore !== undefined) continue
    const referenced = new Set()
    for (const text of config.texts) {
      for (const match of String(text).matchAll(NAME_REFERENCE_RE)) referenced.add(match[1])
    }
    references.set(config, referenced)
    for (const name of referenced) {
      if (!Object.hasOwn(config.variables, name) && RUNTIME_FACTS.has(name.toLowerCase())) facts.add(name.toLowerCase())
      if (OFFICIAL_NAME_RE.test(name)) reserved.add(name)
    }
  }
  for (const fact of facts) reserved.add(fact)
  const bindings = new Map()
  const usedNames = new Set()
  for (const [config, referenced] of references) {
    const registry = registries.get(config)
    for (const name of referenced) {
      const declared = Object.hasOwn(config.variables, name) || config.variableStore !== undefined && !isReservedInterpolationName(name)
      const isFact = !declared && RUNTIME_FACTS.has(name.toLowerCase())
      if (!declared && !isFact) continue
      let official = isFact ? name.toLowerCase() : OFFICIAL_NAME_RE.test(name) ? name : officialAliasOf(name)
      try {
        // 内容绑定包含局部命名空间：会话覆盖也可以再引用其中的变量。
        // 纯事实不属于任何配置的内容命名空间，所有大小写变体复用规范名。
        const signature = isFact ? `fact:${official}` : JSON.stringify([config.sourceModuleId, name, config.variableStore === undefined ? Object.entries(config.variables).sort(([a], [b]) => a.localeCompare(b)) : null])
        let binding = bindings.get(signature)
        if (binding === undefined) {
          if (usedNames.has(official) || (!isFact && facts.has(official)) || (official !== name && !isFact && reserved.has(official))) {
            const base = officialAliasOf(`${name}:${signature}`)
            official = base
            for (let suffix = 1; usedNames.has(official) || reserved.has(official); suffix++) official = `${base}_${suffix}`
          }
          usedNames.add(official)
          const source = isFact ? name.toLowerCase() : name
          const variablesDisabled = config[SESSION_VARIABLES_DISABLED] === true
          keep(systemPrompt.variable(official, (context) => {
            const session = context?.agent?.session
            const variables = variablesDisabled ? {} : config.variableStore?.read(config.sourceModuleId).effective ?? config.variables
            const value = Object.hasOwn(variables, source) ? String(variables[source]) : runtimeFactValue(source, session) ?? ''
            // 变量值内的 {{pick}} 同样要有位置身份（配置 id + 声明名），否则同会话下多个变量的首个 pick 撞值。
            const expanded = interpolateVariables(value, variables, session, undefined, `variable:${config.sourceModuleId}:${config.id}:${name}`)
            return officialChannelText(expanded, `variable ${official}`, { alias: new Map(), registered: new Set() }, warnOnce)
          }), `${name}: official prompt variable ${official}`)
          binding = official
          bindings.set(signature, binding)
        }
        registry.registered.add(binding)
        registry.protect.add(name)
        if (binding !== name) registry.alias.set(name, binding)
      } catch (error) {
        warnOnce(`${name}: 官方 prompt 变量 ${official} 注册失败，该引用退回静态解析：${String(error?.message ?? error)}`)
      }
    }
  }
  return registries
}

/** 非法名的引用改写：`{{中文名}}` → `{{sv_中文_<hash>}}`（仅已注册成功的别名）。 */
function rewriteOfficialAliases(text, alias) {
  if (alias.size === 0) return text
  return text.replace(NAME_REFERENCE_RE, (whole, name) => alias.has(name) ? `{{${alias.get(name)}}}` : whole)
}

/** agent/request 与 tools/* 层的作用域过滤。 */
export function matchesAgentScope(config, agent) {
  if (agent === undefined) return true
  if (!matchesAudience(config.audience, isDelegated(agent.session) ? 'subagent' : 'main')) return false
  return matchesModel(config.modelScope, agent.options?.model)
}

/**
 * 官方插值通道（system-section / runtime-context）出口清洗：本项目解析后仍残留的
 * 引用一律剥离，官方严格插值因此看不到未注册引用（既不抛错也不留字面）。
 * 只在本项目的宽容解析之后调用；其他层（pre-step / agent-request）
 * 不经官方插值，保持原有宽容语义。
 */
function officialChannelText(text, label, registry, warnOnce) {
  const result = stripUnresolvedRefs(rewriteOfficialAliases(text, registry.alias), registry.registered)
  if (result.stripped.length > 0) {
    const samples = [...new Set(result.stripped)].slice(0, 3).join(' ')
    warnOnce(`${name}: ${label} 剥离了 ${result.stripped.length} 处无法解析的引用（${samples}）——请在模板变量里登记，或改用本项目宏语法 {{roll::1d6}}`)
  }
  return result.text
}

/** 只合并排序后同来源、同官方档位和位置的连续 merged 卡，不跨过穿插段。 */
function textLayerGroups(configs) {
  const sorted = [...configs].sort(compareTextPlacement)
  const groups = []
  for (const config of sorted) {
    const previous = groups.at(-1)
    const base = previous?.[0]
    if (config.mergeMode === 'merged' && base?.mergeMode === 'merged'
      && config.sourceModuleId === base.sourceModuleId
      && (config.params?.complete === true) === (base.params?.complete === true)
      && (config.params?.suppressRuntimeContext === true) === (base.params?.suppressRuntimeContext === true)
      && config.position === base.position && config.order === base.order) previous.push(config)
    else groups.push([config])
  }
  return groups
}

/** system-section:注册静态 system prompt 段(支持官方 {{variable}} 渲染与 merged 拼接)。 */
function wireSystemSections(ctx, configs, registry, warnOnce, keep, ordered, sourceError) {
  const systemPrompt = getService(ctx, 'systemPrompt')
  if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') {
    if (configs.length > 0) warnOnce(`${name}: systemPrompt service unavailable — system-section configs skipped`)
    return
  }
  // 人设段（deployment:persona-prefix/suffix）由官方 @deepseek-ai/dsh-persona 行注册
  // （preset.yml 顶层 persona 段驱动）；本层只处理其余 system-section 配置。
  for (const group of textLayerGroups(configs)) {
    const base = group[0]
    try {
      const dynamic = group.some((config) => config.audience != null || config.params?.templateEvaluation === true || config.variableStore !== undefined
        || config.texts.some(text => /\{\{\s*(?:random|pick|roll|chance)(?=\s|:|\})/i.test(text)))
      const groupText = dynamic ? '' : group.map((config) => configText(config, registry, warnOnce)).filter((item) => item.length > 0).join('\n\n')
      if (!dynamic && groupText.length === 0) continue
      const text = dynamic
        ? (context) => group
              .filter((config) => matchesAgentScope(config, context?.agent))
              .map((config) => configText(config, registry, warnOnce, context))
              .filter((item) => item.length > 0)
              .join('\n\n')
        : groupText
      const entryName = textRegistrationName(base, 'sectionName')
      keep(systemPrompt.section({
        name: entryName,
        order: base.order,
        text,
        ...(base.params?.complete === true ? { complete: true } : {}),
      }), `${name}: section ${base.id}`)
      ordered.sections.push(orderedEntry(entryName, base))
      // suppressRuntimeContext 抑制该 scope 的动态 runtime-context 快照（多段重复调用幂等）。
      if (base.params?.suppressRuntimeContext === true) {
        keep(systemPrompt.suppressRuntimeContext(), `${name}: suppressRuntimeContext ${base.id}`)
      }
    } catch (error) {
      if (sourceError !== undefined) throw sourceError(error, base.sourceModuleId)
      warnOnce(`${name}: system-section config ${base.id} failed: ${String(error?.message ?? error)}`)
    }
  }
}

async function resolvedContextText(ctx, config, context, registry, warnOnce) {
  const agent = context.agent
  const session = agent?.session
  const resolved = await config.resolve({ ctx, agent, session, signal: context.signal, decision: { kind: 'ok', messages: [] }, messages: [] })
  if (context.signal?.aborted || resolved == null) return ''
  const variables = { ...(config[SESSION_VARIABLES_DISABLED] === true ? {} : config.variableStore?.read(config.sourceModuleId).effective ?? config.variables), ...(resolved.variables !== null && typeof resolved.variables === 'object' ? resolved.variables : {}) }
  if (config.params?.templateEvaluation === true) {
    const texts = config.texts.length ? config.texts : [resolved.text ?? '']
    return officialChannelText(renderTemplate({ ...config, texts }, context, { enabled: config[SESSION_VARIABLES_DISABLED] !== true, warn: warnOnce }), `runtime-context ${config.id}`, registry, warnOnce)
  }
  // 模板位置身份 = 配置 id（texts 合并与 resolved.text 是同一位置的两个互斥分支）；缺省会退化成 [会话, 出现序号]。
  const rendered = config.texts.length > 0 ? interpolateVariables(config.texts.join('\n\n'), variables, session, undefined, config.id)
    : typeof resolved.text === 'string' ? interpolateVariables(resolved.text, variables, session, undefined, config.id) : ''
  return officialChannelText(rendered, `runtime-context ${config.id}`, registry, warnOnce)
}

/** 条件化文本保留官方排序占位；仅在本次真实 assembly 填充，不缓存 context 身份。 */
function wireRuleTextContributions(ctx, configs, registry, warnOnce, keep, on, ordered, sourceError) {
  if (!configs.length) return []
  const systemPrompt = getService(ctx, 'systemPrompt')
  if (systemPrompt === undefined) { warnOnce(`${name}: systemPrompt unavailable`); return [] }
  const variable = `pt_rule_${newMessageId('text').replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`
  const marker = `{{${variable}}}`
  keep(systemPrompt.variable(variable, () => ''), `${name}: conditional text marker`)
  const bindings = []
  for (const layer of ['system-section', 'runtime-context']) for (const group of textLayerGroups(configs.filter(config => config.layer === layer))) {
    const section = layer === 'system-section'
    const base = group[0]
    const entryName = textRegistrationName(base, section ? 'sectionName' : 'contextName')
    try {
      keep(systemPrompt[section ? 'section' : 'context']({ name: entryName, order: base.order, text: marker }), `${name}: conditional ${entryName}`)
    } catch (error) { throw sourceError === undefined ? error : sourceError(error, base.sourceModuleId) }
    bindings.push({ group, name: entryName, collection: section ? 'sections' : 'contexts' })
    ordered[section ? 'sections' : 'contexts'].push(orderedEntry(entryName, base))
  }
  let active = true
  keep(() => { active = false }, `${name}: conditional text lifecycle`)
  return [on('system-prompt/assemble', async (assembly, context, next, invocation) => {
    const frame = invocation ?? ruleFrame('system-prompt/assemble', [assembly, context], warnOnce)
    for (const binding of bindings) {
      const entry = assembly[binding.collection].find(item => item.name === binding.name && item.text === marker)
      if (entry === undefined) continue
      entry.text = ''
      const blocks = []
      for (const config of binding.group) {
        if (!active || context.signal?.aborted || !actionMatches(config, frame) || !matchesAgentScope(config, context.agent)) continue
        try {
          const text = config.layer === 'runtime-context' && (config.strategy === 'placeholder' || !KNOWN_STRATEGIES.has(config.strategy))
            ? await resolvedContextText(ctx, config, context, registry.get(config), warnOnce)
            : configText(config, registry, warnOnce, context)
          if (text.length) blocks.push(text)
        } catch (error) { warnOnce(`${name}: rule text ${config.id} failed: ${String(error?.message ?? error)}`) }
      }
      if (active && !context.signal?.aborted) entry.text = blocks.join('\n\n')
    }
    return next()
  })]

}

/** runtime-context:注册运行时上下文；静态文本支持 merged，动态策略在官方 assembly waterfall 中填充。 */
function wireRuntimeContexts(ctx, configs, registry, warnOnce, keep, on, ordered, sourceError) {
  const disposers = []
  const systemPrompt = getService(ctx, 'systemPrompt')
  if (systemPrompt === undefined || typeof systemPrompt.context !== 'function') {
    if (configs.length > 0) warnOnce(`${name}: systemPrompt service unavailable — runtime-context configs skipped`)
    return disposers
  }
  // 模板专属策略（strategyDir 懒加载）与 placeholder 一样由 waterfall 按 assembly 消费
  // resolve——`config.resolve` 只在这两层被调用，按静态注册会让「配了没效果也不报错」。
  const needsResolver = (config) => config.strategy === 'placeholder' || !KNOWN_STRATEGIES.has(config.strategy)
  const staticConfigs = configs.filter((config) => !needsResolver(config))
  for (const group of textLayerGroups(staticConfigs)) {
    const base = group[0]
    try {
      const dynamic = group.some(config => config.params?.templateEvaluation === true || config.variableStore !== undefined
        || config.texts.some(text => /\{\{\s*(?:random|pick|roll|chance)(?=\s|:|\})/i.test(text)))
      const render = context => group.map(config => configText(config, registry, warnOnce, context)).filter(item => item.length > 0).join('\n\n')
      const text = dynamic ? render : render()
      if (!dynamic && text.length === 0) continue
      const entryName = textRegistrationName(base, 'contextName')
      keep(systemPrompt.context({
        name: entryName,
        order: base.order,
        text,
      }), `${name}: context ${base.id}`)
      ordered.contexts.push(orderedEntry(entryName, base))
    } catch (error) {
      if (sourceError !== undefined) throw sourceError(error, base.sourceModuleId)
      if (base.linkedDelivery) throw error
      warnOnce(`${name}: runtime-context config ${base.id} failed: ${String(error?.message ?? error)}`)
    }
  }
  // 官方 provider 必须同步：先注册可渲染为空的私有变量占位，再在 waterfall 中填充。
  // 标记随官方排序/遮蔽进入本次 assembly，无会话缓存，也不依赖调用方 context 的对象身份。
  const placeholders = configs.filter(needsResolver)
    .sort(compareTextPlacement)
  if (placeholders.length === 0) return disposers
  const slotVariable = `pt_runtime_${newMessageId('context').replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`
  const slotText = `{{${slotVariable}}}`
  const registered = new Map()
  let active = true
  keep(() => { active = false }, `${name}: runtime-context lifecycle`)
  keep(systemPrompt.variable(slotVariable, () => ''), `${name}: runtime-context placeholder`)
  for (const config of placeholders) {
    try {
      const contextName = textRegistrationName(config, 'contextName')
      keep(systemPrompt.context({
        name: contextName,
        order: config.order,
        text: slotText,
      }), `${name}: context ${config.id}`)
      registered.set(contextName, config)
      ordered.contexts.push(orderedEntry(contextName, config))
    } catch (error) {
      if (sourceError !== undefined) throw sourceError(error, config.sourceModuleId)
      warnOnce(`${name}: runtime-context placeholder ${config.id} failed: ${String(error?.message ?? error)}`)
    }
  }
  disposers.push(on('system-prompt/assemble', async (assembly, context, next) => {
    const entries = assembly.contexts.filter(entry => registered.has(entry.name) && entry.text === slotText)
    for (const entry of entries) {
      const config = registered.get(entry.name)
      entry.text = ''
      if (!active || context.signal?.aborted) continue
      try {
        const text = await resolvedContextText(ctx, config, context, registry.get(config), warnOnce)
        if (active && !context.signal?.aborted) entry.text = text
      } catch (error) {
        warnOnce(`${name}: runtime-context ${config.id} resolve failed: ${String(error?.message ?? error)}`)
      }
    }
    if (!active || context.signal?.aborted) for (const entry of entries) entry.text = ''
    return next()
  }))
  return disposers
}

/**
 * 插件来源的 user 消息：与 anchor-turn / progress-reminder 同一形状。
 *
 * `kind` 必须是**生产者名**而不是裸 `plugin`：会话格式 v4 把 `{ kind: 'plugin', plugin }`
 * 列为退役包装并直接拒绝（`dsh-session-format-v3-to-v4` 的 `assertV4MessageSources` /
 * `assertV4SourceRowAdmission` 一律抛 `format v4 message requires a producer-owned source kind`），
 * 迁移只在读旧日志时把 `plugin` 折进 kind。写 `kind: 'plugin'` 会让本次 splice 被 codec
 * 拒绝、连 `agent/inbox/spliced` 都落不了盘——子代理启动因此整段失败。
 */
export function pluginMessage(prefix, text, summary) {
  return {
    id: newMessageId(prefix),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: pluginKind(name), plugin: name, form: 'notice', summary },
  }
}

/** 层级文本：按声明变量插值后按空行拼接；不走官方插值通道（非 system-section）。 */
function layerText(config, agent, warnOnce) {
  try {
    if (config.params?.templateEvaluation === true) return renderTemplate(config, { agent }, { enabled: config[SESSION_VARIABLES_DISABLED] !== true, warn: warnOnce })
    const variables = config[SESSION_VARIABLES_DISABLED] === true ? {} : config.variableStore?.read(config.sourceModuleId).effective ?? config.variables
    return config.texts
      .map((item, index) => interpolateVariables(item, variables, agent?.session, undefined, `${config.sourceModuleId}:${config.id}#${index}`))
      .filter((item) => item.length > 0)
      .join('\n\n')
  } catch (error) {
    warnOnce(`${name}: ${config.layer} ${config.id} text failed: ${String(error?.message ?? error)}`)
    return ''
  }
}

/**
 * 轮次停止层（`turn-stop` 与续跑动作）的续跑上限：**每个来源（模块）**每轮 1 次、
 * 每会话 3 次，均为引擎常量。不暴露为配置——强制续跑失控会把会话卡在停不下来的
 * 循环里；官方桥在同一位置也只留了 TODO(stop-loop-guard) 而未实现上限。
 */
export const TURN_STOP_MAX_PER_TURN = 1
export const TURN_STOP_MAX_PER_SESSION = 3

/** 会话内保留的轮次计数上限（与 deliberation-gate 同规模）。 */
export const TURN_STOP_MAX_TRACKED_TURNS = 8

/**
 * 续跑预算（唯一实现）：所有 turn-stop 注入共用它，
 * 上限是引擎常量而不是配置——强制续跑失控会把会话卡在停不下来的循环里。
 * **一份预算覆盖一个来源模块**（规则运行时按模块传入同一份），因此同模块的多条
 * turn-stop 动作合计每轮 1 次、每会话 3 次。
 * 三步语义刻意与迁移前逐行一致：
 *   entry(...)    取条目（含创建与超限轮次淘汰的副作用），在条件判定**之前**调用；
 *   available(...) 只读判定，不落账；
 *   claim(...)    落账，必须在 steer **之前**调用（steer 抛错也不允许重试越过预算）。
 */
export function createTurnStopBudget() {
  /**
   * 会话预算条目（`sessionState`：统一访问接口，策略逐条声明）。
   *
   * 键类型 `session.id`；淘汰策略超限 `clear()` 全清（与迁移前的会话态记账同档：
   * 第 `MAX_TRACKED_SESSIONS` 个会话仍会清空整个容器）；**不声明复位**——预算是纯增量、
   * 不可从事件流重建的计数（与 `progress-reminder` 同档），丢失时机必须与迁移前逐字一致，
   * compaction 也不重置它。
   *
   * 本函数没有 ctx，只有 turn-stop 注入消费预算。
   * `sessionState` 只在声明了 `reset` 时才读 ctx，因此这里传
   * `undefined` 合法且零开销（详见 shared.mjs 的 JSDoc 与 test/engine/session-state.test.mjs）。
   */
  const state = sessionState(undefined, () => ({ turns: new Map(), total: 0 }))

  const stateOf = (sessionId, turn) => {
    // 对外仍是 `(sessionId, turn)`：按 id 造一次性键宿主，`keyOf` 取的就是 `.id`，与旧的
    // 记账写法写进同一个槽位、同一个 clear 时机。
    // 唯一差异在**无 id 的会话**（`sessionId === undefined`）：`sessionState` 刻意不记账
    // （见 shared.mjs），下方 turn-stop 层在 `entry()` 前守卫 `session?.id === undefined`，
    // 故该路径不可达；这里兜底一个新条目，避免将来误用时抛 TypeError。
    const entry = state.get({ id: sessionId }) ?? { turns: new Map(), total: 0 }
    if (!Number.isFinite(turn)) return entry
    if (!entry.turns.has(turn) && entry.turns.size >= TURN_STOP_MAX_TRACKED_TURNS) {
      const oldest = [...entry.turns.keys()].sort((a, b) => a - b)
      for (const key of oldest.slice(0, entry.turns.size - TURN_STOP_MAX_TRACKED_TURNS + 1)) entry.turns.delete(key)
    }
    if (!entry.turns.has(turn)) entry.turns.set(turn, 0)
    return entry
  }

  return {
    entry: (sessionId, turn) => stateOf(sessionId, turn),
    available: (entry, turn) => {
      const turnCount = Number.isFinite(turn) ? (entry.turns.get(turn) ?? 0) : 0
      return turnCount < TURN_STOP_MAX_PER_TURN && entry.total < TURN_STOP_MAX_PER_SESSION
    },
    claim: (entry, turn) => {
      if (Number.isFinite(turn)) entry.turns.set(turn, (entry.turns.get(turn) ?? 0) + 1)
      entry.total += 1
    },
  }
}

/**
 * turn-stop：命中条件时阻止本轮停止并强制续跑一步，上限在引擎内。
 * options.turnStopBudgets 由调用方传入时按同一份预算记账（规则运行时按模块一份），
 * 缺省仍按 sourceModuleId 各建一份。
 */
function wireTurnStops(ctx, configs, warnOnce, on, turnStopBudgets) {
  const disposers = []
  if (configs.length === 0) return disposers
  const budgets = turnStopBudgets ?? new Map()

  for (const config of configs) {
    const source = config.sourceModuleId ?? ''
    if (!budgets.has(source)) budgets.set(source, createTurnStopBudget())
    const budget = budgets.get(source)
    disposers.push(on('agent/turn-stopping', (payload = {}, _next, invocation) => {
      const { agent, turn } = payload
      try {
        if (payload.signal?.aborted) return
        if (!actionMatches(config, invocation ?? ruleFrame('agent/turn-stopping', [payload], warnOnce))) return
        const session = agent?.session
        if (session?.id === undefined || typeof agent.steer !== 'function') return
        if (!matchesAgentScope(config, agent)) return
        if (config.dedupe === 'session' && (config.linkedDelivery ? findActionDelivery(session, config) : injectedMessage(config, session))) return
        const entry = budget.entry(session.id, turn)
        if (!budget.available(entry, turn)) return
        const text = layerText(config, agent, warnOnce)
        if (text.length === 0) return
        // 计数在 steer 之前落账：steer 抛错也不允许下一步重试越过预算。
        budget.claim(entry, turn)
        const message = pluginMessage(`turn-stop-${config.id}`, text, `turn-stop ${config.id}`)
        agent.steer({ ...message, source: { ...message.source, ...identityStampOf(config), ...actionStamp(config, session) } })
      } catch (error) {
        warnOnce(`${name}: turn-stop config ${config.id} failed: ${String(error?.message ?? error)}`)
      }
    }))
  }
  return disposers
}

/** 沿官方持久 session 血缘找根会话，不根据当前 UI 会话或预设名称猜测。 */
function mainSessionForChild(ctx, id) {
  const agents = getService(ctx, 'agents')
  const sessions = getService(ctx, 'sessions')
  const visited = new Set()
  let session = agents?.get?.(id)?.session ?? sessions?.get?.(id)
  if (session?.header?.parentSession === undefined) return undefined
  while (session !== undefined) {
    const sessionId = session.id ?? session.header?.id
    if (typeof sessionId !== 'string' || visited.has(sessionId)) return undefined
    visited.add(sessionId)
    const parentId = session.header?.parentSession
    if (parentId === undefined) return isDelegated(session) ? undefined : sessionId
    session = agents?.get?.(parentId)?.session ?? sessions?.get?.(parentId)
  }
}

/** 子代理生命周期：启动注入子代理；结束默认观察，可显式给所属主会话投递上下文。 */
function wireSubagentEvents(ctx, configs, warnOnce, on) {
  const disposers = []
  const startConfigs = configs.filter((config) => config.layer === 'subagent-start')
  const endConfigs = configs.filter((config) => config.layer === 'subagent-end')
  // B4 保留原状（不迁 `sessionState`）：键是 `runId`（运行标识）而不是 session，不属于
  // 「按会话索引」的会话态，套统一接口会把语义挪到错误的键上；它的 `delete(最旧)` 也是与
  // `clear()` 不同的另一档淘汰策略，无等价证明前保留。
  const runs = new Map()
  if (endConfigs.length > 0) {
    disposers.push(ctx.on('subagent/start', (info) => {
      if (typeof info?.runId !== 'string' || typeof info?.id !== 'string') return
      const child = getService(ctx, 'agents')?.get?.(info.id)
      const session = child?.session ?? getService(ctx, 'sessions')?.get?.(info.id)
      if (session === undefined) return
      const mainId = mainSessionForChild(ctx, info.id)
      // shortcut: 有界运行记录；极端并发超过上限时，结束事件仍可通过存活会话血缘定位。
      if (runs.size >= MAX_TRACKED_SESSIONS) runs.delete(runs.keys().next().value)
      runs.set(info.runId, { id: info.id, mainId, agent: child, session, model: child?.options?.model })
    }))
    const clearRuns = () => runs.clear()
    disposers.push(clearRuns)
    ctx.effect?.(() => clearRuns)
  }
  if (startConfigs.length > 0) {
    disposers.push(on('subagent/start', (info, _next, invocation) => {
      try {
        const child = getService(ctx, 'agents')?.get?.(info?.id)
        if (child === undefined) return
        const frame = invocation ?? ruleFrame('subagent/start', [info], warnOnce)
        frame.subject.agent = child
        for (const config of startConfigs) {
          if (!actionMatches(config, frame)) continue
          if (!matchesAgentScope(config, child)) continue
          if (typeof child.inject !== 'function') continue
          const text = layerText(config, child, warnOnce)
          if (text.length === 0) continue
          child.inject(pluginMessage(`subagent-start-${config.id}`, text, `subagent-start ${config.id}`))
        }
      } catch (error) {
        warnOnce(`${name}: subagent-start failed: ${String(error?.message ?? error)}`)
      }
    }))
  }
  if (endConfigs.length > 0) {
    disposers.push(on('subagent/end', (info, _next, invocation) => {
      try {
        const child = getService(ctx, 'agents')?.get?.(info?.id)
        const recorded = runs.get(info?.runId)
        runs.delete(info?.runId)
        if (recorded !== undefined && recorded.id !== info?.id) return
        const frame = invocation ?? ruleFrame('subagent/end', [info], warnOnce)
        frame.subject.agent = child ?? recorded?.agent
        frame.subject.session = child?.session ?? recorded?.session ?? getService(ctx, 'sessions')?.get?.(info?.id)
        frame.subject.model = child?.options?.model ?? recorded?.model
        for (const config of endConfigs) {
          if (!actionMatches(config, frame)) continue
          if (!matchesModel(config.modelScope, child?.options?.model ?? recorded?.model)) continue
          if (config.params?.action !== 'inject-main') {
            // 模板本意是逐次记录；命中本身已由装配实例的判定账本记 hit，这里不占告警名额。
            ctx.logger?.info?.(`${name}: subagent-end ${config.id} matched (observe only)`)
            continue
          }
          if (typeof info?.runId !== 'string' || info.runId.length === 0) continue
          const mainId = recorded?.mainId ?? mainSessionForChild(ctx, info?.id)
          const main = mainId === undefined ? undefined : getService(ctx, 'agents')?.get?.(mainId)
          if (main?.session === undefined || typeof main.inject !== 'function') {
            warnOnce(`${name}: subagent-end ${config.id} has no live main session`)
            continue
          }
          const text = layerText(config, main, warnOnce)
          if (text.length === 0) continue
          let delivered = subagentEndDeliveries.get(main.session)
          if (delivered === undefined) { delivered = new Map(); subagentEndDeliveries.set(main.session, delivered) }
          const key = `${info.runId}:${config.id}`
          if (delivered.has(key)) continue
          // shortcut: 会话内保留最近的投递记录；超大历史改用持久事件索引时可取消此上限。
          if (delivered.size >= MAX_TRACKED_SESSIONS) delivered.delete(delivered.keys().next().value)
          delivered.set(key, true)
          main.inject(pluginMessage(`subagent-end-${config.id}`, text, `subagent-end ${config.id}`))
        }
      } catch (error) {
        warnOnce(`${name}: subagent-end failed: ${String(error?.message ?? error)}`)
      }
    }))
  }
  return disposers
}

/** 注册名与序号：字段只在注册点算一次，重排器只消费这里的结果。 */
function orderedEntry(name, config) {
  return { name, sequence: config.sequence ?? config.order ?? 0, order: config.order ?? 0 }
}

/**
 * 实际注册名按 configOrder（sequence）排序；同序号保持注册序，同名只留一次。
 * 名字来自注册点而不是事后从 configs 推导，避免 regular/conditional/placeholder 三条路径漂移。
 */
function orderedNamesOf(entries) {
  // configOrder 优先；同序号回到官方 order（而不是接线顺序），最后 stable 保留注册顺序。
  return [...new Set([...entries]
    .sort((left, right) => left.sequence - right.sequence || (left.order ?? 0) - (right.order ?? 0))
    .map((entry) => entry.name))]
}

/**
 * 官方先按 order/段名排好投递顺序；这里按 configOrder 把本插件注册的段/上下文
 * 回填到它们原来的槽位。只换本插件段之间的位置：平台段与其他插件段占住的槽位不动。
 */
function registerDeliveryOrder(ctx, keep, collection, names) {
  if (names.length < 2) return
  const rank = new Map(names.map((entryName, index) => [entryName, index]))
  keep(ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next()
    const list = result?.[collection]
    if (!Array.isArray(list)) return result
    const slots = []
    for (let index = 0; index < list.length; index++) {
      if (rank.has(list[index]?.name)) slots.push(index)
    }
    if (slots.length < 2) return result
    const ordered = slots.map((index) => list[index]).sort((left, right) => rank.get(left.name) - rank.get(right.name))
    if (slots.every((slot, index) => list[slot] === ordered[index])) return result
    const nextList = [...list]
    slots.forEach((slot, index) => { nextList[slot] = ordered[index] })
    return { ...result, [collection]: nextList }
  }, { prepend: true }), `${name}: ${collection} order`)
}

/**
 * 把非 pre-step 提示词配置接入其声明的官方层级通道。
 * @param options.agent 当前 ctx 所属的真实 Agent；固定效果的受众在注册前匹配。
 * @param options.turnStopBudgets 可选的续跑预算映射（键 = 模块 id，来源缺失用空串兜底）；
 *   规则运行时按模块传入同一份，使同模块的 turn-stop 动作共享上限。
 * @returns 聚合 disposer：回收监听器及段/上下文/变量注册；后者也绑定 ctx fiber，重复释放幂等。
 */
export function wireLayers(ctx, configs, warnOnce, options = {}) {
  // 固定效果必须在目标 Agent 注册前筛选；空正文不能撤销官方 complete/suppress 声明。
  configs = configs.filter(config => {
    if (config.layer !== 'system-section' || config.audience == null
      || config.params?.complete !== true && config.params?.suppressRuntimeContext !== true) return true
    if (options.agent?.session === undefined) throw new TypeError(`${name}: fixed system-section ${config.id} with audience requires an explicit Agent in options.agent`)
    return matchesAudience(config.audience, isDelegated(options.agent.session) ? 'subagent' : 'main')
  })
  configs = [...configs].sort(compareConfigSequence)
  // 没有注入通道的层（`tool-pipeline`）在这里没有分派：显式告警一次，别让 config 级入口静默丢弃。
  for (const config of configs) {
    if (!INJECTION_LAYERS.includes(config.layer)) warnOnce(`${name}: ${config.id}: layer ${String(config.layer)} 没有注入通道，已跳过（工具链的裁决请用 decision / append-context）`)
  }
  const owned = []
  const keep = (dispose, label) => {
    if (typeof dispose !== 'function') return
    let active = true
    const release = () => { if (active) { active = false; dispose() } }
    owned.push(release); keepDisposer(ctx, release, label)
    return release
  }
  const on = (...args) => keep((options.on ?? ((...values) => ctx.on(...values)))(...args), `${name}: ${args[0]}`)
  const dispose = () => {
    for (const release of owned.splice(0).reverse()) { try { release() } catch {} }
  }
  try {
    // 注册即纳入 owned，后续注册失败也能释放已取得的变量和监听器。
    /** 实际注册名与序号：重排器只认这里，不从 configs 反推。 */
    const ordered = { sections: [], contexts: [] }
    const registry = registerOfficialVariables(ctx, configs.filter((config) => config.layer === 'system-section' || config.layer === 'runtime-context'), warnOnce, keep)
    const conditional = configs.filter(config => ['system-section', 'runtime-context'].includes(config.layer)
      && (typeof config.rule?.when === 'function' || typeof config.actionWhen === 'function'
        || (config.rule !== undefined || config.params?.templateEvaluation === true) && config.params?.complete !== true && config.params?.suppressRuntimeContext !== true))
    const regular = configs.filter(config => !conditional.includes(config))
    wireSystemSections(ctx, regular.filter((config) => config.layer === 'system-section'), registry, warnOnce, keep, ordered, options.sourceError)
    wireRuntimeContexts(ctx, regular.filter((config) => config.layer === 'runtime-context'), registry, warnOnce, keep, on, ordered, options.sourceError)
    wireRuleTextContributions(ctx, conditional, registry, warnOnce, keep, on, ordered, options.sourceError)
    wireTurnStops(ctx, configs.filter((config) => config.layer === 'turn-stop'), warnOnce, on, options.turnStopBudgets)
    wireSubagentEvents(ctx, configs.filter((config) => config.layer === 'subagent-start' || config.layer === 'subagent-end'), warnOnce, on)
    // 官方 order 只提供初始槽位；configOrder 覆盖段/上下文的先后（平台段与其他插件段不动）。
    for (const collection of ['sections', 'contexts']) {
      registerDeliveryOrder(ctx, keep, collection, orderedNamesOf(ordered[collection]))
    }
    return dispose
  } catch (error) {
    dispose()
    throw error
  }
}
