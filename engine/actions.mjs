/**
 * actions — 动作库（B3 T2）：把「执行」收敛为统一的动作接口。
 *
 * 一个动作 = `{ kind, id?, ...载荷 }`，由触发器运行时（T3）在判断命中后交来；
 * `registerAction(ctx, action)` 把它接到**该动作唯一合法的事件通道**上，返回
 * 释放函数。七类动作里只有第 (2)(5)(6) 类是新增执行面，其余五类都是既有实现的
 * 收敛入口——同一输入下的结果与现状逐条一致：
 *
 *   (1) inject-text     注入文本：复用九层的注册通道（layers.mjs / executor.mjs），不新开通道
 *   (2) assembly        改装配：`assembly.tools` / `sections` / `contexts` 的增删改
 *   (3) decision        裁决：pre-execute 的 allow|deny|ask 与 post-execute 的 accept|replace|block
 *   (4) append-context  追加上下文与续跑：`additionalContexts` / `agent.steer`（共用续跑预算）
 *   (5) guard           执行层 guard：`ctx.tools.guard()`，不可被后续策略解除的最终拒绝
 *   (6) sdk-strip       裁 SDK 声明文本：`tools:sdk` 段，TS / Python 双载荷
 *   (7) request-params  改模型请求参数：与既有 `agent-request` 层共用
 *                       `applyAgentRequestParams`（patch / replace / 按值条件删键）
 *
 * 第 (5) 类不是可选补充：已发布工具包在 `run_code` 执行时从
 * `registry.schemas(exec.agent)` 建绑定（安装包 `dsh-tools/lib/types/ptc.js:576`），
 * **不从裁过的 SDK 正文建绑定**——只裁文本挡不住「知道旧工具名」的调用；而
 * `scope restrict` 只收**继承面**，注册在 agent 本层与晚到的工具它收不动
 * （`view()` 对 own layer 豁免限制，`lib/index.js:2957-2977`）。因此：(a) 同一份名单
 * 判据同时驱动呈现过滤（第 (2) 类）与执行 guard（第 (5) 类）；(b) `restrict` 只在它能
 * 限制的继承面上做最佳努力复用，本层/晚到工具一律交给 guard 裁决；(c) SDK 文本裁剪
 * 只是剩余呈现补救，**不得替代执行边界**；(d) 不新增独立策略提供者。
 *
 * @module engine/actions
 */

import { createWarnOnce, keepDisposer, parseToolNames } from './shared.mjs'
import { stringList } from './fields.mjs'
import { applyPromptConfigs } from './executor.mjs'
import {
  applyAgentRequestParams,
  createTurnStopBudget,
  matchesAgentScope,
  pluginMessage,
  wireLayers,
} from './layers.mjs'
import { SDK_SECTION_NAME, sdkToolNames, stripSdkDeclarations } from './sdk-strip.mjs'

/**
 * 标识来源：**由调用方经 `options.plugin` 传入**（与 `trigger.mjs` 的
 * `mountTriggers(ctx, declarations, { plugin })` 同一约定），用于挂载期错误消息、
 * 降级告警与 disposer 标签。本文件不假装自己是某个具体模块——缺省值只作
 * 直接调用（测试 / 隔离复制）时的中性兜底，不表示任何真实插件身份。
 */
const DEFAULT_PLUGIN = 'prompt-actions'
/** PTC 呈现传输名：guard 与 restrict 都不得触碰它（碰了就没有 PTC 面可用）。 */
const RUN_CODE = 'run_code'

/**
 * 降级语义四类（PLAN T2 的固定词汇）。每个动作声明其中之一：
 *   - `keep`        失败/异常时保持下游原值（放行或原样返回），并 warnOnce；
 *   - `expose-all`  放弃过滤结果，暴露**完整**装配（比 keep 更弱：连部分过滤也不保留）；
 *   - `empty`       失败/无正文时产出空值（清空 contexts / 不注入）；
 *   - `silent`      没有替代值：命中即生效、不命中完全不存在，注册失败只告警，
 *                  绝不伪造"已生效"。
 */
