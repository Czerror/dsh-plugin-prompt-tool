/**
 * layers — 非 pre-step 的五个官方层级接线。
 * 所有注册都只作用于本插件提示词配置;单条失败 warnOnce 后继续。
 */

import {
  getService,
  isDelegated,
  keepDisposer,
  matchesModel,
  parseToolNames,
} from './shared.mjs'
import { interpolateVariables, interpolateStatic, stripUnresolvedRefs, RUNTIME_FACTS, runtimeFactValue } from './interpolate.mjs'
import { getSessionVar } from './session-vars.mjs'

const name = 'prompt-config-engine'

/** 单条文本型配置的完整文本:texts 数组按空行拼接（单一文本字段）。
 *  keep=官方变量通道按 assembly 求值的名字，静态 pass 命中即原样保留引用。 */
function configText(config, registry) {
  return config.texts
    .map((item) => interpolateStatic(item, config.variables, registry?.protect))
    .filter((item) => item.length > 0)
    .join('\n\n')
}

/** 官方 prompt 变量名规则（与官方 system-prompt 的 VARIABLE_NAME 一致）。 */
const OFFICIAL_NAME_RE = /^[a-z][a-z0-9_]*$/
/** 引用形态（仅名字，无 `::` 参数）：事实与内容变量引用都用这一形态。 */
const NAME_REFERENCE_RE = /\{\{([A-Za-z0-9_.\u4e00-\u9fff-]+)\}\}/g

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
 * @returns protect=静态 pass 保留的名字；alias=原引用名→官方名；registered=已注册官方名（剥离白名单）。
 */
