/**
 * executor — pre-step 消息批执行器。
 * 职责:过滤(层/子代理/模型/晋升)→ resolve → 插值 → 去重/合并 → 落位插入。
 * 任一提示词配置失败只跳过该提示词配置并 warnOnce,绝不让注入 bug 卡死会话。
 *
 * 装配路径有两条，批执行算法只有一份（runPreStepBatch）：
 *   - 管理路径：宿主 prompt-tool 插件提供 `promptToolPreStep` 协调服务时，本来源
 *     （预设 mount）把配置注册给协调器，由协调器统一执行预设来源与独立指令文件来源；
 *   - 独立路径：没有协调服务（引擎被复制到无宿主的目录复用）时，本行 ctx 注册本地
 *     pre-step 监听器，只执行自身预设配置。
 * 协调服务迟到或消失时按「先撤旧再启新」切换，任一时刻每 scope 只有一条执行路径。
 */

import {
  MAX_TRACKED_SESSIONS,
  PROMOTE_EVENTS,
  createWarnOnce,
  getService,
  isDelegated,
  keepDisposer,
  matchesModel,
  newMessageId,
  sessionEvents,
} from './shared.mjs'
import { interpolateVariables } from './interpolate.mjs'
import { conditionHit, userMessagesText } from './condition.mjs'
import { createEpochPromotion } from './compaction-epoch.mjs'
import { wireLayers } from './layers.mjs'
import { sessionVarsSnapshot } from './session-vars.mjs'
import { selectStWorldBook } from './st-world-book.mjs'
import { compareConfigSequence } from './order.mjs'
import { ruleFrame, actionMatches } from './conditions/evaluation.mjs'

const name = 'prompt-config-engine'

/** 已确认投递身份的进程内快路径上限;真相在持久事件流。 */
// ponytail: 身份条数上限防无界增长（Map 按投递身份累积）；若需精确淘汰改 LRU。
const MAX_MEMO_CONFIGS = 4096

/**
 * 查询宿主 prompt-tool 插件的 pre-step 协调服务（ctx.get 跨 fiber 解析）。
 * 缺失/形状不符时返回 undefined：本行回退独立执行路径。
 */
function coordinatorOf(ctx) {
  const service = getService(ctx, 'promptToolPreStep')
  return service !== null && typeof service === 'object' && typeof service.registerPreset === 'function'
    ? service
    : undefined
}

/** 事件数据兼容两层形状:event.data 本身是消息,或 event.data.message 是消息。 */
function eventMessage(event) {
  const data = event?.data
  if (data === null || typeof data !== 'object') return undefined
  const message = data.message !== null && typeof data.message === 'object' ? data.message : data
  return message?.source !== null && typeof message?.source === 'object' ? message : undefined
}

/** 合并身份:merged 模式按位置分组(merged:<position>);separate 模式保持自身身份。 */
function mergedIdentity(config) {
  if (config.mergeMode !== 'merged') return config.id
  return `merged:${config.position}`
}

/** 去重身份:merged 组用位置命名空间,独立配置用自身身份。 */
function identityOf(config) {
  return config.mergeMode === 'merged' ? mergedIdentity(config) : config.identity.value
}

/**
 * 消息来源的插件身份（去重身份）。v4 起 `source.kind` 是生产者名（`plugin:<name>`），
 * `source.plugin` 只作为旧日志字段保留——两条通道都要认，否则去重记账会在格式换代后静默失效。
 */
function pluginIdentityOf(source) {
  if (source === null || typeof source !== 'object') return undefined
  if (typeof source.plugin === 'string' && source.plugin.length > 0) return source.plugin
  return typeof source.kind === 'string' && source.kind.startsWith('plugin:')
    ? source.kind.slice('plugin:'.length)
    : undefined
}

