/**
 * 自动派工编排：plan 会话把已授权目标拆成自包含子任务，用官方 Team 记录任务与依赖，
 * 真实启动执行角色并等待匹配运行的终态，再按真实结果汇总。
 *
 * 事实只有一份，本文件不建第二套：
 *   - 任务、依赖、版本、ready 与 writeScopes 归官方 Team（createTask/getTask/listTasks/updateTask）；
 *   - 成员、运行、消息与等待归官方 subagent（delegate 与 handoff 都走官方入口）；
 *   - 角色内容归 modules/redteam 的 role-* 规则，总开关是本模块的 auto-delegation 规则。
 *
 * 默认关闭（规格 34）：规则 enabled=false 时 run/enable 都明确不可用。没有常驻调度器，
 * 一次 run() 驱动一次计划；官方 ready、模式变化或一次返回都不冒充已经启动或完成。
 */
import { join } from 'node:path'
import { readModuleRules } from '../host/module-rules.ts'
import {
  EXECUTABLE_ROLES,
  ROLE_MODULE_ID,
  selectCapabilityProtocol,
  type HostTask,
  type RoleDelegationAvailability,
  type RoleDelegationRuntime,
} from './role-delegation.ts'

/** 自动派工总开关：module.yml 里默认 enabled=false，由用户显式打开。 */
export const AUTO_DELEGATION_RULE_ID = 'auto-delegation'
/** 供宿主/UI 取编排入口的服务名。 */
export const AUTO_DELEGATION_SERVICE = 'prompt-tool/auto-delegation'

export class AutoDelegationError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'AutoDelegationError'
    this.code = code
  }
}

/**
 * 任务书的六段必备事实。子代理不继承父对话，缺一段就无法独立执行；
 * 这也是「不扩大用户目标」的落点：任务书只由这些字段渲染，不追加计划外内容。
 */
export const BRIEF_SECTIONS = [
  ['objective', '目标范围'],
  ['inputs', '输入'],
  ['known', '已知事实'],
  ['expected', '预期产出'],
  ['acceptance', '验收依据'],
  ['tools', '实际可用工具'],
] as const
export type BriefField = (typeof BRIEF_SECTIONS)[number][0]
export type TaskBrief = Record<BriefField, string>

/** 计划里的一项子任务；key 只在本次计划内唯一，官方任务 id 由登记结果决定。 */
export interface PlannedSubtask {
  readonly key: string
  readonly role: string
  readonly subject: string
  readonly brief: TaskBrief
  readonly blockedBy?: readonly string[]
  /** 官方 writeScopes：冲突提示，不是锁也不是目录隔离。 */
  readonly writeScopes?: readonly string[]
  readonly label?: string
}

export type SubtaskState = 'completed' | 'failed' | 'cancelled' | 'blocked' | 'skipped'

export interface SubtaskOutcome {
  readonly key: string
  readonly role: string
  readonly taskId?: string
  readonly childSession?: string
  readonly runId?: string
  readonly taskStatus?: string
  readonly revision?: number
  readonly state: SubtaskState
  /** completed 的来源：没有 reason 表示本次真实运行结算；official-status 表示官方已有终态。 */
  readonly reason?: string
}

export interface AutoDelegationRequest {
  readonly parent: unknown
  readonly planId: string
  readonly subtasks: readonly PlannedSubtask[]
  readonly signal: AbortSignal
  /** 独立任务的并行额度：默认 1。有依赖的任务永远不会被并行启动。 */
  readonly parallel?: number
}

export interface AutoDelegationSummary {
  readonly planId: string
  readonly completed: boolean
  readonly cancelled: boolean
  readonly outcomes: readonly SubtaskOutcome[]
}

export interface AutoDelegationOptions {
  readonly delegation: RoleDelegationRuntime
  readonly moduleRoot: string
  readonly warn?: (message: string) => void
}

export interface AutoDelegationAvailability {
  readonly ruleEnabled: boolean
  readonly availability: RoleDelegationAvailability
}

export interface AutoDelegationRuntime {
  /** 规则开关与派工资格（Team 关闭、缺服务、leaf 限制不可用时给准确原因）。 */
  status(parent?: unknown): AutoDelegationAvailability
  /** 显式开启事务：经既有跨模块互斥选红队协议，并给真实根会话授 plan。 */
  enable(parent: unknown): { ruleEnabled: true; protocol: 'redteam' }
  /** 规则保存/刷新后同步：开启时沿既有事务选红队协议；关闭时不动协议（规格 9/33）。 */
  syncRule(): void
  /** 只撤回本来源的角色与未消费资格；不擅自重开普通协议，不删任务，不动已启动子任务。 */
  disable(parent?: unknown): void
  /** 规则开启时给真实根会话授 plan（重挂后的恢复入口）；返回是否分配。 */
  assignRoot(agent: unknown): boolean
  /** 登记官方任务、按依赖真实派发、等待匹配终态并汇总。 */
  run(request: AutoDelegationRequest): Promise<AutoDelegationSummary>
  /** 官方消息交接：需要继续工作时给同一棵树的真实成员发消息。 */
  handoff(parent: unknown, childSession: string, text: string, signal: AbortSignal): Promise<string>
  dispose(): void
}