export const ACTION_DEGRADE = Object.freeze({
  keep: 'keep',
  exposeAll: 'expose-all',
  empty: 'empty',
  silent: 'silent',
})

/**
 * 七类动作的声明：**合法事件通道** + **降级语义** + 触发时机。
 * `events` 是动作允许注册的官方事件（注册到声明外的事件在挂载期 fail loud）；
 * `services` 是它允许触碰的宿主服务方法（同一纪律的文档面）。
 */
export const ACTION_KINDS = Object.freeze({
  'inject-text': {
    title: '注入文本',
    events: ['agent/pre-step', 'session/event', 'system-prompt/assemble', 'agent/request', 'llm/stream', 'tools/pre-execute', 'tools/post-execute', 'agent/turn-stopping', 'subagent/start', 'subagent/end'],
    services: ['systemPrompt.section', 'systemPrompt.context', 'systemPrompt.variable'],
    degrade: ACTION_DEGRADE.keep,
    timing: '按配置声明的 layer 落到该层官方通道；pre-step 在 agent/pre-step，system-section/runtime-context 在注册期 + 官方 assembly。',
    note: '复用九层注册通道，不新开通道；显式空正文 = 不注册（empty 情形）。`options` 原样交给该层的既有接线（pre-step 执行器的 `prepend` = 声明的位置策略）；`session/event` 是 pre-step 执行器自带的会话态旁听，不是第二条注入通道。',
  },
  assembly: {
    title: '改装配',
    events: ['system-prompt/assemble'],
    services: [],
    degrade: ACTION_DEGRADE.exposeAll,
    timing: 'system-prompt/assemble 的下游结算之后（`await next()` 之后改，装配事实已就绪）。',
    note: '失败时返回未改动的装配 = 对 tools 即暴露完整目录；不改 global，只作用于本次 assembly。',
  },
  decision: {
    title: '裁决',
    events: ['tools/pre-execute', 'tools/post-execute'],
    services: [],
    degrade: ACTION_DEGRADE.keep,
    timing: 'pre 相在工具执行之前返回 allow|deny|ask；post 相在结果结算之后返回 accept|replace|block。',
    note: '异常与条件未命中一律 `next()`（放行/接受），绝不让裁决 bug 卡死调用。',
  },
  'append-context': {
    title: '追加上下文与续跑',
    events: ['tools/post-execute', 'agent/turn-stopping'],
    services: [],
    degrade: ACTION_DEGRADE.keep,
    timing: 'mode=context 在 post-execute 追加 durable user 通知；mode=continue 在 agent/turn-stopping steer 一步。',
    note: '续跑共用引擎的续跑预算（每轮 1 次 / 每会话 3 次），无正文时不追加（empty 情形）；绝不伪造 assistant 角色。',
  },
  guard: {
    title: '执行层 guard',
    events: ['system-prompt/assemble'],
    services: ['tools.guard', 'tools.restrict'],
    degrade: ACTION_DEGRADE.silent,
    timing: '首次 assembly 时按 agent scope 惰性注册一次（预设切换/重绑后按新的 agent.ctx 重注册）。',
    note: '最终拒绝层：注册在 agent.ctx 上（工具本层与晚到工具也被裁决），命中返回拒绝原因；不注册全局 guard。guard 自身不吞异常——异常即失败，绝不退化成"放行"。',
  },
  'sdk-strip': {
    title: '裁 SDK 声明文本',
    events: ['system-prompt/assemble'],
    services: [],
    degrade: ACTION_DEGRADE.keep,
    timing: 'system-prompt/assemble 下游结算之后，改写名为 tools:sdk 的段文本。',
    note: '只删不增、保守失败：形态异常/自校验失败一律原样返回；空名单零开销。仅是呈现补救，执行边界在 guard。',
  },
  'request-params': {
    title: '改模型请求参数',
    events: ['agent/request'],
    services: [],
    degrade: ACTION_DEGRADE.keep,
    timing: 'agent/request 的下游结算之后（`await next()` 拿到已冻结的 LlmCallConfig 再改写）。',
    note: '与既有 promptConfigs 的 agent-request 层共用 applyAgentRequestParams；只改命中 scope/agent 的请求，删键仅删"本声明注入的那个值"。',
  },
})