function hasInjected(config, session) {
  const value = identityOf(config)
  return sessionEvents(session).some((event) => {
    const message = eventMessage(event)
    // 双通道去重：kind（外来/第三方消息，如 context-gate 的 instruction-hint）或
    // plugin（本引擎注入的命名空间，merged 组用 merged:<position>）。
    return message?.source?.kind === config.sourceKind || pluginIdentityOf(message?.source) === value
  })
}

/** 当前消息批内是否已有该提示词配置注入(每轮去重)。 */
function hasInBatch(config, messages) {
  const value = identityOf(config)
  return messages.some((message) =>
    message?.source?.kind === config.sourceKind || pluginIdentityOf(message?.source) === value)
}

/**
 * 按投递身份取「已确认投递」的会话集合。记账只发生在宿主真正接纳并持久化该消息之后
 * （见 confirmDelivered）：候选在瀑布外层被门控/策略剥离时不算已投递，否则晋升后
 * （门控放行时）正文会永久缺失。集合上限按会话数截断，真相仍在持久事件流。
 */
function deliveredSessions(memo, key) {
  let set = memo.get(key)
  if (set === undefined) {
    if (memo.size >= MAX_MEMO_CONFIGS) memo.clear()
    set = new Set()
    memo.set(key, set)
  }
  if (set.size >= MAX_TRACKED_SESSIONS) set.clear()
  return set
}

/**
 * 记录一次宿主已接纳的注入消息（由调用方在 session/event 里转发）。
 * plugin（本引擎身份，merged 组用 merged:<position>）与 kind（外来通道，如
 * context-gate 的 instruction-hint）都以会话为界记账，与 hasInjected 的双通道语义一致。
 */
export function confirmDelivered(memo, session, event) {
  if (memo === null || memo === undefined || session === null || session === undefined) return
  const source = eventMessage(event)?.source
  if (source === null || typeof source !== 'object') return
  for (const field of ['plugin', 'kind']) {
    const value = source[field]
    if (typeof value !== 'string' || value.length === 0) continue
    deliveredSessions(memo, `${field}:${value}`).add(session.id)
  }
  // v4 起生产者身份挂在 kind（`plugin:<name>`），旧日志才有 plugin 字段；
  // 两种形态都补记到 plugin: 账本，alreadyDelivered 的 `confirmed('plugin', …)` 才不会漏。
  const plugin = pluginIdentityOf(source)
  if (plugin !== undefined && source.plugin === undefined) deliveredSessions(memo, `plugin:${plugin}`).add(session.id)
}

/** dedupe=session：本会话是否已有该身份的已确认投递（快路径 + 持久事件真相）。 */
function alreadyDelivered(config, session, memo) {
  const confirmed = (field, value) => memo.get(`${field}:${value}`)?.has(session.id) === true
  if (confirmed('plugin', identityOf(config))) return true
  if (typeof config.sourceKind === 'string' && confirmed('kind', config.sourceKind)) return true
  return hasInjected(config, session)
}

/**
 * pre-step 唯一可发出角色：宿主把本批消息逐条写成 `user/message` 事件，事件校验要求
 * `role === 'user'`（assistant 只能由模型侧 assistant/message 事件产生）。
 */
const PRE_STEP_ROLE = 'user'

/**
 * 记录一次角色降级：保留原角色、明确告警、不改正文，也不把非法值传给宿主。
 * 同一配置只告警一次（warnOnce），且不记录正文或用户内容。
 */
function downgradeRole(config, requested, warnOnce) {
  if (typeof requested !== 'string' || requested === PRE_STEP_ROLE) return undefined
  warnOnce(`${name}: config ${String(config?.id ?? '<unknown>')} role ${JSON.stringify(requested)} cannot be injected in pre-step, message downgraded to "${PRE_STEP_ROLE}"`)
  return requested
}

