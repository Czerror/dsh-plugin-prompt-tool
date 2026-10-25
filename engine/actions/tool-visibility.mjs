/**
 * tool-visibility —— 工具可见面：一份声明拥有「模型看得见什么、调得动什么」。
 *
 * 三面投影都在 system-prompt/assemble 的 after-next 之后完成：
 *  1. 装配目录（tools 数组）——本轮的呈现面；
 *  2. tools:sdk 段正文——模型读到的工具声明；
 *  3. 执行面：deny 用 restrict + guard；allow 只登记 guard（restrict 无法安全覆盖预设/祖先层）。
 *
 * 旧实现把同一个意图拆成三条声明（assembly / sdk-strip / guard），其中 guard 属固定
 * 注册效果、不能带规则级 if，于是「有条件下架」被迫再复制一份名单。这里把名单收在
 * 一个动作里：条件由规则引擎在装配通道逐轮求值，执行闸按当前条件**重挂或撤销**，
 * 因此不再有跨轮粘性。
 *
 * 名单语义对齐官方 ToolRestriction（deepseek-harness packages/core/tools/src/index.ts:701-706）：
 * allow 与 deny 可以同时给，判据是「先按 allow 保留，再按 deny 剔除」。requireMatch 只在
 * allow 模式有意义，判据是「这份名单与装配面整体错位」：名单里的名字**一个都不在**目录与
 * SDK 正文的并集里，才放弃裁剪、暴露完整目录（fail-open）并告警。只缺一部分是提供方被
 * 替换或关闭的正常部署差异，收窄照常生效、缺项只留一条诊断；解锁名是只做加法的提示，
 * 不参与这个判定。
 *
 * 执行边界：deny 同时用 restrict（继承面）与 guard（本层/晚到）；allow 不用 restrict——
 * 它的 allow 只能收继承面名字，而 `schemas()` 全局视图会漏掉预设/祖先层，局部 allow 会
 * 把要保留的工具裁掉。allow 统一由 guard 裁决；requireMatch fail-open 时 guard 同步放行。
 */

import { RUN_CODE, createMask, labelOf, toolSurfacePlan } from './shared.mjs'
import { createAgentCapability } from '../agent-capability.mjs'
import { SDK_SECTION_NAME, stripSdkDeclarations, sdkToolNames } from '../sdk-strip.mjs'
import { TOOL_INVOCATION_EVENT_TYPES, historyEvents } from '../history.mjs'
import { toolScopeSnapshot } from '../tool-scope.mjs'
import { DISCOVERY_SERVICE } from '../service-names.mjs'
import { UNLOCKABLE_DISCOVERY_KINDS } from '../discovery.mjs'

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

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


/** 同一份 mask 的稳定身份：名单变化必须重挂执行闸，不能沿用旧名单。 */
function maskKey(mask) {
  const list = (set) => set === undefined ? '' : [...set].sort().join(',')
  return `allow:${list(mask.allow)}|deny:${list(mask.deny)}|require:${mask.requireMatch ? 1 : 0}`
}