/** 名单字段：非空字符串数组 → Set；缺省返回 undefined。空数组合法（= 一个都不留）。 */
const NAME_LIST = stringList({ as: 'set', dedupe: true, allowEmpty: true })

/** 动作标签（错误消息与 source.plugin 命名空间）。 */
const labelOf = (action) => (typeof action?.id === 'string' && action.id.length > 0 ? action.id : String(action?.kind ?? 'action'))

/** 名单判据的唯一实现：presentation 过滤与执行 guard 共用（呈现与执行不得两套口径）。 */
function createMask(source, label, plugin) {
  const allow = NAME_LIST.parse(source?.allow, plugin, `${label}.allow`)
  const deny = NAME_LIST.parse(source?.deny, plugin, `${label}.deny`)
  if (allow === undefined && deny === undefined) {
    throw new TypeError(`${plugin}: ${label} needs allow and/or deny — 空名单无法表达「剔哪些工具」`)
  }
  for (const reserved of [allow, deny]) {
    if (reserved?.has(RUN_CODE)) {
      throw new TypeError(`${plugin}: ${label} must not name the reserved ${RUN_CODE} transport — it is the only callable entry of the PTC presentation`)
    }
  }
  return {
    allow,
    deny,
    /** 与 tool-filter.applyMask / Layer.admits 同一判据。 */
    blocks: (toolName) => {
      if (typeof toolName !== 'string' || toolName.length === 0) return false
      if (deny !== undefined && deny.has(toolName)) return true
      return allow !== undefined && !allow.has(toolName)
    },
  }
}

/** 合法通道绑定器：动作注册到声明外的事件在挂载期 fail loud。 */
function channelBinder(ctx, kind, plugin) {
  const legal = new Set(ACTION_KINDS[kind].events)
  return (event, handler, options) => {
    if (!legal.has(event)) {
      throw new TypeError(`${plugin}: action ${kind} must not register on ${JSON.stringify(event)} — legal channel(s): ${[...legal].join(', ')}`)
    }
    return ctx.on(event, handler, options)
  }
}

/** stringList 已保证形状；这里只做「声明即校验」的显式检查。 */
function requireString(value, label, plugin) {
  if (typeof value !== 'string') throw new TypeError(`${plugin}: ${label} must be a string`)
  return value
}

/**
 * (1) 注入文本：按声明的 layer 落到既有九层通道。
 * 不复制任何一层接线——`pre-step` 走 executor 的执行器，其余层走 layers 的接线。
 */
function registerInjectText(ctx, action, { plugin, warnOnce, collect }) {
  const config = action.config
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError(`${plugin}: inject-text requires a config object (与 promptConfigs 同形状的提示词配置)`)
  }
  if (typeof config.layer !== 'string' || config.layer.length === 0) {
    throw new TypeError(`${plugin}: inject-text config.layer is required (九层之一)`)
  }
  if (config.layer === 'pre-step') {
    collect(applyPromptConfigs(ctx, [config], action.options ?? {}))
    return
  }
  collect(wireLayers(ctx, [config], warnOnce))
}