function registerOfficialVariables(ctx, configs, warnOnce) {
  const registry = { protect: new Set(), alias: new Map(), registered: new Set() }
  const systemPrompt = getService(ctx, 'systemPrompt')
  if (systemPrompt === undefined || typeof systemPrompt.variable !== 'function') return registry
  const declared = new Map()
  const referenced = new Set()
  for (const config of configs) {
    for (const [name, value] of Object.entries(config.variables ?? {})) {
      if (!declared.has(name)) declared.set(name, value === null || value === undefined ? '' : String(value))
    }
    for (const text of config.texts) {
      for (const match of String(text).matchAll(NAME_REFERENCE_RE)) referenced.add(match[1])
    }
  }
  // 只注册"会被用到"的名字：官方通道文本里被引用的运行时事实与已声明变量。
  // 未被引用的名字不注册——避免在 preset scope 里无谓遮蔽同名的他方注册。
  const candidates = [...referenced].filter((name) => declared.has(name) || RUNTIME_FACTS.has(name.toLowerCase()))
  for (const name of candidates) {
    const isFact = RUNTIME_FACTS.has(name.toLowerCase())
    // 事实名大小写不敏感：统一注册到规范小写名，避免 {{lastUserMessage}} 这类变体各生成一个别名。
    const official = isFact ? name.toLowerCase() : OFFICIAL_NAME_RE.test(name) ? name : officialAliasOf(name)
    const declaredValue = declared.get(name)
    try {
      keepDisposer(ctx, systemPrompt.variable(official, (context) => {
        const session = context?.agent?.session
        // 优先级与 interpolate 一致：会话变量 > 配置 variables > 运行时事实。
        const override = session === undefined ? undefined : getSessionVar(session, name)
        if (override !== undefined) return String(override)
        if (declaredValue !== undefined) return declaredValue
        if (isFact) return runtimeFactValue(name, session) ?? ''
        return ''
      }), `${name}: official prompt variable ${official}`)
      registry.registered.add(official)
      registry.protect.add(name)
      if (official !== name) registry.alias.set(name, official)
    } catch (error) {
      warnOnce(`${name}: 官方 prompt 变量 ${official} 注册失败，该引用退回静态解析：${String(error?.message ?? error)}`)
    }
  }
  return registry
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
      const groupText = group.map((config) => configText(config, registry)).filter((item) => item.length > 0).join('\n\n')
      if (groupText.length === 0) continue
      const hasAudience = group.some((config) => config.audience != null)
      const text = hasAudience
        ? (context) => officialChannelText(
            group
              .filter((config) => matchesAgentScope(config, context?.agent))
              .map((config) => configText(config, registry))
              .filter((item) => item.length > 0)
              .join('\n\n'),
            `system-section ${base.id}`,
            registry,
            warnOnce,
          )
        : officialChannelText(groupText, `system-section ${base.id}`, registry, warnOnce)
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
  const staticConfigs = configs.filter((config) => config.strategy !== 'placeholder')
  for (const group of textLayerGroups(staticConfigs)) {
    const base = group[0]
    try {
      const text = group.map((config) => configText(config, registry)).filter((item) => item.length > 0).join('\n\n')
      if (text.length === 0) continue
      keepDisposer(ctx, systemPrompt.context({
        name: typeof base.params?.contextName === 'string' && base.params.contextName.length > 0 ? base.params.contextName : base.id,
        order: base.order,
        text: officialChannelText(text, `runtime-context ${base.id}`, registry, warnOnce),
      }), `${name}: context ${base.id}`)
    } catch (error) {
      warnOnce(`${name}: runtime-context config ${base.id} failed: ${String(error?.message ?? error)}`)
    }
  }
  // placeholder:官方 context 接受函数 provider,在每次 assembly 时动态填充。
  const placeholders = configs.filter((config) => config.strategy === 'placeholder')
    .sort((a, b) => a.order - b.order)
  for (const config of placeholders) {
    try {
      const resolver = config.resolve
      keepDisposer(ctx, systemPrompt.context({
        name: typeof config.params?.contextName === 'string' && config.params.contextName.length > 0 ? config.params.contextName : config.id,
        order: config.order,
        text: async (assembly) => {
          const agent = assembly?.agent
          const session = agent?.session
          const resolved = await resolver({ ctx, agent, session, decision: { kind: 'ok', messages: [] }, messages: [] })
          if (resolved === null || resolved === undefined) return ''
          const variables = { ...config.variables, ...(resolved.variables !== null && typeof resolved.variables === 'object' ? resolved.variables : {}) }
          // runtime-context 是官方插值通道且 0.1.6 没有 interpolate:false：出口同样清洗。
          const rendered = config.texts.length > 0
            ? interpolateVariables(config.texts.join('\n\n'), variables, session)
            : typeof resolved.text === 'string' ? interpolateVariables(resolved.text, variables, session) : ''
          return officialChannelText(rendered, `runtime-context ${config.id}`, registry, warnOnce)
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

/** tool-pipeline:pre-execute 判定、execute 包装、post-execute 结果替换/阻断。 */
function wireToolPipelines(ctx, configs, warnOnce) {
  for (const config of configs) {
    const names = parseToolNames(config.params?.toolNames)
    const matchesTool = (exec) => names.length === 0 || names.includes(exec?.name)
    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        if (!matchesTool(exec) || !matchesAgentScope(config, exec?.agent)) return next()
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

/** 把非 pre-step 提示词配置接入其声明的官方层级通道。 */
export function wireLayers(ctx, configs, warnOnce) {
  // 官方插值两层共享一份变量注册：运行时事实按 assembly 求值，非法名走别名改写。
  const registry = registerOfficialVariables(ctx, configs.filter((config) => config.layer === 'system-section' || config.layer === 'runtime-context'), warnOnce)
  wireSystemSections(ctx, configs.filter((config) => config.layer === 'system-section'), registry, warnOnce)
  wireRuntimeContexts(ctx, configs.filter((config) => config.layer === 'runtime-context'), registry, warnOnce)
  wireAgentRequests(ctx, configs.filter((config) => config.layer === 'agent-request'), warnOnce)
  wireLlmStreams(ctx, configs.filter((config) => config.layer === 'llm-stream'), warnOnce)
  wireToolPipelines(ctx, configs.filter((config) => config.layer === 'tool-pipeline'), warnOnce)
}
