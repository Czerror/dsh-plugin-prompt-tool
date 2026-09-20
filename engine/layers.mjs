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
} from './shared.mjs'
import { KNOWN_STRATEGIES } from './schema.mjs'
import { interpolateVariables, stripUnresolvedRefs, RUNTIME_FACTS, runtimeFactValue } from './interpolate.mjs'
import { getSessionVar, sessionVarsSnapshot } from './session-vars.mjs'
import { conditionHit, lastAssistantText, subagentTextOf, toolArgsText } from './condition.mjs'

const name = 'prompt-config-engine'

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
function matchesAgentScope(config, agent) {
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
}

/** runtime-context:注册动态运行时上下文(晋升后由 context-gate 差分投影;支持 merged 拼接与 placeholder 函数 provider)。 */
function wireRuntimeContexts(ctx, configs, registry, warnOnce) {
  const systemPrompt = getService(ctx, 'systemPrompt')
  if (systemPrompt === undefined || typeof systemPrompt.context !== 'function') {
    if (configs.length > 0) warnOnce(`${name}: systemPrompt service unavailable — runtime-context configs skipped`)
    return
  }
  // 模板专属策略（strategyDir 懒加载）与 placeholder 一样由 provider 按 assembly 消费
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
  // placeholder / 模板专属策略:官方 context 接受函数 provider,在每次 assembly 时动态填充。
  const placeholders = configs.filter(needsResolver)
    .sort((a, b) => a.order - b.order)
  for (const config of placeholders) {
    try {
      const resolver = config.resolve
      keepDisposer(ctx, systemPrompt.context({
        name: typeof config.params?.contextName === 'string' && config.params.contextName.length > 0 ? config.params.contextName : config.id,
        order: config.order,
        text: async (assembly) => {
          try {
            const agent = assembly?.agent
            const session = agent?.session
            const resolved = await resolver({ ctx, agent, session, decision: { kind: 'ok', messages: [] }, messages: [] })
            if (resolved === null || resolved === undefined) return ''
            const variables = { ...config.variables, ...(resolved.variables !== null && typeof resolved.variables === 'object' ? resolved.variables : {}) }
            // runtime-context 是官方插值通道且 0.1.6 没有 interpolate:false：出口同样清洗。
            const rendered = config.texts.length > 0
              ? interpolateVariables(config.texts.join('\n\n'), variables, session)
              : typeof resolved.text === 'string' ? interpolateVariables(resolved.text, variables, session) : ''
            return officialChannelText(rendered, `runtime-context ${config.id}`, registry.get(config), warnOnce)
          } catch (error) {
            // 单条失败不炸整次 assembly：模板策略模块由用户提供，缺文件/抛错都在这里收敛。
            warnOnce(`${name}: runtime-context ${config.id} resolve failed: ${String(error?.message ?? error)}`)
            return ''
          }
        },
      }), `${name}: context ${config.id}`)
    } catch (error) {
      warnOnce(`${name}: runtime-context placeholder ${config.id} failed: ${String(error?.message ?? error)}`)
    }
  }
}

/** agent-request:对冻结的 LlmCallConfig 做浅合并 / 整体替换。 */
function wireAgentRequests(ctx, configs, warnOnce) {
  for (const config of configs) {
    ctx.on('agent/request', async (payload, next) => {
      const base = await next()
      try {
        if (!matchesAgentScope(config, payload?.agent)) return base
        const patch = config.params?.patch !== null && typeof config.params?.patch === 'object' && !Array.isArray(config.params.patch)
          ? config.params.patch
          : {}
        if (config.params?.replace === true) return { ...patch }
        return { ...base, ...patch }
      } catch (error) {
        warnOnce(`${name}: agent-request config ${config.id} failed: ${String(error?.message ?? error)}`)
        return base
      }
    })
  }
}

/** 把流替换为提示词配置文本的最小合法 chunk 序列。 */
async function* replacedStream(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
}

/** llm-stream:pass 透传;replace 用提示词配置文本替代整个模型流。 */
function wireLlmStreams(ctx, configs, warnOnce) {
  for (const config of configs) {
    ctx.on('llm/stream', (options, next) => {
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
    })
  }
}

/** 条件判定的匹配器与取文本逻辑由 condition.mjs 承载（pre-step 与其他层共用）。 */

/** 插件来源的 user 消息：与 anchor-turn / progress-reminder 同一形状。 */
function pluginMessage(prefix, text, summary) {
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
  for (const config of configs) {
    const names = parseToolNames(config.params?.toolNames)
    const matchesTool = (exec) => names.length === 0 || names.includes(exec?.name)
    ctx.on('tools/pre-execute', async (exec, next) => {
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
    })
    ctx.on('tools/post-execute', async (exec, result, next) => {
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
    })
  }
}

/**
 * 轮次停止层的续跑上限：每轮 1 次、每会话 3 次，均为引擎常量。
 * 不暴露为配置——强制续跑失控会把会话卡在停不下来的循环里；官方桥在同一位置
 * 也只留了 TODO(stop-loop-guard) 而未实现上限。
 */