/** (2) 改装配：一次 assembly 内的 tools / sections / contexts 增删改。 */
function registerAssembly(ctx, action, { plugin, warnOnce, on, collect }) {
  const target = action.target
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    throw new TypeError(`${plugin}: assembly requires a target object — { tools } / { sections } / { contexts }`)
  }
  const tools = target.tools === undefined ? undefined : createMask(target.tools, 'assembly.tools', plugin)
  const sectionsAdd = target.sections?.add
  const sectionsRemove = NAME_LIST.parse(target.sections?.remove, plugin, 'assembly.sections.remove')
  const contextsAdd = target.contexts?.add
  const contextsRemove = NAME_LIST.parse(target.contexts?.remove, plugin, 'assembly.contexts.remove')
  const contextsClear = target.contexts?.clear === true
  for (const [key, list] of [['sections.add', sectionsAdd], ['contexts.add', contextsAdd]]) {
    if (list === undefined) continue
    if (!Array.isArray(list)) throw new TypeError(`${plugin}: assembly.${key} must be an array of { name, text }`)
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') throw new TypeError(`${plugin}: assembly.${key} entries must be objects`)
      requireString(entry.name, `assembly.${key}[].name`, plugin)
      requireString(entry.text, `assembly.${key}[].text`, plugin)
    }
  }
  collect(on('system-prompt/assemble', async (assembly, context, next) => {
    // Downstream errors propagate untouched; only this action's own logic is guarded.
    const assembled = await next()
    try {
      if (typeof action.match === 'function' && action.match(context, assembled) !== true) return assembled
      let result = assembled
      if (tools !== undefined && Array.isArray(result.tools)) {
        result = { ...result, tools: result.tools.filter((tool) => !tools.blocks(tool?.name)) }
      }
      if (Array.isArray(result.sections) && (sectionsAdd !== undefined || sectionsRemove !== undefined)) {
        const kept = sectionsRemove === undefined
          ? result.sections
          : result.sections.filter((section) => !sectionsRemove.has(section?.name))
        result = { ...result, sections: sectionsAdd === undefined ? kept : [...kept, ...sectionsAdd] }
      }
      if (Array.isArray(result.contexts)) {
        if (contextsClear) result = { ...result, contexts: [] }
        else if (contextsAdd !== undefined || contextsRemove !== undefined) {
          const kept = contextsRemove === undefined
            ? result.contexts
            : result.contexts.filter((entry) => !contextsRemove.has(entry?.name))
          result = { ...result, contexts: contextsAdd === undefined ? kept : [...kept, ...contextsAdd] }
        }
      }
      return result
    } catch (error) {
      warnOnce(`${plugin}: assembly action ${labelOf(action)} failed, exposing the full assembly: ${String(error?.message ?? error)}`)
      return assembled
    }
  }))
}

/** 工具名单：与 tool-pipeline 层同语法（逗号串），也接受数组；空 = 命中全部工具。 */
function toolNameSet(value, plugin, field) {
  if (value === undefined) return undefined
  const names = NAME_LIST.parse(typeof value === 'string' ? parseToolNames(value) : value, plugin, field)
  return names !== undefined && names.size > 0 ? names : undefined
}

/** (3) 裁决：与 wireToolPipelines 同语义，判定由触发器在动作入口求值。 */
function registerDecision(ctx, action, { plugin, warnOnce, on, collect }) {
  const label = labelOf(action)
  const names = toolNameSet(action.toolNames, plugin, `${label}.toolNames`)
  const matchesTool = (exec) => names === undefined || names.has(exec?.name)
  const hit = (exec, result) => typeof action.match !== 'function' || action.match(exec, result) === true
  const phase = action.phase === 'post' ? 'post' : 'pre'
  if (phase === 'pre') {
    const decision = action.decision ?? 'allow'
    if (!['allow', 'deny', 'ask'].includes(decision)) {
      throw new TypeError(`${plugin}: ${label}.decision must be one of allow, deny, ask`)
    }
    collect(on('tools/pre-execute', async (exec, next) => {
      try {
        if (!matchesTool(exec) || !hit(exec)) return next()
        if (decision === 'allow') return next()
        if (decision === 'deny') return { kind: 'deny', reason: String(action.reason ?? `${label}: denied by action`) }
        return { kind: 'ask' }
      } catch (error) {
        warnOnce(`${plugin}: decision(pre) action ${label} failed: ${String(error?.message ?? error)}`)
        return next()
      }
    }))
    return
  }
  const postAction = action.action ?? 'accept'
  if (!['accept', 'replace', 'block'].includes(postAction)) {
    throw new TypeError(`${plugin}: ${label}.action must be one of accept, replace, block`)
  }
  const text = typeof action.text === 'string' ? action.text : ''
  collect(on('tools/post-execute', async (exec, result, next) => {
    try {
      if (!matchesTool(exec) || !hit(exec, result)) return next()
      if (postAction === 'accept') return next()
      if (postAction === 'replace' && text.length > 0) {
        return { kind: 'accept', content: [{ type: 'text', text }] }
      }
      if (postAction === 'block') {
        return { kind: 'block', feedback: [{ type: 'text', text: text.length > 0 ? text : `${label}: blocked by action` }] }
      }
      return next()
    } catch (error) {
      warnOnce(`${plugin}: decision(post) action ${label} failed: ${String(error?.message ?? error)}`)
      return next()
    }
  }))
}