/** 构造默认 user 消息;策略返回完整 patch 时覆盖对应字段,但非法角色在出口兜底降级。 */
function buildMessage(config, resolved, warnOnce) {
  const text = typeof resolved.text === 'string' ? resolved.text : ''
  const defaultContent = config.texts.length > 0
    ? config.texts.map((item) => ({ type: 'text', text: item }))
    : [{ type: 'text', text }]
  // 盖章身份与 alreadyDelivered 的查找键同源（identityOf）：显式 identity 才真正共享去重，
  // 也不会与他卡的 id 误撞；merged 组 identityOf 本就等于 mergedIdentity，存量输出不变。
  const sourceValue = identityOf(config)
  // 策略 patch（templateFile 的 role 等）与配置声明都必须经过同一出口判定。
  const requested = downgradeRole(config, typeof resolved.role === 'string' ? resolved.role : config.role, warnOnce)
  const base = resolved.source !== null && typeof resolved.source === 'object'
    // 解析器自带的 source 也要盖章：否则这类消息（如 fill=instruction-hint 的
    // `{ kind: 'instruction-hint' }`）只带 kind 通道，dedupe=session 每步重复注入。
    ? { ...resolved.source, plugin: typeof resolved.source.plugin === 'string' && resolved.source.plugin.length > 0 ? resolved.source.plugin : sourceValue }
    : {
        // v4 要求 kind 是**生产者名**：声明了 sourceKind 就用它，否则用与 pluginMessage 同一形状的
        // `plugin:<身份>`。裸 kind（undefined / 'plugin'）都会被 codec 拒绝，历史走的是同一个坑。
        kind: typeof config.sourceKind === 'string' && config.sourceKind.length > 0 ? config.sourceKind : `plugin:${sourceValue}`,
        plugin: sourceValue,
        ...(typeof config.form === 'string' ? { form: config.form } : {}),
        ...(typeof config.summary === 'string' && config.summary.length > 0 ? { summary: config.summary } : {}),
      }
  return {
    id: typeof resolved.id === 'string' && resolved.id.length > 0 ? resolved.id : newMessageId(config.id),
    role: PRE_STEP_ROLE,
    content: Array.isArray(resolved.content) ? resolved.content : defaultContent,
    source: requested === undefined ? base : { ...base, requestedRole: requested },
  }
}

/**
 * 本步（一个 pre-step 批次，含被 `ruleActions` 切开的多次 flush）的批级快照：
 * 合格配置集合、模板位置身份集合与 ST 世界书选择，全部在批首取定一次。
 *
 * 三者必须同一集合：`qualified` 每配置只判一次（R02），ST 世界书的组互斥与概率/
 * 粘滞窗口按**步**成立——旧实现每个 flush 各选一次，同组两条会各赢一条（F06）。
 * 返回 undefined = 本批无法执行（reject / 无 agent / 无 session），调用方原样返回。
 */
function batchScope(options, frame) {
  const { agent, decision, configs, promotion, warnOnce } = options
  const session = agent?.session
  if (decision === null || typeof decision !== 'object' || decision.kind === 'reject'
    || agent === undefined || session === undefined) return undefined
  // 条件判定的匹配对象在本批进入时取定：批次内后续注入不改变本批的判定依据。
  const messages = Array.isArray(decision.messages) ? [...decision.messages] : []
  const userText = userMessagesText(messages)
  const { main, withSubagents } = promotion
  const delegated = isDelegated(session)
  // 本批资格判定（唯一实现）：层通道、受众、模型、晋升与声明式条件。
  // 条件判定放在去重之前：未命中的配置不算「已注入」，条件恢复后仍应能注入。
  // ST 模板的跨配置变量帧按 order 预求值，但只有这里的获准集合才允许产生副作用
  // （未命中的 setter 提前 setvar 会污染同批 reader）——渲染器不再复制判定。
  const qualified = configs.filter((config) => config.layer === 'pre-step'
    && !(config.audience === 'main' && delegated)
    && !(config.audience === 'subagent' && !delegated)
    && matchesModel(config.modelScope, agent.options?.model)
    && (config.promotion !== 'main' || main.status(agent).promoted)
    && (config.promotion !== 'include-subagents' || withSubagents.status(agent).promoted)
    && conditionHit(config, { userText })
    && actionMatches(config, frame))
  return {
    qualified: new Set(qualified),
    // 协调器为绑定来源 ctx 会复制 config；renderSt 函数身份在副本间保持不变。
    eligible: new Set(qualified.map(config => config.renderSt)),
    stWorldBook: selectStWorldBook(qualified, session, messages, warnOnce),
  }
}