/**
 * 从完整历史回收解锁名（判据与旧 assembly.allowFrom 逐条对齐）：认顶层 `tool/call`
 * 与 PTC 嵌套 `tool/ptc-dispatch` 里精确等于发现工具的调用，参数解析失败逐条跳过；
 * 解锁只做加法，不能越过 deny。读完整历史而非可见面：压缩遮蔽那条调用后仍要保留。
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
    // PTC 下 run_code 里的嵌套调用落为 tool/ptc-dispatch，不是顶层 tool/call。
    if (!TOOL_INVOCATION_EVENT_TYPES.includes(event?.type) || event?.data?.name !== tool) continue
    const raw = event.data.arguments
    let parsed
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { continue }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const value = parsed[key]
    if (!Array.isArray(value)) continue
    for (const item of value) if (typeof item === 'string' && item.length > 0) into.add(item)
  }
}

export function prepareToolVisibility(action, plugin) {
  const label = labelOf(action)
  const discovery = parseDiscovery(action, label, plugin)
  // 发现工具只解锁白名单里没点的名字：allowExtra 是「只做加法」的活集合，每轮从持久调用记录回收。
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
    /** 执行面：restrict 覆盖继承的全局工具，guard 兜住本层与晚到工具。 */
    const capability = createAgentCapability((agent) => {
      const tools = agent?.ctx?.tools
      if (tools === undefined) return undefined
      // unlocked：本会话装配时冻结的解锁名快照（await next() 期间别的装配会重填共享集合）。
      const state = { failOpen: false, unlocked: undefined }
      const disposers = []
      try {
        const known = toolScopeSnapshot(tools).globalNames
        if (mask.deny !== undefined && typeof tools.restrict === 'function' && known !== undefined) {
        // allow 模式不走 restrict：`schemas()` 是全局视图，过滤后的 allow 会漏掉预设/祖先层的
        // 工具，restrict 反而把它们裁掉；restrict 只接收继承面名字，无法安全区分本层工具。
        // allow 的执行面统一由下面的 guard 兜底。
        const deny = [...mask.deny].filter((name) => known.has(name))
        if (deny.length > 0) {
          try {
            const dispose = tools.restrict({ deny })
            if (typeof dispose === 'function') disposers.push(dispose)
          } catch (error) {
            // restrict 失败不改变呈现面；执行面还有 guard 兜底。
            warnOnce(`${plugin}: tool-visibility action ${label} restrict skipped: ${String(error?.message ?? error)}`)
          }
        }
      }
        if ((mask.deny !== undefined || mask.allow !== undefined) && typeof tools.guard === 'function') {
          const deny = mask.deny
          disposers.push(tools.guard((exec) => {
            const toolName = exec?.name
            if (toolName === RUN_CODE || typeof toolName !== 'string' || toolName.length === 0) return undefined
            if (deny?.has(toolName)) return `${label}: tool ${JSON.stringify(toolName)} is denied by tool-visibility`
            if (mask.allow !== undefined && !state.failOpen && mask.blocks(toolName, state.unlocked)) {
              return `${label}: tool ${JSON.stringify(toolName)} is not allowed by tool-visibility`
            }
            return undefined
          }))
        }
      } catch (error) {
        // 声明失败不能丢已注册的 restrict：已收集的 disposer 仍交给声明表统一撤销。
        warnOnce(`${plugin}: tool-visibility action ${label} failed to mount execution gate: ${String(error?.message ?? error)}`)
      }
      return { disposers, data: state }
    })

    // 重挂判定用**本会话的快照**：共享集合在别的装配里会被重填，不能当身份。
    const syncGate = (agent, unlocked) => {
      const key = `${maskKey(mask)}|unlock:${unlocked === undefined ? '' : [...unlocked].sort().join(',')}`
      capability.sync(agent, key)
    }

    collect(capability.releaseAll)
    // 条件为假时 rule-runtime 不进入 handler：未命中回调负责撤掉上一轮注册的执行闸。
    // 动作级 when 由 withWhen 调用时没有帧，只能撤当前已登记的全部会话。
    onMiss((frame) => {
      const session = frame?.subject?.agent?.session ?? frame?.args?.[1]?.agent?.session
      if (session === undefined) capability.releaseAll()
      else capability.release(session)
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
      // 在 await next() 之前冻结本会话的解锁名：之后的裁剪与执行闸都读这一份，
      // 共享的 allowExtra 可能被并发的另一次装配（别的会话 / 探针）清空重填。
      const unlocked = allowExtra === undefined ? undefined : new Set(allowExtra)
      try {
        syncGate(context?.agent, unlocked)
      } catch (error) {
        // 闸注册失败必须留痕；呈现面照常结算，绝不把异常抛给装配。
        warnOnce(`${plugin}: tool-visibility action ${label} failed to sync execution gate: ${String(error?.message ?? error)}`)
      }
      try {
        let result = assembled
        // PTC 的 tools 数组只有 run_code 传输；实际可见面在 SDK 正文里，requireMatch 必须
        // 以两者并集为准，否则 native 的收窄名单会被误判成缺失并 fail-open。
        const sdkSection = Array.isArray(result.sections)
          ? result.sections.find((section) => section?.name === SDK_SECTION_NAME && typeof section.text === 'string')
          : undefined
        const sdkNames = sdkSection === undefined ? undefined : new Set(sdkToolNames(sdkSection.text))
        const available = new Set([
          ...(Array.isArray(result.tools) ? result.tools.map((tool) => tool?.name).filter((name) => typeof name === 'string') : []),
          ...(sdkNames ?? []),
        ])
        // 没有工具面可观（既无目录也无 SDK 正文）时不裁剪、不告警、不动执行闸：
        // 空 surface 不等于「名单全缺」；空目录（tools=[]）仍是真实观测，照旧 fail-open。
        if (!Array.isArray(result.tools) && sdkSection === undefined) return result
        // 三面（目录 / 正文 / 执行闸）共用这一份判断：名单全缺才整体放宽，呈现与执行不得两套口径。
        const plan = toolSurfacePlan(mask, available)
        const state = capability.get(context?.session ?? context?.agent?.session)
        if (state !== undefined) {
          state.data.failOpen = plan.failOpen
          state.data.unlocked = unlocked
        }
        if (plan.failOpen) {
          // 去重键固定到动作：缺项名随部署变化，不能让每个新集合各占一条 warnOnce。
          warnOnce(`${plugin}: tool-visibility action ${label}: none of the resident tools exist (${plan.missing.join(', ')}) — exposing the full tool set (fail-open)`, `${plugin}: tool-visibility action ${label}: requireMatch fail-open`)
        } else {
          // 部分缺失不改变裁剪，但必须留痕：否则「某个常驻工具为什么不见了」只能靠猜。
          if (plan.missing.length > 0) {
            warnOnce(`${plugin}: tool-visibility action ${label}: resident tools absent (${plan.missing.join(', ')}) — narrowing continues; register replacement providers in the deployment allow list`, `${plugin}: tool-visibility action ${label}: resident tools absent`)
          }
          if (Array.isArray(result.tools)) {
            const kept = result.tools.filter((tool) => !mask.blocks(tool?.name, unlocked))
            if (kept.length !== result.tools.length) result = { ...result, tools: kept }
          }
          if (Array.isArray(result.sections)) {
            let changed = false
            let present = sdkNames
            const sections = result.sections.map((section) => {
              if (section?.name !== SDK_SECTION_NAME || typeof section.text !== 'string') return section
              const presentNames = () => {
                present ??= new Set(sdkToolNames(section.text))
                return present
              }
              const names = mask.allow === undefined
                ? mask.deny
                : new Set([...presentNames()].filter((name) => mask.blocks(name, unlocked)))
              if (names === undefined || names.size === 0) return section
              const stripped = stripSdkDeclarations(section.text, names)
              if (stripped === section.text) return section
              changed = true
              return { ...section, text: stripped }
            })
            if (changed) result = { ...result, sections }
          }
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