/** (4) 追加上下文与续跑：与 progress-reminder / turn-stop 同语义，续跑共用引擎预算。 */
function registerAppendContext(ctx, action, { plugin, warnOnce, on, collect }) {
  const label = labelOf(action)
  const text = requireString(action.text, `${label}.text`, plugin)
  if (text.length === 0) return
  const budget = createTurnStopBudget()
  if (action.mode === 'continue') {
    collect(on('agent/turn-stopping', ({ agent, turn } = {}) => {
      try {
        if (typeof action.match === 'function' && action.match(agent, turn) !== true) return
        const session = agent?.session
        if (session?.id === undefined || typeof agent.steer !== 'function') return
        const entry = budget.entry(session.id, turn)
        if (!budget.available(entry, turn)) return
        // 计数在 steer 之前落账：steer 抛错也不允许下一步重试越过预算。
        budget.claim(entry, turn)
        // 身份归本动作：复用 pluginMessage 的形状，但 source.plugin 必须是动作命名空间
        // （层模块的 pluginMessage 用 layers 自己的身份，那不是本动作的名字）。
        const message = pluginMessage(`action-${label}`, text, `${label} continue`)
        agent.steer({ ...message, source: { ...message.source, plugin: label } })
      } catch (error) {
        warnOnce(`${plugin}: append-context(continue) action ${label} failed: ${String(error?.message ?? error)}`)
      }
    }))
    return
  }
  // 追加上下文：只回 user 角色的 durable 通知（宿主把 additionalContexts 落成 user 消息）。
  collect(on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    try {
      if (typeof action.match === 'function' && action.match(exec, result, decision) !== true) return decision
      if (decision?.kind !== 'accept') return decision
      const notice = {
        ...pluginMessage(`action-${label}`, text, `${label} context`),
        source: { kind: 'plugin', plugin: label, form: 'notice', summary: `${label} context` },
      }
      return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), notice] }
    } catch (error) {
      warnOnce(`${plugin}: append-context action ${label} failed, keeping the plain result: ${String(error?.message ?? error)}`)
      return decision
    }
  }))
}

/**
 * (5) 执行层 guard —— 唯一能兜住执行的口子。
 * 注册面：`agent.ctx.tools.guard`（agent scope，故只作用于该 agent，且覆盖本层与晚到工具）；
 * 复用面：同一名单在能限制的继承面上顺带 `restrict`（最佳努力，失败不影响 guard）。
 * guard 自身**不包 try/catch**：官方 `guardReason()` 只收集「返回的拒绝原因」，
 * 而它在 `prepareExecution` 的 try 内被调用（安装包 `dsh-tools/lib/index.js:3236`），
 * 抛错会落进同一 try 的 catch（`:3262-3268`）变成失败的工具结果——所以"异常即失败"
 * 是构造上的 fail-closed，绝不退化成放行，也不需要用 catch 去"兜"成允许。
 */
