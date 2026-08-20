/**
 * layers — 非 pre-step 的五个官方层级接线。
 * 所有注册都只作用于本插件提示词配置;单条失败 warnOnce 后继续。
 */

import {
  getService,
  interpolateVariables,
  interpolateStatic,
  isDelegated,
  keepDisposer,
  matchesModel,
  parseToolNames,
} from './shared.mjs'

const name = 'prompt-config-engine'

/** 单条文本型配置的完整文本:texts 数组按空行拼接（单一文本字段）。 */
function configText(config) {
  return config.texts
    .map((item) => interpolateStatic(item, config.variables))
    .filter((item) => item.length > 0)
    .join('\n\n')
}

/** agent/request 与 tools/* 层的作用域过滤。 */
function matchesAgentScope(config, agent) {
  if (agent === undefined) return true
  const delegated = isDelegated(agent.session)
  if (config.audience === 'main' && delegated) return false
  if (config.audience === 'subagent' && !delegated) return false
  return matchesModel(config.modelScope, agent.options?.model)
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
function wireSystemSections(ctx, configs, warnOnce) {
  const systemPrompt = getService(ctx, 'systemPrompt')
  if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') {
    if (configs.length > 0) warnOnce(`${name}: systemPrompt service unavailable — system-section configs skipped`)
    return
  }
  for (const group of textLayerGroups(configs)) {
    const base = group[0]
    try {
      const text = group.map((config) => configText(config)).filter((item) => item.length > 0).join('\n\n')
      if (text.length === 0) continue
      keepDisposer(ctx, systemPrompt.section({
        name: typeof base.params?.sectionName === 'string' && base.params.sectionName.length > 0 ? base.params.sectionName : base.id,
        order: base.order,
        text,
        ...(base.params?.complete === true ? { complete: true } : {}),
      }), `${name}: section ${base.id}`)
    } catch (error) {
      warnOnce(`${name}: system-section config ${base.id} failed: ${String(error?.message ?? error)}`)
    }
  }
}

/** runtime-context:注册动态运行时上下文(晋升后由 context-gate 差分投影;支持 merged 拼接与 placeholder 函数 provider)。 */
function wireRuntimeContexts(ctx, configs, warnOnce) {
  const systemPrompt = getService(ctx, 'systemPrompt')
  if (systemPrompt === undefined || typeof systemPrompt.context !== 'function') {
    if (configs.length > 0) warnOnce(`${name}: systemPrompt service unavailable — runtime-context configs skipped`)
    return
  }
  const staticConfigs = configs.filter((config) => config.strategy !== 'placeholder')
  for (const group of textLayerGroups(staticConfigs)) {
    const base = group[0]
    try {
      const text = group.map((config) => configText(config)).filter((item) => item.length > 0).join('\n\n')
      if (text.length === 0) continue
      keepDisposer(ctx, systemPrompt.context({
        name: typeof base.params?.contextName === 'string' && base.params.contextName.length > 0 ? base.params.contextName : base.id,
        order: base.order,
        text,
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
          if (config.texts.length > 0) return interpolateVariables(config.texts.join('\n\n'), variables, session)
          return typeof resolved.text === 'string' ? interpolateVariables(resolved.text, variables, session) : ''
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
  wireSystemSections(ctx, configs.filter((config) => config.layer === 'system-section'), warnOnce)
  wireRuntimeContexts(ctx, configs.filter((config) => config.layer === 'runtime-context'), warnOnce)
  wireAgentRequests(ctx, configs.filter((config) => config.layer === 'agent-request'), warnOnce)
  wireLlmStreams(ctx, configs.filter((config) => config.layer === 'llm-stream'), warnOnce)
  wireToolPipelines(ctx, configs.filter((config) => config.layer === 'tool-pipeline'), warnOnce)
}