/**
 * 批执行算法(单一实现):过滤(层/子代理/模型/晋升)→ resolve → 插值 →
 * 去重/合并 → 落位插入。
 *
 * 预设卡与独立指令文件卡共用这条路径，身份空间互不覆盖；文件来源的候选资格由
 * 调用方(协调器)按可见状态先行判定，这里只按各卡自身声明的策略执行。文件正文以
 * content 块返回(不填 config.texts)，因此不经过预设变量插值。
 *
 * @param options.configs 已过滤 enabled 与互斥组的最终提示词配置列表。
 * @param options.promotion { main, withSubagents } 晋升追踪器(真相在持久事件流)。
 * @param options.memo 已确认投递身份的进程内 session 去重快路径（见 confirmDelivered）。
 * @returns 注入后的 decision；reject、缺 agent/session、全部跳过或异常时原样返回。
 */
export async function runPreStepBatch(options) {
  const initialFrame = options.ruleFrame ?? ruleFrame('agent/pre-step', [{ agent: options.agent, messages: options.decision?.messages ?? [] }], options.warnOnce, options.ctx, options.onOutcome)
  const scope = batchScope(options, initialFrame)
  if (!options.ruleActions?.length) return runPromptConfigBatch({ ...options, ruleFrame: initialFrame, scope })
  const entries = [...options.configs.map(config => ({ ...config, config })), ...options.ruleActions].sort(compareConfigSequence)
  let decision = options.decision
  if (decision?.kind === 'reject') return decision
  let pending = []
  const placement = { beforeAll: new Set(), afterUser: new Set() }
  const flush = async () => {
    if (pending.length) decision = await runPromptConfigBatch({ ...options, decision, configs: pending, ruleFrame: initialFrame, placement, scope })
    pending = []
  }
  for (const entry of entries) {
    if (entry.config) { pending.push(entry.config); continue }
    await flush()
    if (actionMatches(entry, initialFrame)) decision = await entry.handler(options.payload ?? initialFrame.args[0], () => decision, initialFrame)
  }
  await flush()
  return decision
}

