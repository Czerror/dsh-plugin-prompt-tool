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

const name = 'prompt-config-engine'

/** 每提示词配置每会话的进程内快路径上限;真相在持久事件流。 */
// ponytail: 配置条数上限防无界增长（Map 按 config.id 累积）；若需精确淘汰改 LRU。
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

function hasInjected(config, session) {
  const value = config.mergeMode === 'merged' ? mergedIdentity(config) : config.identity.value
  return sessionEvents(session).some((event) => {
    const message = eventMessage(event)
    // 双通道去重：kind（外来/第三方消息，如 context-gate 的 instruction-hint）或
    // plugin（本引擎注入的命名空间，merged 组用 merged:<position>）。
    return message?.source?.kind === config.sourceKind || message?.source?.plugin === value
  })
}

/** 当前消息批内是否已有该提示词配置注入(每轮去重)。 */
function hasInBatch(config, messages) {
  const value = config.mergeMode === 'merged' ? mergedIdentity(config) : config.identity.value
  return messages.some((message) =>
    message?.source?.kind === config.sourceKind || message?.source?.plugin === value)
}

/** 按提示词配置 id 取会话去重快路径集合；超限时整体清空（真相在持久事件流）。 */
function configMemo(memo, config) {
  let set = memo.get(config.id)
  if (set === undefined) {
    if (memo.size >= MAX_MEMO_CONFIGS) memo.clear()
    set = new Set()
    memo.set(config.id, set)
  }
  return set
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
  const sourceValue = mergedIdentity(config)
  // 策略 patch（templateFile 的 role 等）与配置声明都必须经过同一出口判定。
  const requested = downgradeRole(config, typeof resolved.role === 'string' ? resolved.role : config.role, warnOnce)
  const base = resolved.source !== null && typeof resolved.source === 'object'
    ? resolved.source
    : {
        kind: config.sourceKind,
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
 * 批执行算法(单一实现):过滤(层/子代理/模型/晋升)→ resolve → 插值 →
 * 去重/合并 → 落位插入。
 *
 * 预设卡与独立指令文件卡共用这条路径，身份空间互不覆盖；文件来源的候选资格由
 * 调用方(协调器)按可见状态先行判定，这里只按各卡自身声明的策略执行。文件正文以
 * content 块返回(不填 config.texts)，因此不经过预设变量插值。
 *
 * @param options.configs 已过滤 enabled 与互斥组的最终提示词配置列表。
 * @param options.promotion { main, withSubagents } 晋升追踪器(真相在持久事件流)。
 * @param options.memo 按提示词配置 id 的进程内 session 去重快路径。
 * @returns 注入后的 decision；reject、缺 agent/session、全部跳过或异常时原样返回。
 */
export async function runPreStepBatch(options) {
  const { ctx, agent, decision, configs, promotion, memo, warnOnce } = options
  if (decision === null || typeof decision !== 'object') return decision
  if (decision.kind === 'reject') return decision
  if (agent === undefined) return decision
  const session = agent.session
  if (session === undefined) return decision
  const { main, withSubagents } = promotion
  try {
    const messages = Array.isArray(decision.messages) ? [...decision.messages] : []
    // 条件判定的匹配对象在本批进入时取定：批次内后续注入不改变本批的判定依据。
    const userText = userMessagesText(messages)
    let changed = false

    const due = []
    const stWorldBook = selectStWorldBook(configs.filter(config => config.layer === 'pre-step'
      && !(config.audience === 'main' && isDelegated(session)) && !(config.audience === 'subagent' && !isDelegated(session))
      && matchesModel(config.modelScope, agent.options?.model)
      && (config.promotion !== 'main' || main.status(agent).promoted)
      && (config.promotion !== 'include-subagents' || withSubagents.status(agent).promoted)
      && conditionHit(config, { userText })), session, messages, warnOnce)
    for (const config of configs) {
      try {
        if (config.layer !== 'pre-step') continue
        const delegated = isDelegated(session)
        if (config.audience === 'main' && delegated) continue
        if (config.audience === 'subagent' && !delegated) continue
        if (!matchesModel(config.modelScope, agent.options?.model)) continue
        if (config.promotion === 'main' && !main.status(agent).promoted) continue
        if (config.promotion === 'include-subagents' && !withSubagents.status(agent).promoted) continue
        // 条件判定放在去重之前：未命中的配置不算"已注入"，条件恢复后仍应能注入。
        if (!conditionHit(config, { userText })) continue

        const configSessions = configMemo(memo, config)
        if (config.dedupe === 'session') {
          if (configSessions.has(session.id) || hasInjected(config, session)) {
            configSessions.add(session.id)
            continue
          }
        } else if (config.dedupe === 'batch' && hasInBatch(config, messages)) {
          continue
        }

        const resolved = await config.resolve({ ctx, agent, session, decision, messages, stWorldBookSelected: stWorldBook.has(config) })
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
          patched.text = config.renderSt(agent, messages, warnOnce, options)
          patched.content = patched.text.length > 0 ? [{ type: 'text', text: patched.text }] : []
        } else if (typeof patched.text === 'string') {
          // 提示词配置级模板变量 + filler 变量 + 内置环境变量插值。
          patched.text = interpolateVariables(patched.text, mergedVars, session)
        }
        if (config.texts.length > 0 && typeof config.renderSt !== 'function') {
          const blocks = config.texts
            .map((item) => interpolateVariables(item, mergedVars, session))
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

    // order 升序(同值保持声明顺序):决定拼接顺序与同位置插入顺序。
    due.sort((a, b) => a.config.order - b.config.order)

    // merged 模式的多条提示词配置在首条配置的位置合并为一条消息;
    // 文本按内容块拼接,source 身份改用 merged:<position> 以保持持久幂等。
    const orderedGroups = []
    const groupIndex = new Map()
    for (const entry of due) {
      const group = entry.config.mergeMode === 'merged'
        ? mergedIdentity(entry.config)
        : undefined
      if (group === undefined) {
        orderedGroups.push([entry])
        continue
      }
      let index = groupIndex.get(group)
      if (index === undefined) {
        index = orderedGroups.length
        groupIndex.set(group, index)
        orderedGroups.push([])
      }
      orderedGroups[index].push(entry)
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
    const markGroup = (group) => {
      for (const entry of group) {
        stWorldBook.commit?.(entry.config)
        if (entry.config.dedupe === 'session') configMemo(memo, entry.config).add(session.id)
      }
    }
    const beforeAll = planned.filter((item) => item.position === 'before-all')
    const afterUser = planned.filter((item) => item.position !== 'before-all' && item.position !== 'after-all')
    const afterAll = planned.filter((item) => item.position === 'after-all')
    if (beforeAll.length > 0) {
      messages.unshift(...beforeAll.map((item) => item.message))
      for (const item of beforeAll) markGroup(item.group)
      changed = true
    }
    const userIndex = messages.findIndex((item) => item?.source?.kind === 'user')
    if (afterUser.length > 0 && userIndex >= 0) {
      messages.splice(userIndex + 1, 0, ...afterUser.map((item) => item.message))
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
export function applyPromptConfigs(ctx, configs, options = {}) {
  const list = configs.filter((config) => config !== undefined && config !== null)
  const sourceId = typeof options.sourceId === 'string' && options.sourceId.length > 0
    ? options.sourceId
    : `preset:${String(list[0]?.id ?? 'unknown')}`
  // 空 mount 同样保留接管监听：装配事实与协调器迟到/HMR 不依赖是否有预设卡。
  // 互斥组:同一 group 且 exclusive=true 时,只保留排序后第一个 enabled 提示词配置。
  const claimedGroups = new Set()
  const effectiveList = list.filter((config) => {
    if (config.enabled === false) return false
    if (config.group !== undefined && config.exclusive === true) {
      if (claimedGroups.has(config.group)) return false
      claimedGroups.add(config.group)
    }
    return true
  })
  const main = createEpochPromotion(PROMOTE_EVENTS.either, { includeSubagents: false })
  const withSubagents = createEpochPromotion(PROMOTE_EVENTS.either, { includeSubagents: true })
  ctx.on('session/event', (session, event) => {
    main.observe(session, event)
    withSubagents.observe(session, event)
  })

  const injectedMemo = new Map()
  const warnOnce = createWarnOnce(ctx, name)
  const prepend = options.prepend === true || list.some((config) => config.prepend === true)
  const promotion = { main, withSubagents }
  const source = {
    configs: effectiveList,
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
  keepDisposer(ctx, () => {
    active = false
    releaseRegistration()
    injectedMemo.clear()
  })

  // 非 pre-step 提示词配置接入各自声明的官方层级通道(system-section /
  // runtime-context / agent-request / llm-stream / tool-pipeline)。
  wireLayers(ctx, effectiveList.filter((config) => config.layer !== 'pre-step'), warnOnce)

  // 协调器已在（正常装配顺序：插件先加载、预设后挂载）时立即登记来源；
  // 迟到/消失由下面的监听器按「先撤旧再启新」处理。
  let registeredCoordinator = coordinatorOf(ctx)
  if (registeredCoordinator !== undefined) {
    registration = registeredCoordinator.registerPreset(ctx, sourceId, source) ?? null
  }

  ctx.on('agent/pre-step', async (payload, next) => {
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
      agent: payload?.agent,
      decision,
      configs: effectiveList,
      promotion,
      memo: injectedMemo,
      warnOnce,
    })
  }, { prepend })
}