function registerGuard(ctx, action, { plugin, warnOnce, on, collect }) {
  const label = labelOf(action)
  const mask = createMask(action.mask ?? action, `${label}.mask`, plugin)
  const includeSubagents = action.includeSubagents === true
  const reasonFor = (toolName) => String(action.reason ?? `${label}: tool ${JSON.stringify(toolName)} is denied by action`)

  /** session -> { ctx, disposers }：同一 agent.ctx 只注册一次，重绑后按新 ctx 重注册。 */
  const appliedBySession = new WeakMap()
  const states = new Set()
  const releaseState = (state) => {
    states.delete(state)
    for (const dispose of state.disposers.splice(0)) {
      try { dispose() } catch { /* 释放失败不得反过来打断卸载 */ }
    }
  }
  const releaseAll = () => { for (const state of [...states]) releaseState(state) }

  const applyTo = (agent) => {
    const session = agent?.session
    const scoped = agent?.ctx
    if (session === undefined || scoped === undefined) return
    // 受众不在本动作的裁决面内就不注册（子代理的 guard 由它自己的 assembly 决定；
    // 万一父 guard 经 scope 链被走到，guard 体内的同一道受众判定仍然放行）。
    const depth = session.header?.delegationDepth ?? 0
    if (depth > 0 ? !includeSubagents : action.audience === 'subagent') return
    const existing = appliedBySession.get(session)
    if (existing !== undefined) {
      // 预设切换/重绑会换掉 agent.ctx：旧 scope 的 guard 随旧 scope 失效，必须重注册。
      if (existing.ctx === scoped) return
      releaseState(existing)
      appliedBySession.delete(session)
    }
    const tools = scoped.tools
    if (tools === undefined || typeof tools.guard !== 'function') {
      warnOnce(`${plugin}: guard action ${label} found no agent-scoped tools service — execution guard not registered`)
      return
    }
    const state = { ctx: scoped, disposers: [] }
    states.add(state)
    appliedBySession.set(session, state)
    const denials = {
      ...(mask.allow !== undefined ? { allow: [...mask.allow] } : {}),
      ...(mask.deny !== undefined ? { deny: [...mask.deny] } : {}),
    }
    if (typeof tools.restrict === 'function') {
      try {
        const dispose = tools.restrict(denials)
        if (typeof dispose === 'function') state.disposers.push(dispose)
      } catch (error) {
        // restrict 只收继承面：本层/晚到工具不在它的可限制集合里，交给 guard 裁决。
        warnOnce(`${plugin}: guard action ${label} restrict skipped (own-layer/late tools stay covered by the guard): ${String(error?.message ?? error)}`)
      }
    }
    state.disposers.push(tools.guard((exec) => {
      const toolName = exec?.name
      if (toolName === RUN_CODE || typeof toolName !== 'string' || toolName.length === 0) return undefined
      const depth = exec?.agent?.session?.header?.delegationDepth ?? 0
      // 主子代理隔离：scope 注册之外再按受众判定一次（子代理 scope 可能挂在父链上）。
      if (depth > 0 ? !includeSubagents : action.audience === 'subagent') return undefined
      return mask.blocks(toolName) ? reasonFor(toolName) : undefined
    }))
  }

  collect(releaseAll)
  collect(on('system-prompt/assemble', async (assembly, context, next) => {
    // Downstream errors propagate untouched; only this action's own logic is guarded.
    const assembled = await next()
    try {
      applyTo(context?.agent)
    } catch (error) {
      warnOnce(`${plugin}: guard action ${label} failed to register: ${String(error?.message ?? error)}`)
    }
    return assembled
  }))
}

/**
 * (6) 裁 SDK 声明文本。
 * 注：官方 `sdkSection().text(context)` 与一次 assembly 里 `tools:sdk` 段的文本同源
 * （前者按 `this.sdkSchemas(context.scope)` 现渲染，后者是同一 provider 在同一次
 * assembly 里求值的结果），所以"按更新后的视图重生"并不改变文本——真正需要的是
 * 对**已产出正文**做删行；重生不是必需步骤，故这里直接改段文本。
 */
function registerSdkStrip(ctx, action, { plugin, warnOnce, on, collect }) {
  const label = labelOf(action)
  const mask = createMask(action.mask ?? action, `${label}.mask`, plugin)
  collect(on('system-prompt/assemble', async (assembly, context, next) => {
    // Downstream errors propagate untouched; only this action's own logic is guarded.
    const assembled = await next()
    try {
      if (!Array.isArray(assembled.sections)) return assembled
      let changed = false
      const sections = assembled.sections.map((section) => {
        if (section?.name !== SDK_SECTION_NAME || typeof section.text !== 'string') return section
        const names = mask.allow === undefined
          ? mask.deny
          : new Set([...sdkToolNames(section.text)].filter((toolName) => mask.blocks(toolName)))
        if (names === undefined || names.size === 0) return section
        const stripped = stripSdkDeclarations(section.text, names)
        if (stripped === section.text) return section
        changed = true
        return { ...section, text: stripped }
      })
      return changed ? { ...assembled, sections } : assembled
    } catch (error) {
      warnOnce(`${plugin}: sdk-strip action ${label} failed, keeping the original SDK text: ${String(error?.message ?? error)}`)
      return assembled
    }
  }))
}