async function runPromptConfigBatch(options) {
  const { ctx, agent, decision, configs, memo, warnOnce, scope } = options
  if (decision === null || typeof decision !== 'object') return decision
  if (decision.kind === 'reject') return decision
  if (agent === undefined) return decision
  const session = agent.session
  if (session === undefined) return decision
  // 批级快照由 runPreStepBatch 在批首取定；这里只消费，不再重新判定。
  if (scope === undefined) return decision
  try {
    const messages = Array.isArray(decision.messages) ? [...decision.messages] : []
    let changed = false

    const due = []
    for (const config of configs) {
      try {
        if (!scope.qualified.has(config)) continue

        if (config.dedupe === 'session') {
          if (alreadyDelivered(config, session, memo)) continue
        } else if (config.dedupe === 'batch' && hasInBatch(config, messages)) {
          continue
        }

        const resolved = await config.resolve({ ctx, agent, session, decision, messages, stWorldBookSelected: scope.stWorldBook.has(config) })
        if (resolved === null || resolved === undefined) continue
        const patched = { ...resolved }
        // params 并入插值变量：ST 变量（setvar/getvar 收集 + 预设参数）顶层 key 直接可插值
        //（含中文 key 如 {{接受值}}——引擎正则已支持 Unicode 字母）。
        // 会话变量（session_var 工具维护）覆盖配置/预设默认：resolved > 会话 > params > 配置。
        const mergedVars = {
          ...config.variables,
          ...config.params,
          ...sessionVarsSnapshot(session),
          ...(resolved.variables !== null && typeof resolved.variables === 'object' ? resolved.variables : {}),
        }
        if (typeof config.renderSt === 'function') {
          patched.text = config.renderSt(agent, messages, warnOnce, options, scope.eligible)
          patched.content = patched.text.length > 0 ? [{ type: 'text', text: patched.text }] : []
        } else if (typeof patched.text === 'string') {
          // 提示词配置级模板变量 + filler 变量 + 内置环境变量插值。
          // 第 5 参是模板位置身份（本配置的 id）：{{pick}} 的 seed 只认「同会话 + 同模板位置 + 同一次出现」，
          // 缺省空串会让不同配置的首个 pick 退化成同一个 seed。
          patched.text = interpolateVariables(patched.text, mergedVars, session, undefined, config.id)
        }
        if (config.texts.length > 0 && typeof config.renderSt !== 'function') {
          const blocks = config.texts
            .map((item, index) => interpolateVariables(item, mergedVars, session, undefined, `${config.id}#${index}`))
            .filter((item) => item.length > 0)
            .map((item) => ({ type: 'text', text: item }))
          if (blocks.length > 0) patched.content = blocks
        }
        const hasText = typeof patched.text === 'string' && patched.text.length > 0
        const hasContent = Array.isArray(patched.content) && patched.content.length > 0
        if (!hasText && !hasContent) continue
        due.push({ config, resolved: patched })
      } catch (error) {
        // 单个提示词配置失败不得伤及会话:跳过该提示词配置,只告警一次。
        warnOnce(`${name}: config ${String(config?.id ?? '<unknown>')} failed, skipping: ${String((error && error.message) || error)}`)
      }
    }

    // 模块来源按序号；独立调用仍按 order，同值保留稳定身份顺序。
    due.sort((a, b) => compareConfigSequence(a.config, b.config))

    // 每个落位内只合并同来源的连续 merged 卡；其他落位不会穿插在本落位的输出中。
    // source 仍用既有 merged:<position>，不因分段或排序改写持久去重身份。
    const orderedGroups = []
    const lastAtPosition = new Map()
    for (const entry of due) {
      const previous = lastAtPosition.get(entry.config.position)
      const base = previous?.[0].config
      if (entry.config.mergeMode === 'merged' && base?.mergeMode === 'merged'
        && entry.config.sourceModuleId === base.sourceModuleId) previous.push(entry)
      else {
        const group = [entry]
        orderedGroups.push(group)
        lastAtPosition.set(entry.config.position, group)
      }
    }

    const planned = []
    for (const group of orderedGroups) {
      const base = group[0]
      const message = buildMessage(base.config, base.resolved, warnOnce)
      if (group.length > 1) {
        message.content = group.flatMap((entry) => {
          if (Array.isArray(entry.resolved.content)) return entry.resolved.content
          return typeof entry.resolved.text === 'string' && entry.resolved.text.length > 0
            ? [{ type: 'text', text: entry.resolved.text }]
            : []
        })
        if (message.source !== null && typeof message.source === 'object') {
          message.source = { ...message.source, plugin: mergedIdentity(base.config) }
        }
        // 合并组的角色由首条配置决定;其余成员声明的非法角色同样要告警并留下降级事实。
        for (const entry of group.slice(1)) {
          const requested = downgradeRole(entry.config, typeof entry.resolved.role === 'string' ? entry.resolved.role : entry.config.role, warnOnce)
          if (requested !== undefined && message.source.requestedRole === undefined) {
            message.source = { ...message.source, requestedRole: requested }
          }
        }
        if (new Set(group.map((entry) => entry.config.position)).size > 1) {
          warnOnce(`${name}: merged group mixes positions — using ${String(base.config.position)} from the first config`)
        }
      }
      planned.push({ position: base.config.position, message, group })
    }

    // 同位置批量插入:planned 已按 order 升序,多元素 splice/unshift/push 保持该顺序。
    // 去重记账不在这里：候选被外层门控剥离时也必须保持「未投递」，由 confirmDelivered 确认。
    const markGroup = (group) => {
      for (const entry of group) scope.stWorldBook.commit?.(entry.config)
    }
    const beforeAll = planned.filter((item) => item.position === 'before-all')
    const afterUser = planned.filter((item) => item.position !== 'before-all' && item.position !== 'after-all')
    const afterAll = planned.filter((item) => item.position === 'after-all')
    if (beforeAll.length > 0) {
      // 混合动作把注入切成多批；继续排在此前仍存活的同位置消息之后。
      const index = options.placement === undefined ? 0 : messages.findLastIndex(message => options.placement.beforeAll.has(message)) + 1
      messages.splice(index, 0, ...beforeAll.map((item) => item.message))
      for (const item of beforeAll) options.placement?.beforeAll.add(item.message)
      for (const item of beforeAll) markGroup(item.group)
      changed = true
    }
    const userIndex = messages.findIndex((item) => item?.source?.kind === 'user')
    if (afterUser.length > 0 && userIndex >= 0) {
      const last = options.placement === undefined ? -1 : messages.findLastIndex(message => options.placement.afterUser.has(message))
      messages.splice(Math.max(userIndex, last) + 1, 0, ...afterUser.map((item) => item.message))
      for (const item of afterUser) options.placement?.afterUser.add(item.message)
      for (const item of afterUser) markGroup(item.group)
      changed = true
    }
    if (afterAll.length > 0) {
      messages.push(...afterAll.map((item) => item.message))
      for (const item of afterAll) markGroup(item.group)
      changed = true
    }

    return changed ? { ...decision, messages } : decision
  } catch (error) {
    warnOnce(`${name}: prompt config failed, skipping: ${String((error && error.message) || error)}`)
    return decision
  }
}