export const TURN_STOP_MAX_PER_TURN = 1
export const TURN_STOP_MAX_PER_SESSION = 3

/** 会话内保留的轮次计数上限（与 deliberation-gate 同规模）。 */
const TURN_STOP_MAX_TRACKED_TURNS = 8

/** turn-stop：命中条件时阻止本轮停止并强制续跑一步，上限在引擎内。 */
function wireTurnStops(ctx, configs, warnOnce) {
  if (configs.length === 0) return
  /** sessionId -> { turns: Map<turn, count>, total } */
  const state = new Map()

  const stateOf = (sessionId, turn) => {
    let entry = state.get(sessionId)
    if (entry === undefined) {
      if (state.size >= MAX_TRACKED_SESSIONS) state.clear()
      entry = { turns: new Map(), total: 0 }
      state.set(sessionId, entry)
    }
    if (!Number.isFinite(turn)) return entry
    if (!entry.turns.has(turn) && entry.turns.size >= TURN_STOP_MAX_TRACKED_TURNS) {
      const oldest = [...entry.turns.keys()].sort((a, b) => a - b)
      for (const key of oldest.slice(0, entry.turns.size - TURN_STOP_MAX_TRACKED_TURNS + 1)) entry.turns.delete(key)
    }
    if (!entry.turns.has(turn)) entry.turns.set(turn, 0)
    return entry
  }

  for (const config of configs) {
    ctx.on('agent/turn-stopping', ({ agent, turn } = {}) => {
      try {
        const session = agent?.session
        if (session?.id === undefined || typeof agent.steer !== 'function') return
        if (!matchesAgentScope(config, agent)) return
        const entry = stateOf(session.id, turn)
        const turnCount = Number.isFinite(turn) ? (entry.turns.get(turn) ?? 0) : 0
        if (turnCount >= TURN_STOP_MAX_PER_TURN || entry.total >= TURN_STOP_MAX_PER_SESSION) return
        if (!conditionHit(config, { assistantText: lastAssistantText(session) })) return
        const text = layerText(config, agent, warnOnce)
        if (text.length === 0) return
        // 计数在 steer 之前落账：steer 抛错也不允许下一步重试越过预算。
        if (Number.isFinite(turn)) entry.turns.set(turn, turnCount + 1)
        entry.total += 1
        agent.steer(pluginMessage(`turn-stop-${config.id}`, text, `turn-stop ${config.id}`))
      } catch (error) {
        warnOnce(`${name}: turn-stop config ${config.id} failed: ${String(error?.message ?? error)}`)
      }
    })
  }
}

/** subagent-start：命中条件时向该子代理注入上下文；subagent-end 只能观察。 */
function wireSubagentEvents(ctx, configs, warnOnce) {
  const startConfigs = configs.filter((config) => config.layer === 'subagent-start')
  const endConfigs = configs.filter((config) => config.layer === 'subagent-end')
  if (startConfigs.length > 0) {
    ctx.on('subagent/start', (info) => {
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
    })
  }
  if (endConfigs.length > 0) {
    ctx.on('subagent/end', (info) => {
      try {
        const child = getService(ctx, 'agents')?.get?.(info?.id)
        const subagentText = subagentTextOf(info)
        for (const config of endConfigs) {
          if (!matchesAgentScope(config, child)) continue
          if (!conditionHit(config, { subagentText })) continue
          // 该事件只观察、没有注入通道：命中即留一条记录，不产生模型可见副作用。
          warnOnce(`${name}: subagent-end ${config.id} matched (observe only)`)
        }
      } catch (error) {
        warnOnce(`${name}: subagent-end failed: ${String(error?.message ?? error)}`)
      }
    })
  }
}

/** 把非 pre-step 提示词配置接入其声明的官方层级通道。 */
export function wireLayers(ctx, configs, warnOnce) {
  // 官方插值两层共享一份变量注册：运行时事实按 assembly 求值，非法名走别名改写。
  const registry = registerOfficialVariables(ctx, configs.filter((config) => config.layer === 'system-section' || config.layer === 'runtime-context'), warnOnce)
  wireSystemSections(ctx, configs.filter((config) => config.layer === 'system-section'), registry, warnOnce)
  wireRuntimeContexts(ctx, configs.filter((config) => config.layer === 'runtime-context'), registry, warnOnce)
  wireAgentRequests(ctx, configs.filter((config) => config.layer === 'agent-request'), warnOnce)
  wireLlmStreams(ctx, configs.filter((config) => config.layer === 'llm-stream'), warnOnce)
  wireToolPipelines(ctx, configs.filter((config) => config.layer === 'tool-pipeline'), warnOnce)
  wireTurnStops(ctx, configs.filter((config) => config.layer === 'turn-stop'), warnOnce)
  wireSubagentEvents(ctx, configs.filter((config) => config.layer === 'subagent-start' || config.layer === 'subagent-end'), warnOnce)
}
