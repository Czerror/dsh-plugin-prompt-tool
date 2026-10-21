/**
 * executor — pre-step 消息批执行器。
 * 职责:过滤(层/子代理/模型/晋升)→ resolve → 插值 → 去重/合并 → 落位插入。
 * 任一提示词配置失败只跳过该提示词配置并 warnOnce,绝不让注入 bug 卡死会话。
 *
 * 装配路径有两条，批执行算法只有一份（runPreStepBatch）：
 *   - 管理路径：宿主 prompt-tool 插件提供 pre-step 协调服务（服务名见 `service-names.mjs`）时，本来源
 *     （预设 mount）把配置注册给协调器，由协调器统一执行各预设来源；官方指令正文的
 *     逐文件过滤归协调器的 prepend 监听器，旧生成卡的 `agents-file-*` 按 id 前缀跳过；
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
} from './shared.mjs'
// 去重判据读**当前模型可见上下文**（视图①），不读完整历史：被压缩遮蔽的注入要重新注入。
import { eventMessage, moduleIdOf, moduleOf, pluginIdentityOf, identityOf, identityStampOf, identityHit, injectedMessage, actionStamp, findActionDelivery } from './delivery.mjs'
import { interpolateVariables } from './interpolate.mjs'
import { createEpochPromotion } from './compaction-epoch.mjs'
import { wireLayers } from './layers.mjs'
import { renderTemplate } from './template-frame.mjs'
import { selectContextActivation } from './context-activation.mjs'
import { compareConfigSequence } from './order.mjs'
import { ruleFrame, actionMatches } from './conditions/evaluation.mjs'
import { composePreStepSources, promotionOwnerOf } from './pre-step-source.mjs'
// 标记键名与「已登记进 config 白名单」同源（schema.mjs），此处不另写字面量。
import { SESSION_VARIABLES_DISABLED } from './schema.mjs'
import { PRE_STEP_COORDINATOR_SERVICE } from './service-names.mjs'

const name = 'prompt-config-engine'

/**
 * 「已确认投递」快路径的条目上限。真相是**当前上下文扫描**（见 injectedMessage）：
 * 这份 memo 只省一次扫描，丢了只是多扫一次，清空不改变任何判定结果，也不再需要淘汰策略。
 */
// shortcut: 上限防无界增长（Map 按「身份 × 代次」累积）；若需精确淘汰改 LRU。
const MAX_MEMO_CONFIGS = 4096

/**
 * 查询宿主 prompt-tool 插件的 pre-step 协调服务（ctx.get 跨 fiber 解析）。
 * 缺失/形状不符时返回 undefined：本行回退独立执行路径。
 */
function coordinatorOf(ctx) {
  const service = getService(ctx, PRE_STEP_COORDINATOR_SERVICE)
  return service !== null && typeof service === 'object' && typeof service.registerPreset === 'function'
    ? service
    : undefined
}

/** 当前消息批内是否已有该提示词配置注入(每轮去重)。 */
function hasInBatch(config, messages) {
  const value = identityOf(config)
  return messages.some((message) => identityHit(message?.source, config, value))
}

/**
 * 快路径条目键：通道 + 模块维 + 有效期戳 + 值。分隔符用 NUL（身份值里可能带 `:`）。
 *
 * 位置替换与内容投影的代次共同组成戳；任一变化都重新查询当前可见投递。
 * 无 surface（降级到完整历史）时戳恒为 `-`：完整历史不会丢事件，条目一直有效。
 */
function memoKey(field, moduleId, value, stamp) {
  // 戳不可用（null）时调用方不查也不记。
  return `${field}\u0000${moduleId ?? ''}\u0000${stamp}\u0000${value}`
}

