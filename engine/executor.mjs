/**
 * executor — pre-step 消息批执行器。
 * 职责:过滤(层/子代理/模型/晋升)→ resolve → 插值 → 去重/合并 → 落位插入。
 * 任一提示词配置失败只跳过该提示词配置并 warnOnce,绝不让注入 bug 卡死会话。
 */

import {
  PROMOTE_EVENTS,
  createWarnOnce,
  isDelegated,
  matchesModel,
  newMessageId,
} from './shared.mjs'
import { interpolateVariables } from './interpolate.mjs'
import { createEpochPromotion } from './compaction-epoch.mjs'
import { wireLayers } from './layers.mjs'
import { sessionVarsSnapshot } from './session-vars.mjs'

const name = 'prompt-config-engine'

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
  return (Array.isArray(session.events) ? session.events : []).some((event) => {
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

/** 构造默认 user/assistant 消息;策略返回完整 patch 时覆盖对应字段。 */
function buildMessage(config, resolved) {
  const text = typeof resolved.text === 'string' ? resolved.text : ''
  const defaultContent = config.texts.length > 0
    ? config.texts.map((item) => ({ type: 'text', text: item }))
    : [{ type: 'text', text }]
  const sourceValue = mergedIdentity(config)
  return {
    id: typeof resolved.id === 'string' && resolved.id.length > 0 ? resolved.id : newMessageId(config.id),
    role: typeof resolved.role === 'string' ? resolved.role : config.role,
    content: Array.isArray(resolved.content) ? resolved.content : defaultContent,
    source: resolved.source !== null && typeof resolved.source === 'object'
      ? resolved.source
      : {
          kind: config.sourceKind,
          plugin: sourceValue,
          ...(typeof config.form === 'string' ? { form: config.form } : {}),
          ...(typeof config.summary === 'string' && config.summary.length > 0 ? { summary: config.summary } : {}),
        },
  }
}

/** 按提示词配置声明的插入位置写入消息批;找不到插入锚点返回 false(本提示词配置跳过)。 */
function insertMessage(config, messages, message) {
  if (config.position === 'before-all') {
    messages.unshift(message)
    return true
  }
  if (config.position === 'after-all') {
    messages.push(message)
    return true
  }
  // 默认 after-user:只锚真实用户消息,插件消息不算。
  const userIndex = messages.findIndex((item) => item?.source?.kind === 'user')
  if (userIndex < 0) return false
  messages.splice(userIndex + 1, 0, message)
  return true
}

/**
 * 把一组运行时提示词配置装配为注入执行器。
 * @param prepend 是否以 prepend 注册 pre-step(合并行恒 true;单条提示词配置兼容层由参数决定)。
 */
export function applyPromptConfigs(ctx, configs, options = {}) {
  const list = configs.filter((config) => config !== undefined && config !== null)
  if (list.length === 0) return
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

  /** 每提示词配置每会话的进程内快路径;真相在持久事件流。 */
  // ponytail: 会话数上限防无界增长（Set 按 session.id 累积）；若需精确淘汰改 LRU。
  const MAX_MEMO_SESSIONS = 4096
  const injectedMemo = new Map()
  const configMemo = (config) => {
    let memo = injectedMemo.get(config.id)
    if (memo === undefined) {
      if (injectedMemo.size >= MAX_MEMO_SESSIONS) injectedMemo.clear()
      memo = new Set()
      injectedMemo.set(config.id, memo)
    }
    return memo
  }

  const warnOnce = createWarnOnce(ctx, name)
  const prepend = options.prepend === true || list.some((config) => config.prepend === true)

  // 非 pre-step 提示词配置接入各自声明的官方层级通道(system-section /
  // runtime-context / agent-request / llm-stream / tool-pipeline)。
  wireLayers(ctx, effectiveList.filter((config) => config.layer !== 'pre-step'), warnOnce)

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    try {
      if (decision.kind === 'reject') return decision
      if (agent === undefined) return decision
      const session = agent.session
      if (session === undefined) return decision

      const messages = Array.isArray(decision.messages) ? [...decision.messages] : []
      let changed = false

      const due = []
      for (const config of effectiveList) {
        try {
          if (config.layer !== 'pre-step') continue
          const delegated = isDelegated(session)
          if (config.audience === 'main' && delegated) continue
          if (config.audience === 'subagent' && !delegated) continue
          if (!matchesModel(config.modelScope, agent.options?.model)) continue
          if (config.promotion === 'main' && !main.status(agent).promoted) continue
          if (config.promotion === 'include-subagents' && !withSubagents.status(agent).promoted) continue

          const memo = configMemo(config)
          if (config.dedupe === 'session') {
            if (memo.has(session.id) || hasInjected(config, session)) {
              memo.add(session.id)
              continue
            }
          } else if (config.dedupe === 'batch' && hasInBatch(config, messages)) {
            continue
          }

          const resolved = await config.resolve({ ctx, agent, session, decision, messages })
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
          if (typeof patched.text === 'string') {
            // 提示词配置级模板变量 + filler 变量 + 内置环境变量插值。
            patched.text = interpolateVariables(patched.text, mergedVars, session)
          }
          if (config.texts.length > 0) {
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
        const message = buildMessage(base.config, base.resolved)
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
          if (new Set(group.map((entry) => entry.config.position)).size > 1) {
            warnOnce(`${name}: merged group mixes positions — using ${String(base.config.position)} from the first config`)
          }
        }
        planned.push({ position: base.config.position, message, group })
      }

      // 同位置批量插入:planned 已按 order 升序,多元素 splice/unshift/push 保持该顺序。
      const markGroup = (group) => {
        for (const entry of group) {
          if (entry.config.dedupe === 'session') configMemo(entry.config).add(session.id)
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
  }, { prepend })
}