/** 官方任务描述首行的稳定标记：恢复时据此读回已提交任务，不重复创建。 */
const marker = (planId: string, key: string): string => `[auto-plan:${planId}/${key}]`
const tagOf = (description: string | undefined): { planId: string; key: string } | undefined => {
  const match = /^\[auto-plan:([^/\]]+)\/([^\]]+)\]/.exec(description ?? '')
  return match === null ? undefined : { planId: match[1]!, key: match[2]! }
}
const codeOf = (error: unknown): string => {
  const candidate = error as { code?: unknown; name?: unknown } | undefined
  if (typeof candidate?.code === 'string') return candidate.code
  return typeof candidate?.name === 'string' ? candidate.name : 'unknown-error'
}

/** 自包含任务书正文：只由六段字段渲染，语言固定，不由调用方拼自由文本。 */
export const renderTaskBook = (item: PlannedSubtask): string => [
  '# 委派任务书',
  '',
  `任务是「${item.subject}」。你是叶子执行者：不再往下委派，只在本任务书范围内工作。`,
  '',
  ...BRIEF_SECTIONS.flatMap(([field, label]) => [`## ${label}`, item.brief[field], '']),
].join('\n')

export function createAutoDelegation(options: AutoDelegationOptions): AutoDelegationRuntime {
  const { delegation, moduleRoot } = options
  const warn = options.warn ?? (() => {})
  let closed = false

  // 每次现读规则，不缓存：用户编辑并保存后立刻生效。
  const ruleEnabled = (): boolean => {
    try {
      return readModuleRules(join(moduleRoot, ROLE_MODULE_ID)).rules
        .some(rule => rule.id === AUTO_DELEGATION_RULE_ID && rule.enabled === true)
    } catch {
      return false
    }
  }
  const assertEnabled = (action: string): void => {
    if (closed) throw new AutoDelegationError('AUTO_DELEGATION_CLOSED', `自动派工已关闭：不再接受${action}`)
    if (!ruleEnabled()) {
      throw new AutoDelegationError('AUTO_DELEGATION_DISABLED', `模块规则 ${AUTO_DELEGATION_RULE_ID} 未开启：自动派工默认关闭，需用户显式启用后才能${action}`)
    }
  }
  /** 红队协议是否已被选中：读现文件，不缓存，避免在别处已有第二份开关状态。 */
  const protocolSelected = (): boolean => {
    try {
      return readModuleRules(join(moduleRoot, ROLE_MODULE_ID)).rules
        .some(rule => rule.id === 'protocol-redteam' && rule.enabled === true)
    } catch {
      return false
    }
  }

  return {
    status(parent) {
      return { ruleEnabled: ruleEnabled(), availability: delegation.availability(parent) }
    },

    enable(parent) {
      assertEnabled('开启派工事务')
      const available = delegation.availability(parent)
      if (!available.ok) throw new AutoDelegationError(available.code, available.message)
      this.syncRule()
      // plan 只给真实根会话；子会话拿到它只会得到一份没有受众的静默失败。
      delegation.assignRootRole(parent, 'plan')
      return { ruleEnabled: true as const, protocol: 'redteam' as const }
    },

    syncRule() {
      // 规则开启 → 经既有跨模块互斥事务选红队协议；规则关闭 → 保留当前协议，不擅自调回普通协议。
      if (closed || !ruleEnabled() || protocolSelected()) return
      selectCapabilityProtocol(moduleRoot, 'redteam')
    },

    disable(parent) {
      // 只撤回本来源：plan 角色与未消费的派工资格。
      delegation.release(parent)
      if (parent !== undefined) delegation.revokeRole(parent)
    },

    assignRoot(agent) {
      if (closed || !ruleEnabled()) return false
      try {
        delegation.assignRootRole(agent, 'plan')
        return true
      } catch (error) {
        // 子会话不适用指挥角色：这不是错误，也不该在每次子代理创建时刷告警。
        if (codeOf(error) === 'ROLE_PARENT_REQUIRED') return false
        warn(`prompt-tool: plan 角色未分配：${String((error as Error)?.message ?? error)}`)
        return false
      }
    },

    async run(request) {
      assertEnabled('运行计划')
      // 派工前确保协议与纪律同步：规则开启即选红队协议（幂等），关闭派工时不切回普通协议。
      this.syncRule()
      const available = delegation.availability(request.parent)
      if (!available.ok) throw new AutoDelegationError(available.code, available.message)
      const { parent, planId, subtasks, signal } = request
      const order = validatePlan(planId, subtasks)
      const planned = new Map<string, PlannedSubtask>(subtasks.map(item => [item.key, item] as const))
      const parallel = Math.max(1, Math.floor(request.parallel ?? 1))

      // 1) 官方登记：先读官方已有事实（恢复/重挂不重复创建），再补齐缺的任务。
      const official = new Map<string, HostTask>()
      for (const task of delegation.tasksOf(parent)) {
        const tag = tagOf(task.description)
        if (tag === undefined || tag.planId !== planId || !planned.has(tag.key) || official.has(tag.key)) continue
        official.set(tag.key, task)
      }
      for (const item of order) {
        if (official.has(item.key)) continue
        const created = await delegation.submitTask(parent, {
          subject: item.subject,
          description: `${marker(planId, item.key)}\n${renderTaskBook(item)}`,
          blockedBy: (item.blockedBy ?? []).map(dep => official.get(dep)!.id),
          ...(item.writeScopes === undefined ? {} : { writeScopes: item.writeScopes }),
        })
        official.set(item.key, created)
      }

      // 2) 真实派发：官方 ready 只说明可认领；启动一律走 delegate，完成一律等 settle 的匹配结论。
      const views = (): Map<string, HostTask> => new Map(delegation.tasksOf(parent).map(task => [String(task.id), task] as const))
      const outcomes = new Map<string, SubtaskOutcome>()
      const keep = (outcome: SubtaskOutcome): SubtaskOutcome => {
        outcomes.set(outcome.key, outcome)
        return outcome
      }

      const dispatch = async (key: string): Promise<SubtaskOutcome> => {
        const item = planned.get(key)!
        const taskId = official.get(key)!.id
        const base = { key, role: item.role, taskId }
        const task = views().get(taskId)
        if (task === undefined) return keep({ ...base, state: 'skipped', reason: 'official-task-missing' })
        // 官方已有终态或已被其他来源认领：不重复派发，只按官方视图汇报。
        if (task.status === 'completed') {
          return keep({ ...base, taskStatus: task.status, revision: task.revision, state: 'completed', reason: 'official-status' })
        }
        if (task.status !== 'pending') {
          return keep({ ...base, taskStatus: task.status, revision: task.revision, state: 'skipped', reason: `official-status:${task.status}` })
        }
        if (task.ready === false) {
          return keep({ ...base, taskStatus: task.status, revision: task.revision, state: 'blocked', reason: 'official-not-ready' })
        }
        let run
        try {
          run = await delegation.delegate({
            parent,
            role: item.role,
            taskId,
            label: item.label ?? item.key,
            prompt: renderTaskBook(item),
            signal,
          })
        } catch (error) {
          return keep({ ...base, taskStatus: task.status, revision: task.revision, state: 'failed', reason: codeOf(error) })
        }
        let outcome
        try {
          outcome = await delegation.settle(run, { caller: parent })
        } catch (error) {
          // 陈旧版本、归属不匹配等官方错误保留原语义，不把失败当完成。
          return keep({
            ...base, childSession: run.childId, taskStatus: task.status, revision: task.revision,
            state: 'failed', reason: codeOf(error),
          })
        }
        return keep({
          ...base,
          childSession: run.childId,
          ...(run.runId === undefined ? {} : { runId: run.runId }),
          ...(outcome.status === undefined ? {} : { taskStatus: outcome.status }),
          ...(outcome.revision === undefined ? {} : { revision: outcome.revision }),
          state: outcome.completed ? 'completed' : 'failed',
          ...(outcome.completed || outcome.reason === undefined ? {} : { reason: outcome.reason }),
        })
      }

      // 3) 调度：依赖已完成才轮到后序；依赖失败或取消即阻断后序；独立任务只在额度内并行。
      const remaining = new Set<string>(order.map(item => item.key))
      while (remaining.size > 0) {
        if (signal.aborted) break
        // Team 被关闭、官方服务消失或来源被释放后不再启动后续任务；官方任务原样保留。
        const gate = delegation.availability(parent)
        if (!gate.ok) {
          for (const key of remaining) {
            keep({ key, role: planned.get(key)!.role, taskId: official.get(key)?.id, state: 'cancelled', reason: gate.code })
          }
          remaining.clear()
          break
        }
        const current = views()
        const startable: string[] = []
        // 迭代中会删除本轮收口的 key，因此先取一份快照。
        for (const key of Array.from(remaining)) {
          const item = planned.get(key)!
          const deps = item.blockedBy ?? []
          const settledDep = deps.find(dep => outcomes.has(dep) && outcomes.get(dep)!.state !== 'completed')
          if (settledDep !== undefined) {
            keep({ key, role: item.role, taskId: official.get(key)?.id, state: 'blocked', reason: `dependency-${outcomes.get(settledDep)!.state}:${settledDep}` })
            remaining.delete(key)
            continue
          }
          const unmet = deps.find(dep => current.get(official.get(dep)!.id)?.status !== 'completed')
          if (unmet !== undefined) continue
          startable.push(key)
        }
        if (startable.length === 0) {
          // 没有任何可启动任务：依赖链已在上面收口，剩下的计划推不动，如实报 blocked。
          for (const key of remaining) {
            keep({ key, role: planned.get(key)!.role, taskId: official.get(key)?.id, state: 'blocked', reason: 'dependency-unsatisfied' })
          }
          remaining.clear()
          break
        }
        const batch = startable.slice(0, parallel)
        for (const outcome of await Promise.all(batch.map(key => dispatch(key)))) remaining.delete(outcome.key)
      }
      // 用户取消 / 来源关闭：已登记的官方任务保留，未启动的报 cancelled 而不补发。
      for (const key of remaining) {
        keep({ key, role: planned.get(key)!.role, taskId: official.get(key)?.id, state: 'cancelled', reason: 'cancelled-before-start' })
      }

      const ordered = order.map((item): SubtaskOutcome => outcomes.get(item.key)
        ?? { key: item.key, role: item.role, state: 'skipped', reason: 'not-dispatched' })
      return {
        planId,
        completed: ordered.every(outcome => outcome.state === 'completed'),
        cancelled: signal.aborted,
        outcomes: ordered,
      }
    },

    async handoff(parent, childSession, text, signal) {
      if (closed) throw new AutoDelegationError('AUTO_DELEGATION_CLOSED', '自动派工已关闭：不再收发交接消息')
      if (typeof text !== 'string' || text.trim() === '') {
        throw new AutoDelegationError('AUTO_HANDOFF_INVALID', '交接消息不能为空')
      }
      return await delegation.message(parent, childSession, text, signal)
    },

    dispose() { closed = true },
  }
}