/**
 * 把一组运行时提示词配置装配为注入执行器（独立模式 / 协调器管理模式的接线口）。
 *
 * @param options.prepend 是否以 prepend 注册本地 pre-step(合并行恒 true;由参数决定)。
 * @param options.sourceId 协调器里的来源 id(默认取首条配置 id 派生)。
 * @param options.officialInstructions 本 mount 的组合是否仍挂着官方指令加载行
 *   (负责人冲突事实;协调器据此拒绝同时注入文件正文)。
 */
function effectivePromptConfigs(configs) {
  const list = configs.filter((config) => config !== undefined && config !== null)
  const claimedGroups = new Set()
  return list.filter((config) => {
    if (config.enabled === false) return false
    if (config.group !== undefined && config.exclusive === true) {
      if (claimedGroups.has(config.group)) return false
      claimedGroups.add(config.group)
    }
    return true
  })
}

/** 多模块仍各自拥有来源/互斥组；只有非 pre-step 层汇总接线，避免模块块状执行。 */
export function applyPromptConfigSources(ctx, sources, options = {}) {
  const selected = sources.map(source => ({ ...source, configs: effectivePromptConfigs(source.configs) }))
  const releases = selected.map(source => applyPromptConfigs(ctx, source.configs, { ...options, ...source, layers: false }))
  const releaseLayers = options.layers === false ? () => {} : wireLayers(ctx, selected.flatMap(source => source.configs)
    .filter(config => config.layer !== 'pre-step'), createWarnOnce(ctx, name))
  return () => {
    for (const release of releases) release()
    releaseLayers()
  }
}