/**
 * 本会话当前可见上下文的代次戳，也是 memo 键的失效维。
 *
 * - 代次对：surface 的 `replaceGeneration:contentGeneration`；
 * - `'-'`：无 surface（降级到完整历史），事件不会消失，条目一直有效；
 * - `null`：**有 `surface.nodes` 却没有数字代次** —— memo 此时不可用：代次是它唯一的失效
 *   信号，而真相（`currentEvents`）仍跟着 `nodes` 走，快路径会把被压缩移走的注入永久记成
 *   「已投递」。这种宿主形态是真实情形（恢复、重放、其它宿主、既有桩；见
 *   `compaction-epoch.mjs` 的失效条件③），调用方据此跳过 memo、退回当前上下文扫描
 *   —— memo 只是省一次扫描的缓存，跳过不改变任何判定结果。
 */
function contextStamp(session) {
  const generation = session?.surface?.replaceGeneration
  if (typeof generation === 'number') return `${generation}:${session.surface.contentGeneration ?? 0}`
  return Array.isArray(session?.surface?.nodes) ? null : '-'
}

/**
 * 按投递身份取「已确认投递」的会话集合 —— 纯性能缓存（省一次当前上下文扫描），
 * **不是**真相：条目可随时丢弃（上限、`release()`、`clear()`），丢了只多扫一次。
 *
 * 记账只发生在宿主真正接纳并持久化该消息之后（见 confirmDelivered）：候选在瀑布外层被
 * 门控/策略剥离时不算已投递，否则晋升后（门控放行时）正文会永久缺失。
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
 * plugin（本引擎身份，merged 组用 merged:<position>）、kind（外来通道，如
 * context-gate 的 instruction-hint）与消息的模块维都以会话为界记账，
 * 与 identityHit 的三元组判据一致。
 */
export function confirmDelivered(memo, session, event) {
  if (memo === null || memo === undefined || session === null || session === undefined) return
  const source = eventMessage(event)?.source
  if (source === null || typeof source !== 'object') return
  const moduleId = moduleOf(source)
  const stamp = contextStamp(session)
  // 戳不可用 → 不记账：这条快路径无法在视图变化时失效，判定改由当前上下文扫描给出。
  if (stamp === null) return
  for (const field of ['plugin', 'kind']) {
    const value = source[field]
    if (typeof value !== 'string' || value.length === 0) continue
    deliveredSessions(memo, memoKey(field, moduleId, value, stamp)).add(session.id)
  }
  // v4 起生产者身份挂在 kind（`plugin:<name>`），旧日志才有 plugin 字段；
  // 两种形态都补记到 plugin: 账本，alreadyDelivered 的 `confirmed('plugin', …)` 才不会漏。
  const plugin = pluginIdentityOf(source)
  if (plugin !== undefined && source.plugin === undefined) {
    deliveredSessions(memo, memoKey('plugin', moduleId, plugin, stamp)).add(session.id)
  }
}

/** dedupe=session：本会话**当前上下文**里是否已有该身份的已确认投递（快路径 + 当前上下文真相）。 */
function alreadyDelivered(config, session, memo) {
  if (config.linkedDelivery) return config.mergeMode === 'merged'
    ? injectedMessage(config, session) !== undefined : findActionDelivery(session, config) !== undefined
  const stamp = contextStamp(session)
  // 模块维有两种命中：本模块的键，以及升级前注入（无模块维）那份的保守键。
  const modules = [moduleIdOf(config, 'sourceModuleId') ?? '', '']
  // 戳不可用（有 surface 却无代次）→ 不查 memo：那里记的「已投递」可能已被视图改写。
  const confirmed = (field, value) => stamp !== null && modules.some((moduleId) =>
    memo.get(memoKey(field, moduleId, value, stamp))?.has(session.id) === true)
  if (confirmed('plugin', identityOf(config))) return true
  if (typeof config.sourceKind === 'string' && confirmed('kind', config.sourceKind)) return true
  const message = injectedMessage(config, session)
  if (message === undefined) return false
  // 慢路径命中即按既有入口回填快路径（真相仍是当前上下文，不直接写 memo）：
  // 无 id 的会话不记账——memo 的键就是 session.id，记了会让两个无 id 会话串味。
  if (session.id !== undefined) confirmDelivered(memo, session, { data: { message } })
  return true
}

/**
 * pre-step 唯一可发出角色：宿主把本批消息逐条写成 `user/message` 事件，事件校验要求
 * `role === 'user'`（assistant 只能由模型侧 assistant/message 事件产生）。
 */