/** 计划校验：key 唯一、角色可派、任务书自包含、依赖存在且无环；返回拓扑序。 */
function validatePlan(planId: string, subtasks: readonly PlannedSubtask[]): PlannedSubtask[] {
  if (typeof planId !== 'string' || planId.trim() === '') {
    throw new AutoDelegationError('AUTO_PLAN_INVALID', 'planId 必须是非空字符串')
  }
  if (!Array.isArray(subtasks) || subtasks.length === 0) {
    throw new AutoDelegationError('AUTO_PLAN_INVALID', '计划里没有子任务')
  }
  const keys = new Set<string>()
  for (const item of subtasks) {
    if (typeof item?.key !== 'string' || item.key.trim() === '') {
      throw new AutoDelegationError('AUTO_PLAN_INVALID', '子任务缺 key')
    }
    if (keys.has(item.key)) throw new AutoDelegationError('AUTO_PLAN_INVALID', `子任务 key 重复：${item.key}`)
    keys.add(item.key)
    if (!(EXECUTABLE_ROLES as readonly string[]).includes(item.role)) {
      throw new AutoDelegationError('AUTO_ROLE_INVALID',
        `子任务 ${item.key} 的角色 ${String(item.role)} 不可派；可派：${EXECUTABLE_ROLES.join('/')}（plan 只给真实根会话）`)
    }
    const missing = BRIEF_SECTIONS
      .filter(([field]) => typeof item.brief?.[field] !== 'string' || item.brief[field].trim() === '')
      .map(([, label]) => label)
    if (missing.length > 0) {
      throw new AutoDelegationError('AUTO_BRIEF_INCOMPLETE',
        `子任务 ${item.key} 的任务书缺：${missing.join('、')}；子代理不继承父对话，六段缺一不可`)
    }
  }
  for (const item of subtasks) {
    for (const dep of item.blockedBy ?? []) {
      if (dep === item.key) throw new AutoDelegationError('AUTO_PLAN_INVALID', `子任务 ${item.key} 依赖自己`)
      if (!keys.has(dep)) throw new AutoDelegationError('AUTO_PLAN_INVALID', `子任务 ${item.key} 依赖未知任务：${dep}`)
    }
  }
  const byKey = new Map<string, PlannedSubtask>(subtasks.map(item => [item.key, item] as const))
  const order: PlannedSubtask[] = []
  const done = new Set<string>()
  const visiting = new Set<string>()
  const visit = (key: string): void => {
    if (done.has(key)) return
    if (visiting.has(key)) throw new AutoDelegationError('AUTO_PLAN_INVALID', `任务依赖成环：${key}`)
    visiting.add(key)
    for (const dep of byKey.get(key)!.blockedBy ?? []) visit(dep)
    visiting.delete(key)
    done.add(key)
    order.push(byKey.get(key)!)
  }
  for (const item of subtasks) visit(item.key)
  return order
}
