/**
 * tool-visibility —— 工具可见面：一份声明拥有「模型看得见什么、调得动什么」。
 *
 * 三面投影都在 system-prompt/assemble 的 after-next 之后完成：
 *  1. 装配目录（tools 数组）——本轮的呈现面；
 *  2. tools:sdk 段正文——模型读到的工具声明；
 *  3. 执行面：restrict（继承的全局工具）+ guard（本层注册与晚到工具）。
 *
 * 旧实现把同一个意图拆成三条声明（assembly / sdk-strip / guard），其中 guard 属固定
 * 注册效果、不能带规则级 if，于是「有条件下架」被迫再复制一份名单。这里把名单收在
 * 一个动作里：条件由规则引擎在装配通道逐轮求值，执行闸按当前条件**重挂或撤销**，
 * 因此不再有跨轮粘性。
 *
 * 名单语义对齐官方 ToolRestriction（deepseek-harness packages/core/tools/src/index.ts:701-706）：
 * allow 与 deny 可以同时给，判据是「先按 allow 保留，再按 deny 剔除」。requireMatch 只在
 * allow 模式有意义：名单里任一工具不在目录里就放弃裁剪、暴露完整目录（fail-open）并告警——
 * 收窄错了会让当前工作流调不到工具，比多花上下文严重。
 *
 * 执行边界的不对称是官方能力决定的：restrict 只作用于继承的全局工具，guard 只有 deny
 * 语义。所以 allow 模式下，scope 本层注册的工具无法在执行层被「只保留」——它们仍可能
 * 被按名调用，只是模型目录里看不到。deny 模式两种工具都拦得住。
 */

import { RUN_CODE, createMask, labelOf } from './shared.mjs'
import { SDK_SECTION_NAME, stripSdkDeclarations, sdkToolNames } from '../sdk-strip.mjs'
import { historyEvents } from '../history.mjs'
import { createPromptConfigs } from '../schema.mjs'
import { applyPromptConfigs } from '../executor.mjs'
import { compileWhen } from '../conditions/index.mjs'
import { DISCOVERY_SERVICE } from '../service-names.mjs'
import { UNLOCKABLE_DISCOVERY_KINDS } from '../discovery.mjs'

const AUDIENCES = new Set([undefined, null, '', 'all', 'main', 'subagent'])
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function parseAudience(action, label, plugin) {
  const value = action.audience
  if (!AUDIENCES.has(value)) {
    throw new TypeError(`${plugin}: ${label}.audience must be main, subagent or all — got ${JSON.stringify(value)}`)
  }
  if (value === 'main' || value === 'subagent') return value
  return 'all'
}

function parseDiscovery(action, label, plugin) {
  const discovery = action.discovery
  if (discovery === undefined) return undefined
  if (!record(discovery)) throw new TypeError(`${plugin}: ${label}.discovery must be an object — { kind, tool?, key? }`)
  const kind = discovery.kind
  if (typeof kind !== 'string' || kind.length === 0) {
    throw new TypeError(`${plugin}: ${label}.discovery.kind is required`)
  }
  // 只有支持「按名解锁」的数据源才能被可见面消费：技能面没有解锁名单语义。
  if (!UNLOCKABLE_DISCOVERY_KINDS.has(kind)) {
    throw new TypeError(`${plugin}: ${label}.discovery.kind ${JSON.stringify(kind)} has no unlock semantics — 可用：${[...UNLOCKABLE_DISCOVERY_KINDS].join(', ')}`)
  }
  const result = { kind }
  for (const field of ['tool', 'key']) {
    if (discovery[field] === undefined) continue
    if (typeof discovery[field] !== 'string' || discovery[field].length === 0) {
      throw new TypeError(`${plugin}: ${label}.discovery.${field} must be a non-empty string`)
    }
    // 工具身份归 adapter 元数据；声明里写这两个键只作断言（不匹配时告警，不改变实际行为）。
    result[field] = discovery[field]
  }
  return result
}

function parseNotice(action, label, plugin) {
  const notice = action.notice
  if (notice === undefined || notice === false) return undefined
  if (notice === true) return { text: '' }
  if (!record(notice)) throw new TypeError(`${plugin}: ${label}.notice must be true, false or { text }`)
  if (notice.text !== undefined && typeof notice.text !== 'string') {
    throw new TypeError(`${plugin}: ${label}.notice.text must be a string`)
  }
  return { text: typeof notice.text === 'string' ? notice.text : '' }
}