const PRE_STEP_ROLE = 'user'

/**
 * 记录一次角色降级：保留原角色、明确告警、不改正文，也不把非法值传给宿主。
 * 同一句告警只记一次（warnOnce 按消息去重），且不记录正文或用户内容。
 */
function downgradeRole(config, requested, warnOnce) {
  if (typeof requested !== 'string' || requested === PRE_STEP_ROLE) return undefined
  warnOnce(`${name}: config ${String(config?.id ?? '<unknown>')} role ${JSON.stringify(requested)} cannot be injected in pre-step, message downgraded to "${PRE_STEP_ROLE}"`)
  return requested
}

/** 构造默认 user 消息;策略返回完整 patch 时覆盖对应字段,但非法角色在出口兜底降级。 */
function buildMessage(config, resolved, warnOnce, session) {
  const text = typeof resolved.text === 'string' ? resolved.text : ''
  const defaultContent = config.texts.length > 0
    ? config.texts.map((item) => ({ type: 'text', text: item }))
    : [{ type: 'text', text }]
  // 盖章身份与 alreadyDelivered 的查找键同源（identityOf）：显式 identity 才真正共享去重，
  // 也不会与他卡的 id 误撞；merged 组 identityOf 本就等于 mergedIdentity，存量输出不变。
  const sourceValue = identityOf(config)
  // 策略 patch（templateFile 的 role 等）与配置声明都必须经过同一出口判定。
  const requested = downgradeRole(config, typeof resolved.role === 'string' ? resolved.role : config.role, warnOnce)
  // 模块维与 `identityStampOf` 同源（`moduleIdOf`：空串与缺失同等）：两条分支必须盖同一份章，
  // 否则解析器自带 source 的消息比合成分支多带一个空模块维，memo 与判定就会分叉。
  const moduleId = moduleIdOf(config, 'sourceModuleId')
  const source = resolved.source !== null && typeof resolved.source === 'object'
    // 解析器自带的 source 也要盖章：否则这类消息（如 fill=instruction-hint 的
    // `{ kind: 'instruction-hint' }`）只带 kind 通道，dedupe=session 每步重复注入。
    // 解析器自带的 kind 优先（缺省 kind 只在它缺席时补），plugin 只在其非空时覆盖身份。
    ? {
        ...resolved.source,
        plugin: typeof resolved.source.plugin === 'string' && resolved.source.plugin.length > 0 ? resolved.source.plugin : sourceValue,
        ...(resolved.source.kind === undefined ? { kind: identityStampOf({ ...config, sourceKind: undefined }).kind } : {}),
        ...(moduleId === undefined ? {} : { moduleId }),
      }
    : {
        // 模块维是身份判据的新一维，但**不并进身份字符串**：`source.plugin` 的格式是
        // blockPlugins 的精确匹配契约，一字不改；整模块复制的区分只靠这个独立字段。
        ...identityStampOf(config),
        ...(typeof config.form === 'string' ? { form: config.form } : {}),
        ...(typeof config.summary === 'string' && config.summary.length > 0 ? { summary: config.summary } : {}),
      }
  return {
    id: typeof resolved.id === 'string' && resolved.id.length > 0 ? resolved.id : newMessageId(config.id),
    role: PRE_STEP_ROLE,
    content: Array.isArray(resolved.content) ? resolved.content : defaultContent,
    source: { ...source, ...actionStamp(config, session), ...(requested === undefined ? {} : { requestedRole: requested }) },
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
  const messages = Array.isArray(decision.messages) ? [...decision.messages] : []
  const { main, withSubagents } = promotion
  const delegated = isDelegated(session)
  // 本批资格判定（唯一实现）：层通道、受众、模型、晋升与 live 规则条件。
  // 条件判定放在去重之前：未命中的配置不算「已注入」，条件恢复后仍应能注入。
  // ST 模板的跨配置变量帧按 order 预求值，但只有这里的获准集合才允许产生副作用
  // （未命中的 setter 提前 setvar 会污染同批 reader）——渲染器不再复制判定。
  const qualified = configs.filter((config) => config.layer === 'pre-step'
    && !(config.audience === 'main' && delegated)
    && !(config.audience === 'subagent' && !delegated)
    && matchesModel(config.modelScope, agent.options?.model)
    && (config.promotion !== 'main' || main.status(agent).promoted)
    && (config.promotion !== 'include-subagents' || withSubagents.status(agent).promoted)
    && actionMatches(config, frame))
  return {
    qualified: new Set(qualified),
    contextActivation: selectContextActivation(qualified, session, messages, warnOnce, config => config[SESSION_VARIABLES_DISABLED] === true
      ? { module: {}, global: {} } : config.variableStore?.read(config.sourceModuleId) ?? { module: config.variables, global: {} }),
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
 * @param options.memo 已确认投递身份的进程内 session 去重快路径（纯缓存，丢了只多一次
 *   当前上下文扫描；见 confirmDelivered）。
 * @returns 注入后的 decision；reject、缺 agent/session、全部跳过或异常时原样返回。
 */
export async function runPreStepBatch(options) {
  if (!Array.isArray(options.sources)) {
    throw new TypeError('runPreStepBatch requires a sources array')
  }
  const sources = options.sources
  const composed = composePreStepSources(sources)
  if (composed.configs.length === 0 && composed.ruleActions.length === 0) return options.decision
  const ctx = options.ctx ?? sources[0]?.ctx
  const initialFrame = options.ruleFrame ?? ruleFrame('agent/pre-step', [{ agent: options.agent, messages: options.decision?.messages ?? [] }], options.warnOnce, ctx, composed.report)
  // 批级快照与单配置失败同款 fail-safe：资格判定或 ST 世界书选择抛错时只告警一次并跳过本步
  // 注入（scope 留空 → runPromptConfigBatch 原样返回 decision），绝不把异常抛进
  // agent/pre-step waterfall。世界书键的 `interpolateVariables` 在 selectStWorldBook 的
  // per-config try 之外，配置错误不得卡死会话。
  const batchOptions = { ...options, ...composed, ctx }
  let scope
  try {
    scope = batchScope(batchOptions, initialFrame)
  } catch (error) {
    options.warnOnce?.(`${name}: prompt config failed, skipping: ${String((error && error.message) || error)}`)
  }
  // 同一批的配置与动作按配置序号统一排序；没有规则动作时也必须排，不能依赖来源注册顺序。
  const orderedConfigs = [...composed.configs].sort(compareConfigSequence)
  if (composed.ruleActions.length === 0) {
    return runPromptConfigBatch({ ...batchOptions, configs: orderedConfigs, ruleFrame: initialFrame, scope })
  }
  const entries = [...orderedConfigs.map(config => ({ ...config, config })), ...composed.ruleActions].sort(compareConfigSequence)
  let decision = options.decision
  if (decision?.kind === 'reject') return decision
  let pending = []
  const placement = { beforeAll: new Set(), afterUser: new Set() }
  const flush = async () => {
    if (pending.length) decision = await runPromptConfigBatch({ ...batchOptions, decision, configs: pending, ruleFrame: initialFrame, placement, scope })
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
        if (config.position === 'after-user' && !messages.some(message => message?.source?.kind === 'user')) {
          warnOnce(`${name}: after-user config(s) ${config.id} skipped this batch — no user message anchor`)
          continue
        }

        if (config.dedupe === 'session') {
          if (alreadyDelivered(config, session, memo)) continue
        } else if (config.dedupe === 'batch' && hasInBatch(config, messages)) {
          continue
        }

        const signal = options.payload?.signal
        if (signal?.aborted) continue
        const resolved = await config.resolve({ ctx, agent, session, signal, decision, messages, contextActivationSelected: scope.contextActivation.has(config) })
        if (signal?.aborted) continue
        if (resolved === null || resolved === undefined) continue
        const patched = { ...resolved }
        // 按来源读取最新持久值；无变量正文不因另一个坏候选的读盘失败撤回。
        const mergedVars = {
          ...(config[SESSION_VARIABLES_DISABLED] === true ? {} : config.params?.templateEvaluation !== true && [patched.text, ...config.texts].some(text => typeof text === 'string' && text.includes('{{'))
            ? config.variableStore?.read(config.sourceModuleId).effective ?? config.variables : config.variables),
          ...(resolved.variables !== null && typeof resolved.variables === 'object' ? resolved.variables : {}),
        }
        if (config.params?.templateEvaluation === true) {
          patched.text = renderTemplate({ ...config, texts: config.texts.length ? config.texts : [patched.text ?? ''] }, { agent, signal }, { enabled: config[SESSION_VARIABLES_DISABLED] !== true, warn: warnOnce })
          patched.content = patched.text.length > 0 ? [{ type: 'text', text: patched.text }] : []
        } else if (typeof patched.text === 'string') {
          // 提示词配置级模板变量 + filler 变量 + 内置环境变量插值。
          // 第 5 参是模板位置身份（本配置的 id）：{{pick}} 的 seed 只认「同会话 + 同模板位置 + 同一次出现」，
          // 缺省空串会让不同配置的首个 pick 退化成同一个 seed。
          patched.text = interpolateVariables(patched.text, mergedVars, session, undefined, config.id)
        }
        if (config.texts.length > 0 && config.params?.templateEvaluation !== true) {
          const blocks = config.texts
            .map((item, index) => interpolateVariables(item, mergedVars, session, undefined, `${config.id}#${index}`))
            .filter((item) => item.length > 0)
            .map((item) => ({ type: 'text', text: item }))
          patched.content = blocks
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
      const message = buildMessage(base.config, base.resolved, warnOnce, agent.session)
      if (group.length > 1) {
        message.content = group.flatMap((entry) => {
          if (Array.isArray(entry.resolved.content)) return entry.resolved.content
          return typeof entry.resolved.text === 'string' && entry.resolved.text.length > 0
            ? [{ type: 'text', text: entry.resolved.text }]
            : []
        })
        if (message.source !== null && typeof message.source === 'object') {
          message.source = { ...message.source, plugin: identityOf(base.config) }
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
      for (const entry of group) scope.contextActivation.commit?.(entry.config)
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
    if (afterUser.length > 0 && userIndex < 0) {
      // 本批没有真实用户消息可锚定：本步跳过（不记账，next 含 user 的批仍会注入）。不兜底到
      // before-all / after-all —— 「锚点是真实用户消息、不挂到插件消息之后」是插入点契约。
      // 按消息去重后，不同配置组合各记一次，不再互相占名额。
      warnOnce(`${name}: after-user config(s) ${afterUser.map((item) => item.group[0].config.id).join(', ')} skipped this batch — no user message anchor`)
    }
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

/**
 * 唯一的 pre-step 装配入口：来源自带 ctx/onOutcome/promotion，本函数只做固定效果接线、
 * 协调器注册与（无协调器时的）单 listener 批执行。
 *
 * 所有来源必须共享同一个 ctx；没有 promotion 时由协调器或本次调用补一个 fallback owner，
 * 已有 owner 不一致则 fail loud。
 */
export function applyPromptConfigSources(sources, options = {}) {
  if (!Array.isArray(sources) || sources.length === 0) return () => {}
  const ctx = sources[0].ctx
  if (sources.some(source => source.ctx !== ctx)) {
    throw new TypeError('prompt-tool: all pre-step sources in one apply call must share the same ctx')
  }
  const warnOnce = createWarnOnce(ctx, name)
  const selected = sources.map(source => ({ ...source, configs: effectivePromptConfigs(source.configs) }))
  const owner = promotionOwnerOf(selected)
  const coordinator = coordinatorOf(ctx)
  const coordinatorPromotion = coordinator?.promotion
  if (coordinator !== undefined && coordinatorPromotion === undefined) {
    throw new TypeError('prompt-tool: pre-step coordinator v2 must expose a promotion owner')
  }
  if (coordinatorPromotion !== undefined && owner !== undefined && owner !== coordinatorPromotion) {
    throw new TypeError('prompt-tool: pre-step sources must use the active coordinator promotion owner')
  }
  // 执行 owner 唯一：有来源 owner 就用它，否则由本次 apply 建 fallback pair；协调器存在时
  // 批执行与注册统一用协调器 pair，协调器消失/替换时再切回 standalone/新 pair。
  const fallbackBacked = owner === undefined
  const fallbackPromotion = fallbackBacked
    ? {
      main: createEpochPromotion(PROMOTE_EVENTS.either, { includeSubagents: false }),
      withSubagents: createEpochPromotion(PROMOTE_EVENTS.either, { includeSubagents: true }),
    }
    : undefined
  const standalonePromotion = owner ?? fallbackPromotion
  let activePromotion = coordinatorPromotion ?? standalonePromotion
  let prepared = selected.map(source => ({ ...source, promotion: activePromotion }))
  let feedsPromotion = fallbackBacked && activePromotion === fallbackPromotion
  // 先验证固定效果的目标并完成 owner 解析；owner 不一致时不能留下 wireLayers 监听。
  const releaseLayers = options.layers === false ? () => {} : wireLayers(ctx, selected.flatMap(source => source.configs)
    .filter(config => config.layer !== 'pre-step'), warnOnce, { agent: options.agent })
  const injectedMemo = new Map()
  const observerDisposer = ctx.on('session/event', (session, event) => {
    if (feedsPromotion) {
      activePromotion.main.observe(session, event)
      activePromotion.withSubagents.observe(session, event)
    }
    confirmDelivered(injectedMemo, session, event)
  })
  const prepend = options.prepend === true || prepared.some(source => source.configs.some(config => config.prepend === true))
  const registrations = new Map()
  let active = true
  const releaseRegistrations = () => {
    for (const dispose of registrations.values()) {
      try { dispose() } catch {}
    }
    registrations.clear()
  }
  const setOwner = (promotion) => {
    activePromotion = promotion
    feedsPromotion = fallbackBacked && promotion === fallbackPromotion
    prepared = selected.map(source => ({ ...source, promotion }))
  }
  const registerAll = (target) => {
    try {
      for (const source of prepared) {
        if (registrations.has(source.sourceId)) throw new TypeError(`prompt-tool: duplicate pre-step sourceId ${source.sourceId}`)
        registrations.set(source.sourceId, target.registerPreset(source.sourceId, source) ?? (() => {}))
      }
    } catch (error) {
      releaseRegistrations()
      throw error
    }
  }
  let registeredCoordinator = coordinator
  if (coordinator !== undefined) {
    try {
      registerAll(coordinator)
    } catch (error) {
      try { observerDisposer() } catch {}
      releaseLayers()
      throw error
    }
  }
  const preStepDisposer = ctx.on('agent/pre-step', async (payload, next) => {
    if (!active) return next()
    const current = coordinatorOf(ctx)
    if (current !== registeredCoordinator) {
      releaseRegistrations()
      if (current === undefined) {
        warnOnce(`${name}: pre-step coordinator unavailable, resuming standalone execution`)
        setOwner(standalonePromotion)
      } else {
        if (current.promotion === undefined) {
          warnOnce(`${name}: pre-step coordinator v2 owner unavailable, keeping standalone execution`)
          setOwner(standalonePromotion)
        } else {
          setOwner(current.promotion)
        }
      }
      registeredCoordinator = current
    }
    if (current !== undefined && current.promotion !== undefined) {
      if (registrations.size === 0) registerAll(current)
      return next()
    }
    const decision = await next()
    if (!active) return decision
    return runPreStepBatch({
      sources: prepared,
      ctx,
      payload,
      agent: payload?.agent,
      decision,
      memo: injectedMemo,
      warnOnce,
    })
  }, { prepend })
  const release = () => {
    active = false
    releaseRegistrations()
    injectedMemo.clear()
  }
  keepDisposer(ctx, release)
  return () => {
    release()
    try { preStepDisposer() } catch {}
    try { observerDisposer() } catch {}
    releaseLayers()
  }
}
