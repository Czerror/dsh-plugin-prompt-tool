/**
 * layers — 非 pre-step 的五个官方层级接线。
 * 所有注册都只作用于本插件提示词配置;单条失败 warnOnce 后继续。
 */

import {
  MAX_TRACKED_SESSIONS,
  extractText,
  getService,
  isDelegated,
  keepDisposer,
  matchesModel,
  newMessageId,
  parseToolNames,
  sessionMapGet,
} from './shared.mjs'
import { KNOWN_STRATEGIES } from './schema.mjs'
import { interpolateVariables, stripUnresolvedRefs, RUNTIME_FACTS, runtimeFactValue } from './interpolate.mjs'
import { getSessionVar, sessionVarsSnapshot } from './session-vars.mjs'
import { conditionHit, lastAssistantText, subagentTextOf, toolArgsText } from './condition.mjs'

const name = 'prompt-config-engine'
// 同一宿主会话共享投递账本，避免预设作用域重挂后重投同一次结束通知。
const subagentEndDeliveries = new WeakMap()

/** 单条文本型配置的完整文本:texts 数组按空行拼接（单一文本字段）。
 *  keep=官方变量通道按 assembly 求值的名字，静态 pass 命中即原样保留引用。 */
function configText(config, registries, warnOnce, context) {
  const registry = registries.get(config)
  if (typeof config.renderSt === 'function') {
    return officialChannelText(config.renderSt(context?.agent, [], warnOnce, context), `${config.layer} ${config.id}`, registry, warnOnce)
  }
  const text = config.texts
    .map((item) => interpolateVariables(item, config.variables, context?.agent?.session, registry?.protect))
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
function registerOfficialVariables(ctx, configs, warnOnce) {
  const registries = new Map(configs.map((config) => [config, { protect: new Set(), alias: new Map(), registered: new Set() }]))
  const systemPrompt = getService(ctx, 'systemPrompt')
  if (systemPrompt === undefined || typeof systemPrompt.variable !== 'function') return registries
  const references = new Map()
  const reserved = new Set()
  const facts = new Set()
  for (const config of configs) {
    if (config.params?.stMacros === true) continue
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
      const declared = Object.hasOwn(config.variables, name)
      const isFact = !declared && RUNTIME_FACTS.has(name.toLowerCase())
      if (!declared && !isFact) continue
      let official = isFact ? name.toLowerCase() : OFFICIAL_NAME_RE.test(name) ? name : officialAliasOf(name)
      try {
        // 内容绑定包含局部命名空间：会话覆盖也可以再引用其中的变量。
        // 纯事实不属于任何配置的内容命名空间，所有大小写变体复用规范名。
        const signature = isFact ? `fact:${official}` : JSON.stringify([name, Object.entries(config.variables).sort(([a], [b]) => a.localeCompare(b))])
        let binding = bindings.get(signature)
        if (binding === undefined) {
          if (usedNames.has(official) || (!isFact && facts.has(official)) || (official !== name && !isFact && reserved.has(official))) {
            const base = officialAliasOf(`${name}:${signature}`)
            official = base
            for (let suffix = 1; usedNames.has(official) || reserved.has(official); suffix++) official = `${base}_${suffix}`
          }
          usedNames.add(official)
          const source = isFact ? name.toLowerCase() : name
          const declaredValue = declared ? String(config.variables[name] ?? '') : undefined
          keepDisposer(ctx, systemPrompt.variable(official, (context) => {
            const session = context?.agent?.session
            const override = getSessionVar(session, source)
            const value = override !== undefined ? String(override) : declaredValue ?? runtimeFactValue(source, session) ?? ''
            const expanded = interpolateVariables(value, { ...config.variables, ...sessionVarsSnapshot(session) }, session)
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
  const delegated = isDelegated(agent.session)
  if (config.audience === 'main' && delegated) return false
  if (config.audience === 'subagent' && !delegated) return false
  return matchesModel(config.modelScope, agent.options?.model)
}

/**
 * 官方插值通道（system-section / runtime-context）出口清洗：本项目解析后仍残留的
 * 引用一律剥离，官方严格插值因此看不到未注册引用（既不抛错也不留字面）。
 * 只在本项目的宽容解析之后调用；其他层（pre-step / agent-request / tool-pipeline）
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

/** 文本型层分组:merged 模式按位置分组,否则每条独立。 */
function textLayerGroups(configs) {
  const sorted = [...configs].sort((a, b) => a.order - b.order)
  const groups = []
  const index = new Map()
  for (const config of sorted) {
    const key = config.mergeMode === 'merged' ? `merged:${config.position ?? ''}` : undefined
    if (key === undefined) {
      groups.push([config])
      continue
    }
    let at = index.get(key)
    if (at === undefined) {
      at = groups.length
      index.set(key, at)
      groups.push([])
    }
    groups[at].push(config)
  }
  return groups
}

/** system-section:注册静态 system prompt 段(支持官方 {{variable}} 渲染与 merged 拼接)。 */
function wireSystemSections(ctx, configs, registry, warnOnce) {
  const disposers = []
  const systemPrompt = getService(ctx, 'systemPrompt')
  if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') {
    if (configs.length > 0) warnOnce(`${name}: systemPrompt service unavailable — system-section configs skipped`)
    return disposers
  }
  // 人设段（deployment:persona-prefix/suffix）由官方 @deepseek-ai/dsh-persona 行注册
  // （preset.yml 顶层 persona 段驱动）；本层只处理其余 system-section 配置。
  for (const group of textLayerGroups(configs)) {
    const base = group[0]
    try {
      const dynamic = group.some((config) => config.audience != null || typeof config.renderSt === 'function'
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
      keepDisposer(ctx, systemPrompt.section({
        name: typeof base.params?.sectionName === 'string' && base.params.sectionName.length > 0 ? base.params.sectionName : base.id,
        order: base.order,
        text,
        ...(base.params?.complete === true ? { complete: true } : {}),
      }), `${name}: section ${base.id}`)
      // suppressRuntimeContext 抑制该 scope 的动态 runtime-context 快照（多段重复调用幂等）。
      if (base.params?.suppressRuntimeContext === true) {
        keepDisposer(ctx, systemPrompt.suppressRuntimeContext(), `${name}: suppressRuntimeContext ${base.id}`)
      }
    } catch (error) {
      warnOnce(`${name}: system-section config ${base.id} failed: ${String(error?.message ?? error)}`)
    }
  }
  return disposers
}

/** runtime-context:注册运行时上下文；静态文本支持 merged，动态策略在官方 assembly waterfall 中填充。 */
function wireRuntimeContexts(ctx, configs, registry, warnOnce) {
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
      const dynamic = group.some(config => typeof config.renderSt === 'function'
        || config.texts.some(text => /\{\{\s*(?:random|pick|roll|chance)(?=\s|:|\})/i.test(text)))
      const render = context => group.map(config => configText(config, registry, warnOnce, context)).filter(item => item.length > 0).join('\n\n')
      const text = dynamic ? render : render()
      if (!dynamic && text.length === 0) continue
      keepDisposer(ctx, systemPrompt.context({
        name: typeof base.params?.contextName === 'string' && base.params.contextName.length > 0 ? base.params.contextName : base.id,
        order: base.order,
        text,
      }), `${name}: context ${base.id}`)
    } catch (error) {
      warnOnce(`${name}: runtime-context config ${base.id} failed: ${String(error?.message ?? error)}`)
    }
  }
  // 官方 provider 必须同步：先注册可渲染为空的私有变量占位，再在 waterfall 中填充。
  // 标记随官方排序/遮蔽进入本次 assembly，无会话缓存，也不依赖调用方 context 的对象身份。
  const placeholders = configs.filter(needsResolver)
    .sort((a, b) => a.order - b.order)
  if (placeholders.length === 0) return disposers
  const slotVariable = `pt_runtime_${newMessageId('context').replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`
  const slotText = `{{${slotVariable}}}`
  const registered = new Map()
  let active = true
  keepDisposer(ctx, () => { active = false }, `${name}: runtime-context lifecycle`)
  keepDisposer(ctx, systemPrompt.variable(slotVariable, () => ''), `${name}: runtime-context placeholder`)
  for (const config of placeholders) {
    try {
      const contextName = typeof config.params?.contextName === 'string' && config.params.contextName.length > 0 ? config.params.contextName : config.id
      keepDisposer(ctx, systemPrompt.context({
        name: contextName,
        order: config.order,
        text: slotText,
      }), `${name}: context ${config.id}`)
      registered.set(contextName, config)
    } catch (error) {
      warnOnce(`${name}: runtime-context placeholder ${config.id} failed: ${String(error?.message ?? error)}`)
    }
  }
  disposers.push(ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const entries = assembly.contexts.filter(entry => registered.has(entry.name) && entry.text === slotText)
    for (const entry of entries) {
      const config = registered.get(entry.name)
      entry.text = ''
      if (!active || context.signal?.aborted) continue
      try {
        const agent = context.agent
        const session = agent?.session
        const resolved = await config.resolve({ ctx, agent, session, signal: context.signal, decision: { kind: 'ok', messages: [] }, messages: [] })
        if (!active || context.signal?.aborted || resolved === null || resolved === undefined) continue
        const variables = { ...config.variables, ...(resolved.variables !== null && typeof resolved.variables === 'object' ? resolved.variables : {}) }
        const rendered = config.texts.length > 0
          ? interpolateVariables(config.texts.join('\n\n'), variables, session)
          : typeof resolved.text === 'string' ? interpolateVariables(resolved.text, variables, session) : ''
        entry.text = officialChannelText(rendered, `runtime-context ${config.id}`, registry.get(config), warnOnce)
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
 * agent/request 载荷的唯一改写实现（B3 T2 第 (7) 类动作与既有 `agent-request`
 * 层**共用这一份**，不另写一套请求改写）。三种语义：
 *   - `patch`：对下游已解析的 LlmCallConfig 做浅合并；
 *   - `replace: true`：整体替换为 `patch`（不叠加 base，故 `unset` 无比较对象）；
 *   - `unset`：**按值条件删键** —— 仅当合并结果里的值**恰好等于**声明值时删除该键
 *     （`Object.is` 比较）。这是 `tool-bootstrap` 剥离 `bootstrapMaxTokens` 的语义
 *     （`tool-bootstrap.mjs:464-472`：「仅当解析后的 maxTokens 恰好等于本声明注入
 *     的那个值时才删」），不是"存在即删"——模型或其它插件设置的同名参数不会被删。
 *     浅合并做不到删键，故删键必须走显式通道。
 * @param params 提示词配置的 `params`（或动作的等价声明）。
 * @param base 下游 `next()` 已解析的请求配置。
 * @returns 改写后的请求配置；无 unset 命中时零额外分配。
 */
export function applyAgentRequestParams(params, base) {
  const patch = params?.patch !== null && typeof params?.patch === 'object' && !Array.isArray(params.patch)
    ? params.patch
    : {}
  if (params?.replace === true) return { ...patch }
  const merged = { ...base, ...patch }
  const unset = params?.unset
  if (unset === null || typeof unset !== 'object' || Array.isArray(unset)) return merged
  let result
  for (const [key, expected] of Object.entries(unset)) {
    // 每个键都对着**合并结果**判定：一旦分配过副本，后续键不得跳过比较。
    if (!Object.is(merged[key], expected)) continue
    if (result === undefined) result = { ...merged }
    delete result[key]
  }
  return result ?? merged
}

/** agent-request:对冻结的 LlmCallConfig 做浅合并 / 整体替换 / 按值条件删键。 */
function wireAgentRequests(ctx, configs, warnOnce) {
  const disposers = []
  for (const config of configs) {
    disposers.push(ctx.on('agent/request', async (payload, next) => {
      const base = await next()
      try {
        if (!matchesAgentScope(config, payload?.agent)) return base
        return applyAgentRequestParams(config.params, base)
      } catch (error) {
        warnOnce(`${name}: agent-request config ${config.id} failed: ${String(error?.message ?? error)}`)
        return base
      }
    }))
  }
  return disposers
}

/** 把流替换为提示词配置文本的最小合法 chunk 序列。 */
async function* replacedStream(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
}

/** llm-stream:pass 透传;replace 用提示词配置文本替代整个模型流。 */
function wireLlmStreams(ctx, configs, warnOnce) {
  const disposers = []
  for (const config of configs) {
    disposers.push(ctx.on('llm/stream', (options, next) => {
      try {
        const mode = config.params?.mode ?? 'pass'
        if (mode === 'replace' && config.texts.length > 0 && matchesModel(config.modelScope, options?.model)) {
          return replacedStream(config.texts.join('\n\n'))
        }
        return next()
      } catch (error) {
        warnOnce(`${name}: llm-stream config ${config.id} failed: ${String(error?.message ?? error)}`)
        return next()
      }
    }))
  }
  return disposers
}

/** 条件判定的匹配器与取文本逻辑由 condition.mjs 承载（pre-step 与其他层共用）。 */

/** 插件来源的 user 消息：与 anchor-turn / progress-reminder 同一形状。 */
export function pluginMessage(prefix, text, summary) {
  return {
    id: newMessageId(prefix),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name, form: 'notice', summary },
  }
}

/** 层级文本：按声明变量插值后按空行拼接；不走官方插值通道（非 system-section）。 */
function layerText(config, agent, warnOnce) {
  try {
    return config.texts
      .map((item) => interpolateVariables(item, config.variables, agent?.session))
      .filter((item) => item.length > 0)
      .join('\n\n')
  } catch (error) {
    warnOnce(`${name}: ${config.layer} ${config.id} text failed: ${String(error?.message ?? error)}`)
    return ''
  }
}

/** tool-pipeline:pre-execute 判定、execute 包装、post-execute 结果替换/阻断。 */
function wireToolPipelines(ctx, configs, warnOnce) {
  const disposers = []
  for (const config of configs) {
    const names = parseToolNames(config.params?.toolNames)
    const matchesTool = (exec) => names.length === 0 || names.includes(exec?.name)
    disposers.push(ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        if (!matchesTool(exec) || !matchesAgentScope(config, exec?.agent)) return next()
        if (!conditionHit(config, { argsText: toolArgsText(exec?.arguments) })) return next()
        const decision = config.params?.preDecision ?? 'allow'
        if (decision === 'allow') return next()
        if (decision === 'deny') {
          return { kind: 'deny', reason: String(config.params?.denyReason ?? `${config.name}: denied by prompt config`) }
        }
        if (decision === 'ask') return { kind: 'ask' }
        return next()
      } catch (error) {
        warnOnce(`${name}: tool-pipeline(pre) config ${config.id} failed: ${String(error?.message ?? error)}`)
        return next()
      }
    }))
    disposers.push(ctx.on('tools/post-execute', async (exec, result, next) => {
      try {
        if (!matchesTool(exec) || !matchesAgentScope(config, exec?.agent)) return next()
        if (!conditionHit(config, { argsText: toolArgsText(exec?.arguments), resultText: extractText(result) })) return next()
        const action = config.params?.postAction ?? 'accept'
        if (action === 'accept') return next()
        if (action === 'replace' && config.texts.length > 0) {
          return { kind: 'accept', content: [{ type: 'text', text: config.texts.join('\n\n') }] }
        }
        if (action === 'block') {
          return { kind: 'block', feedback: [{ type: 'text', text: config.texts.length > 0 ? config.texts.join('\n\n') : `${config.name}: blocked by prompt config` }] }
        }
        return next()
      } catch (error) {
        warnOnce(`${name}: tool-pipeline(post) config ${config.id} failed: ${String(error?.message ?? error)}`)
        return next()
      }
    }))
  }
  return disposers
}

/**
 * 轮次停止层的续跑上限：每轮 1 次、每会话 3 次，均为引擎常量。
 * 不暴露为配置——强制续跑失控会把会话卡在停不下来的循环里；官方桥在同一位置
 * 也只留了 TODO(stop-loop-guard) 而未实现上限。
 */
export const TURN_STOP_MAX_PER_TURN = 1
export const TURN_STOP_MAX_PER_SESSION = 3

/** 会话内保留的轮次计数上限（与 deliberation-gate 同规模）。 */
export const TURN_STOP_MAX_TRACKED_TURNS = 8

/**
 * 续跑预算（唯一实现）：B3 T2 第 (4) 类动作的「续跑」与既有 turn-stop 层共用它，
 * 上限是引擎常量而不是配置——强制续跑失控会把会话卡在停不下来的循环里。
 * 三步语义刻意与迁移前逐行一致：
 *   entry(...)    取条目（含创建与超限轮次淘汰的副作用），在条件判定**之前**调用；
 *   available(...) 只读判定，不落账；
 *   claim(...)    落账，必须在 steer **之前**调用（steer 抛错也不允许重试越过预算）。
 */
export function createTurnStopBudget() {
  /** sessionId -> { turns: Map<turn, count>, total } */
  const state = new Map()

  const stateOf = (sessionId, turn) => {
    const entry = sessionMapGet(state, sessionId, () => ({ turns: new Map(), total: 0 }))
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

/** turn-stop：命中条件时阻止本轮停止并强制续跑一步，上限在引擎内。 */
function wireTurnStops(ctx, configs, warnOnce) {
  const disposers = []
  if (configs.length === 0) return disposers
  const budget = createTurnStopBudget()

  for (const config of configs) {
    disposers.push(ctx.on('agent/turn-stopping', ({ agent, turn } = {}) => {
      try {
        const session = agent?.session
        if (session?.id === undefined || typeof agent.steer !== 'function') return
        if (!matchesAgentScope(config, agent)) return
        const entry = budget.entry(session.id, turn)
        if (!budget.available(entry, turn)) return
        if (!conditionHit(config, { assistantText: lastAssistantText(session) })) return
        const text = layerText(config, agent, warnOnce)
        if (text.length === 0) return
        // 计数在 steer 之前落账：steer 抛错也不允许下一步重试越过预算。
        budget.claim(entry, turn)
        agent.steer(pluginMessage(`turn-stop-${config.id}`, text, `turn-stop ${config.id}`))
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
function wireSubagentEvents(ctx, configs, warnOnce) {
  const disposers = []
  const startConfigs = configs.filter((config) => config.layer === 'subagent-start')
  const endConfigs = configs.filter((config) => config.layer === 'subagent-end')
  const injectMain = endConfigs.some((config) => config.params?.action === 'inject-main')
  const runs = new Map()
  if (injectMain) {
    disposers.push(ctx.on('subagent/start', (info) => {
      if (typeof info?.runId !== 'string' || typeof info?.id !== 'string') return
      const mainId = mainSessionForChild(ctx, info.id)
      if (mainId === undefined) return
      // ponytail: 有界运行记录；极端并发超过上限时，结束事件仍可通过存活会话血缘定位。
      if (runs.size >= MAX_TRACKED_SESSIONS) runs.delete(runs.keys().next().value)
      runs.set(info.runId, { id: info.id, mainId, model: getService(ctx, 'agents')?.get?.(info.id)?.options?.model })
    }))
    ctx.effect?.(() => () => runs.clear())
  }
  if (startConfigs.length > 0) {
    disposers.push(ctx.on('subagent/start', (info) => {
      try {
        const child = getService(ctx, 'agents')?.get?.(info?.id)
        if (child === undefined) return
        const subagentText = subagentTextOf(info)
        for (const config of startConfigs) {
          if (!matchesAgentScope(config, child)) continue
          if (!conditionHit(config, { subagentText })) continue
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
    disposers.push(ctx.on('subagent/end', (info) => {
      try {
        const child = getService(ctx, 'agents')?.get?.(info?.id)
        const recorded = runs.get(info?.runId)
        runs.delete(info?.runId)
        if (recorded !== undefined && recorded.id !== info?.id) return
        const subagentText = subagentTextOf(info)
        for (const config of endConfigs) {
          if (!matchesModel(config.modelScope, child?.options?.model ?? recorded?.model)) continue
          if (!conditionHit(config, { subagentText })) continue
          if (config.params?.action !== 'inject-main') {
            warnOnce(`${name}: subagent-end ${config.id} matched (observe only)`)
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
          // ponytail: 会话内保留最近的投递记录；超大历史改用持久事件索引时可取消此上限。
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

/**
 * 把非 pre-step 提示词配置接入其声明的官方层级通道。
 * @returns 聚合 disposer：回收本次接线显式创建的 waterfall 监听器；段/上下文/
 *   变量注册走 keepDisposer（随 ctx fiber 释放），不在本函数的回收面内。
 */
export function wireLayers(ctx, configs, warnOnce) {
  // 官方插值两层共享一份变量注册：运行时事实按 assembly 求值，非法名走别名改写。
  const registry = registerOfficialVariables(ctx, configs.filter((config) => config.layer === 'system-section' || config.layer === 'runtime-context'), warnOnce)
  const registered = [
    wireSystemSections(ctx, configs.filter((config) => config.layer === 'system-section'), registry, warnOnce),
    wireRuntimeContexts(ctx, configs.filter((config) => config.layer === 'runtime-context'), registry, warnOnce),
    wireAgentRequests(ctx, configs.filter((config) => config.layer === 'agent-request'), warnOnce),
    wireLlmStreams(ctx, configs.filter((config) => config.layer === 'llm-stream'), warnOnce),
    wireToolPipelines(ctx, configs.filter((config) => config.layer === 'tool-pipeline'), warnOnce),
    wireTurnStops(ctx, configs.filter((config) => config.layer === 'turn-stop'), warnOnce),
    wireSubagentEvents(ctx, configs.filter((config) => config.layer === 'subagent-start' || config.layer === 'subagent-end'), warnOnce),
  ].flat().filter((disposer) => typeof disposer === 'function')
  return () => {
    for (const dispose of registered.splice(0)) {
      try {
        dispose()
      } catch {
        // 释放失败不得反过来打断卸载流程。
      }
    }
  }
}