export function applyPromptConfigs(ctx, configs, options = {}) {
  const list = configs.filter((config) => config !== undefined && config !== null)
  const sourceId = typeof options.sourceId === 'string' && options.sourceId.length > 0
    ? options.sourceId
    : `preset:${String(list[0]?.id ?? 'unknown')}`
  // 互斥组仍在本来源内筛选；空来源也保留协调器迟到/HMR 接管。
  const effectiveList = effectivePromptConfigs(list)
  const injectedMemo = new Map()
  const main = createEpochPromotion(PROMOTE_EVENTS.either, { includeSubagents: false })
  const withSubagents = createEpochPromotion(PROMOTE_EVENTS.either, { includeSubagents: true })
  const observerDisposer = ctx.on('session/event', (session, event) => {
    main.observe(session, event)
    withSubagents.observe(session, event)
    // 独立路径的去重记账：只有宿主真正持久化的注入消息才确认投递（门控剥离的候选不算）。
    confirmDelivered(injectedMemo, session, event)
  })

  const warnOnce = createWarnOnce(ctx, name)
  const prepend = options.prepend === true || list.some((config) => config.prepend === true)
  const promotion = { main, withSubagents }
  const source = {
    configs: effectiveList,
    ruleActions: options.ruleActions ?? [],
    officialInstructions: options.officialInstructions === true,
  }
  /** 已交给协调器的注册(仅管理路径非空)。 */
  let registration = null
  const releaseRegistration = () => {
    if (registration === null) return
    const dispose = registration
    registration = null
    try {
      dispose()
    } catch {
      // 协调器自身已释放:忽略。
    }
  }
  let active = true
  /** 释放本执行器：失效来源不再注入，也不再向新协调器重新注册。 */
  const release = () => {
    active = false
    releaseRegistration()
    injectedMemo.clear()
  }
  keepDisposer(ctx, release)

  // 非 pre-step 提示词配置接入各自声明的官方层级通道(system-section /
  // runtime-context / agent-request / llm-stream / tool-pipeline)。
  const releaseLayers = options.layers === false ? () => {}
    : wireLayers(ctx, effectiveList.filter((config) => config.layer !== 'pre-step'), warnOnce)

  // 协调器已在（正常装配顺序：插件先加载、预设后挂载）时立即登记来源；
  // 迟到/消失由下面的监听器按「先撤旧再启新」处理。
  let registeredCoordinator = coordinatorOf(ctx)
  if (registeredCoordinator !== undefined) {
    registration = registeredCoordinator.registerPreset(ctx, sourceId, source) ?? null
  }

  const preStepDisposer = ctx.on('agent/pre-step', async (payload, next) => {
    // waterfall 可已捕获随后被释放的回调；失效来源不得向新协调器重新注册。
    if (!active) return next()
    const coordinator = coordinatorOf(ctx)
    // HMR 可在相邻两步之间替换服务：旧句柄非空不代表仍向当前实例注册。
    if (coordinator !== registeredCoordinator) {
      releaseRegistration()
      if (coordinator === undefined) {
        warnOnce(`${name}: pre-step coordinator unavailable, resuming standalone execution`)
      }
      registeredCoordinator = coordinator
    }
    if (coordinator !== undefined) {
      // 管理路径:先登记本来源,再交出唯一执行权(本监听器不再注入)。
      if (registration === null) registration = coordinator.registerPreset(ctx, sourceId, source) ?? null
      return next()
    }
    const decision = await next()
    if (!active) return decision
    return runPreStepBatch({
      ctx,
      payload,
      agent: payload?.agent,
      decision,
      configs: effectiveList,
      ruleActions: source.ruleActions,
      promotion,
      memo: injectedMemo,
      warnOnce,
      // 诊断上报是只读旁路，缺省 undefined 即零开销（见 ruleFrame 的 onOutcome）。
      onOutcome: options.onOutcome,
    })
  }, { prepend })
  // 释放边界：先摘监听器，再撤层级注册，最后丢弃去重快路径（顺序与 keepDisposer 内的 release 一致）。
  return () => {
    release()
    try {
      preStepDisposer()
    } catch {
      // 宿主已释放该 fiber 时监听器可能已不在：忽略。
    }
    try {
      observerDisposer()
    } catch {
      // 同上。
    }
    releaseLayers()
  }
}