/** 同一份 mask 的稳定身份：名单变化必须重挂执行闸，不能沿用旧名单。 */
function maskKey(mask) {
  const list = (set) => set === undefined ? '' : [...set].sort().join(',')
  return `allow:${list(mask.allow)}|deny:${list(mask.deny)}|require:${mask.requireMatch ? 1 : 0}`
}

/**
 * 从完整历史回收解锁名（判据与旧 assembly.allowFrom 逐条对齐）：只认 `tool/call` 里
 * 精确等于发现工具的调用，参数解析失败逐条跳过；解锁只做加法，不能越过 deny。
 * 读完整历史而非可见面：压缩遮蔽那条调用后，已解锁的工具仍要留在目录里。
 */
function fillUnlocked(into, session, tool, key, warnOnce, plugin, label) {
  into.clear()
  // 发现工具是解锁通道本身：它必须恒在放行集里，否则白名单会把它一起裁掉、从此无法解锁。
  into.add(tool)
  let events
  try {
    events = historyEvents(session)
  } catch (error) {
    warnOnce(`${plugin}: tool-visibility action ${label}: reading session events for discovery failed: ${String(error?.message ?? error)}`)
    return
  }
  for (const event of events) {
    if (event?.type !== 'tool/call' || event?.data?.name !== tool) continue
    const raw = event.data.arguments
    let parsed
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { continue }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const value = parsed[key]
    if (!Array.isArray(value)) continue
    for (const item of value) if (typeof item === 'string' && item.length > 0) into.add(item)
  }
}

/** 首轮提示的缺省正文：常驻集与发现入口都从声明派生，不在提示里手抄第二份。 */
export function toolVisibilityNoticeText({ resident = [], discovery, text = '' } = {}) {
  if (text.length > 0) return text
  const listed = resident.length > 0 ? resident.join(', ') : '(empty)'
  const base = `Tool catalog notice: this session exposes a resident core set (${listed}). `
    + 'The rest of the catalog is hidden to keep each request small.'
  if (discovery === undefined) return base
  return base + ` Use ${discovery.tool} to search for a capability and unlock it by exact name.`
}