/** (7) 改模型请求参数：与既有 agent-request 层共用同一实现，不另写一套请求改写。 */
function registerRequestParams(ctx, action, { plugin, warnOnce, on, collect }) {
  const label = labelOf(action)
  const patch = action.patch
  if (patch !== undefined && (patch === null || typeof patch !== 'object' || Array.isArray(patch))) {
    throw new TypeError(`${plugin}: ${label}.patch must be an object`)
  }
  const unset = action.unset
  if (unset !== undefined && (unset === null || typeof unset !== 'object' || Array.isArray(unset))) {
    throw new TypeError(`${plugin}: ${label}.unset must be an object of { key: expectedValue }`)
  }
  if (action.replace === true && unset !== undefined) {
    throw new TypeError(`${plugin}: ${label} cannot combine replace with unset — 整体替换没有可比较的下游值`)
  }
  const params = { ...(patch !== undefined ? { patch } : {}), ...(unset !== undefined ? { unset } : {}), ...(action.replace === true ? { replace: true } : {}) }
  collect(on('agent/request', async (payload, next) => {
    const base = await next()
    try {
      if (!matchesAgentScope(action, payload?.agent)) return base
      return applyAgentRequestParams(params, base)
    } catch (error) {
      warnOnce(`${plugin}: request-params action ${label} failed: ${String(error?.message ?? error)}`)
      return base
    }
  }))
}

const REGISTRARS = {
  'inject-text': registerInjectText,
  assembly: registerAssembly,
  decision: registerDecision,
  'append-context': registerAppendContext,
  guard: registerGuard,
  'sdk-strip': registerSdkStrip,
  'request-params': registerRequestParams,
}

/**
 * 把一个动作接到它唯一合法的通道上。
 *
 * @param ctx 注册作用域（挂载 ctx；guard 的生效作用域随后按 agent.ctx 决定）。
 * @param action `{ kind, id?, ... }`，形状见 {@link ACTION_KINDS}。
 * @param options.plugin 调用方插件名（错误消息 / 告警 / disposer 标签），与
 *   `mountTriggers(ctx, declarations, { plugin })` 同一约定；缺省 `prompt-actions`。
 * @param options.warnOnce 复用宿主模块的告警器；缺省为本文件自己的 warnOnce。
 * @returns 释放函数：撤销本动作注册的监听器与 agent scope 上的 guard/restrict。
 */
export function registerAction(ctx, action, options = {}) {
  const kind = action?.kind
  const declaration = ACTION_KINDS[kind]
  const plugin = typeof options.plugin === 'string' && options.plugin.length > 0 ? options.plugin : DEFAULT_PLUGIN
  if (declaration === undefined) {
    throw new TypeError(`${plugin}: unknown action kind ${JSON.stringify(kind)} — known kinds: ${Object.keys(ACTION_KINDS).join(', ')}`)
  }
  const warnOnce = options.warnOnce ?? createWarnOnce(ctx, plugin)
  const on = channelBinder(ctx, kind, plugin)
  const disposers = []
  const collect = (disposer) => { if (typeof disposer === 'function') disposers.push(disposer) }
  REGISTRARS[kind](ctx, action, { plugin, warnOnce, on, collect })
  const dispose = () => {
    for (const release of disposers.splice(0)) {
      try {
        release()
      } catch {
        // 释放失败不得反过来打断卸载流程。
      }
    }
  }
  keepDisposer(ctx, dispose, `${plugin}: action ${labelOf(action)}`)
  return dispose
}