export function prepareToolVisibility(action, plugin) {
  const label = labelOf(action)
  const audience = parseAudience(action, label, plugin)
  const discovery = parseDiscovery(action, label, plugin)
  const notice = parseNotice(action, label, plugin)
  // 发现工具只解锁白名单里没点的名字：allowExtra 是「只做加法」的活集合，每轮从持久 tool/call 回收。
  if (discovery !== undefined && action.allow === undefined) {
    throw new TypeError(`${plugin}: ${label}.discovery requires allow — 解锁只对白名单有意义`)
  }
  const allowExtra = discovery === undefined ? undefined : new Set()
  const mask = createMask(action, label, plugin, allowExtra)
  // requireMatch 只对白名单有意义（与 assembly / sdk-strip 同判据）：黑名单没有「必需名单」。
  if (mask.requireMatch && mask.allow === undefined) {
    throw new TypeError(`${plugin}: ${label}.requireMatch only applies to allow — deny lists have no required names`)
  }

  return (mountCtx, { warnOnce, on, collect, onMiss }) => {
    /** session -> { ctx, key, disposers }：条件翻转或 mask 变化时先撤再挂。 */
    const states = new Map()
    const release = (session) => {
      const state = states.get(session)
      if (state === undefined) return
      states.delete(session)
      for (const dispose of state.disposers.splice(0)) {
        try { dispose() } catch { /* 释放失败不得反过来打断卸载 */ }
      }
    }
    const releaseAll = () => { for (const session of [...states.keys()]) release(session) }

    const appliesTo = (session) => {
      if (audience === 'all') return true
      const depth = session?.header?.delegationDepth ?? 0
      return depth > 0 ? audience === 'subagent' : audience === 'main'
    }

    /** 执行面：restrict 覆盖继承的全局工具，guard 兜住本层与晚到工具。 */
    const syncGate = (agent) => {
      const session = agent?.session
      const scoped = agent?.ctx
      if (session === undefined || scoped === undefined) return
      if (!appliesTo(session)) { release(session); return }
      const tools = scoped.tools
      if (tools === undefined) return
      const key = `${maskKey(mask)}|unlock:${allowExtra === undefined ? '' : [...allowExtra].sort().join(',')}`
      const existing = states.get(session)
      if (existing !== undefined && existing.ctx === scoped && existing.key === key) return
      // mask 或 scope 变了：先撤旧闸，避免第一轮为真后永久留闸。
      release(session)
      const state = { ctx: scoped, key, disposers: [] }
      const known = typeof tools.schemas === 'function'
        ? new Set((tools.schemas() ?? []).map((schema) => schema?.name).filter((name) => typeof name === 'string'))
        : undefined
      if (typeof tools.restrict === 'function' && known !== undefined) {
        // restrict 对未知名/本层名直接抛错：只喂当前已知的全局名，其余丢弃并留痕。
        const allow = mask.allow === undefined
          ? undefined
          : [...new Set([...mask.allow, ...(allowExtra ?? [])])].filter((name) => known.has(name))
        const deny = mask.deny === undefined ? undefined : [...mask.deny].filter((name) => known.has(name))
        if ((allow?.length ?? 0) > 0 || (deny?.length ?? 0) > 0) {
          try {
            const dispose = tools.restrict({ ...(allow === undefined ? {} : { allow }), ...(deny === undefined ? {} : { deny }) })
            if (typeof dispose === 'function') state.disposers.push(dispose)
          } catch (error) {
            // restrict 失败不改变呈现面；执行面还有下面的 guard 兜底（deny 模式）。
            warnOnce(`${plugin}: tool-visibility action ${label} restrict skipped: ${String(error?.message ?? error)}`)
          }
        }
      }
      if (mask.deny !== undefined && typeof tools.guard === 'function') {
        const deny = mask.deny
        state.disposers.push(tools.guard((exec) => {
          const toolName = exec?.name
          if (toolName === RUN_CODE || typeof toolName !== 'string' || toolName.length === 0) return undefined
          return deny.has(toolName) ? `${label}: tool ${JSON.stringify(toolName)} is denied by tool-visibility` : undefined
        }))
      }
      states.set(session, state)
      // 子代理与重绑都换 scope：父 mount 释放必须能撤销，scope 释放只移出自己。
      if (typeof scoped.effect === 'function') {
        scoped.effect(() => () => { if (states.get(session) === state) release(session) })
      }
    }

    collect(releaseAll)
    /**
     * 提示走既有 prompt-config 引擎（与锚定提示、晋升提示同一条通道）：本动作只构造一条
     * 配置并交给它执行，不新开通道，也不在动作里再写一遍注入逻辑。
     * 首轮由 count(user-message, max 1) 限定；条件通过时本 handler 才会被调用，所以提示
     * 天然跟随规则条件。
     */
    let noticeInstalled = false
    const installNotice = () => {
      if (notice === undefined || noticeInstalled) return
      noticeInstalled = true
      try {
        const text = toolVisibilityNoticeText({ resident: [...(mask.allow ?? [])], discovery, text: notice.text })
        const [config] = createPromptConfigs([{
          id: `tool-visibility:${action.id}:notice`,
          layer: 'pre-step',
          strategy: 'static',
          position: 'after-user',
          dedupe: 'session',
          configKind: 'ordered',
          order: 20,
          role: 'user',
          mergeMode: 'separate',
          form: 'notice',
          text,
        }])
        config.actionWhen = compileWhen({ count: { of: 'user-message', max: 1 } })
        collect(applyPromptConfigs(mountCtx, [config], {}))
      } catch (error) {
        warnOnce(`${plugin}: tool-visibility action ${label} notice failed: ${String(error?.message ?? error)}`)
      }
    }
    // 条件为假时 rule-runtime 不进入 handler：未命中回调负责撤掉上一轮注册的执行闸。
    // 动作级 when 由 withWhen 调用时没有帧，只能撤当前已登记的全部会话。
    onMiss((frame) => {
      const session = frame?.subject?.agent?.session ?? frame?.args?.[1]?.agent?.session
      if (session === undefined) releaseAll()
      else release(session)
    })

    collect(on('system-prompt/assemble', async (assembly, context, next) => {
      const assembled = await next()
      // 解锁名必须先回收：执行闸的 restrict allow 要包含本轮解锁项，否则解锁的工具看得见、调不动。
      // 工具名与参数键来自发现注册表的 adapter 元数据；声明里的同名字段只作断言。
      if (allowExtra !== undefined) {
        const registry = typeof mountCtx.get === 'function' ? mountCtx.get(DISCOVERY_SERVICE) : undefined
        const adapter = typeof registry?.get === 'function' ? registry.get(context?.agent, discovery.kind) : undefined
        const unlock = adapter?.unlock
        if (unlock === undefined) {
          allowExtra.clear()
          warnOnce(`${plugin}: tool-visibility action ${label}: discovery adapter "${discovery.kind}" is not registered for this agent — unlock recovery skipped`)
        } else {
          if (discovery.tool !== undefined && discovery.tool !== unlock.tool) {
            warnOnce(`${plugin}: tool-visibility action ${label}: discovery.tool ${JSON.stringify(discovery.tool)} does not match the "${discovery.kind}" adapter tool ${JSON.stringify(unlock.tool)}`)
          }
          if (discovery.key !== undefined && discovery.key !== unlock.key) {
            warnOnce(`${plugin}: tool-visibility action ${label}: discovery.key ${JSON.stringify(discovery.key)} does not match the "${discovery.kind}" adapter key ${JSON.stringify(unlock.key)}`)
          }
          fillUnlocked(allowExtra, context?.session ?? context?.agent?.session, unlock.tool, unlock.key, warnOnce, plugin, label)
        }
      }
      try {
        syncGate(context?.agent)
      } catch (error) {
        // 闸注册失败必须留痕；呈现面照常结算，绝不把异常抛给装配。
        warnOnce(`${plugin}: tool-visibility action ${label} failed to sync execution gate: ${String(error?.message ?? error)}`)
      }
      try {
        // 受众不在本次装配的目标内：不投影、也不挂闸（syncGate 已按同一判据释放旧闸）。
        if (!appliesTo(context?.agent?.session)) return assembled
        let result = assembled
        installNotice()
        if (Array.isArray(result.tools)) {
          const available = new Set(result.tools.map((tool) => tool?.name).filter((name) => typeof name === 'string'))
          // requireMatch 与旧 assembly 同判据：名单里任一工具缺失就 fail-open。
          // 必需名单 = 静态 allow ∪ 本轮解锁项：解锁项同样是「本该存在」的工具。
          const required = mask.requireMatch && mask.allow !== undefined
            ? [...mask.allow, ...(allowExtra ?? [])].some((name) => !available.has(name))
            : false
          if (required) {
            warnOnce(`${plugin}: tool-visibility action ${label}: a requireMatch tool is absent — exposing the full tool set (fail-open)`)
          } else {
            const kept = result.tools.filter((tool) => !mask.blocks(tool?.name))
            if (kept.length !== result.tools.length) result = { ...result, tools: kept }
          }
        }
        if (Array.isArray(result.sections)) {
          let changed = false
          let present
          const sections = result.sections.map((section) => {
            if (section?.name !== SDK_SECTION_NAME || typeof section.text !== 'string') return section
            const presentNames = () => {
              present ??= new Set(sdkToolNames(section.text))
              return present
            }
            if (mask.requireMatch && mask.allow !== undefined
              && [...mask.allow].some((name) => !presentNames().has(name))) {
              return section
            }
            const names = mask.allow === undefined
              ? mask.deny
              : new Set([...presentNames()].filter((name) => mask.blocks(name)))
            if (names === undefined || names.size === 0) return section
            const stripped = stripSdkDeclarations(section.text, names)
            if (stripped === section.text) return section
            changed = true
            return { ...section, text: stripped }
          })
          if (changed) result = { ...result, sections }
        }
        return result
      } catch (error) {
        // 呈现面失败只告警：执行闸已在上面同步过，deny 仍然拦得住。
        warnOnce(`${plugin}: tool-visibility action ${label} failed, keeping the assembled surface: ${String(error?.message ?? error)}`)
        return assembled
      }
    }))
  }
}
