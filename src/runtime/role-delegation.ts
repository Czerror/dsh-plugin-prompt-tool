/**
 * 角色委派：把**已校验的执行角色**绑到一次真实子代理启动上，并在该子 Agent
 * 首次装配前供既有注入链读取。
 *
 * 唯一权威（不新建第二份）：
 *   - 官方 Team 拥有任务、依赖、归属与版本（createTask/getTask/updateTask 一律透传官方语义）；
 *   - 官方 subagent 拥有成员、运行、消息与等待（startActivation 与模型侧工具同一入口）；
 *   - 角色**内容**仍由 modules/redteam 的角色规则与资产提供（role 变量条件 + assets 正文），
 *     本文件只提供运行时事实，不复制正文。
 *
 * 两个必须在接入处显式处理的宿主事实（由 02 技术证明在隔离环境实测得出，报告属本地作业区、不入库）：
 *   1. 取消的启动会留下可复用资格 → 一次性 intent + 唯一 token + 启动失败/取消立即释放；
 *   2. 叶子限制没有默认值 → 派工恒传 maxDepth，provider 不支持该能力时明确报不可用。
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { editModuleRules, readModuleRules } from '../host/module-rules.ts'

/** 指挥角色与五执行角色；与 modules/redteam 的 role-* 规则一一对应（测试守门）。 */
export const DELEGATION_ROLES = ['plan', 'recon', 'assess', 'vuln-scan', 'exploit', 'internal'] as const
export type DelegationRole = (typeof DELEGATION_ROLES)[number]
/**
 * 五个执行角色：默认叶子，可由委派授予子代理。plan 是**真实根会话**的指挥角色，
 * 它的内容规则受众是主会话，授予子代理只会得到一个没有角色正文的静默失败，因此明确拒绝。
 */
export const EXECUTABLE_ROLES = ['recon', 'assess', 'vuln-scan', 'exploit', 'internal'] as const
/** 角色内容的唯一来源模块。 */
export const ROLE_MODULE_ID = 'redteam'
/** 子会话里的角色持久事实；恢复只认它加 child header 的交叉核验。 */
export const ROLE_BINDING_EVENT = 'prompt-tool/role-binding'
/** 执行角色默认叶子；宿主没有默认上限，必须显式传。 */
const LEAF_MAX_DEPTH = 1
const PROVIDER = 'spawn'
/** 官方认领窗口的重试：子会话 resident 归属注册晚于 agent/created，并发时窗口更宽。 */
const CLAIM_ATTEMPTS = 8
const CLAIM_RETRY_MS = 25

export class RoleDelegationError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'RoleDelegationError'
    this.code = code
  }
}

/** 角色绑定的可用性结论：不可用时给出稳定 code 与原因，不抛。 */
export type RoleDelegationAvailability = { ok: true } | { ok: false; code: string; message: string }

/** 只读的会话面：官方 Session 的最小投影。 */
interface DelegationSession {
  readonly id: string
  readonly header: { readonly parentSession?: string; readonly delegationDepth?: number }
  append(type: string, data: Record<string, unknown>): unknown
  snapshotEvents(): readonly unknown[]
}
interface DelegationAgent { readonly id?: string; readonly session?: unknown }

export interface HostTask {
  readonly id: string
  readonly revision: number
  readonly status: string
  readonly ownerId?: string
  readonly ready?: boolean
  /** 官方任务描述；自动派工用首行标记在恢复时读回已提交任务。 */
  readonly description?: string
  readonly blockedBy?: readonly string[]
  /** 官方冲突提示，不是锁：重叠只提示，不阻止派发。 */
  readonly writeScopeWarnings?: readonly string[]
}
interface HostSubagents {
  startActivation(spec: Record<string, unknown>): Promise<{
    readonly childId: string
    readonly result: Promise<unknown>
    dispose(): Promise<void>
  }>
  getProvider?(name: string): { readonly capabilities?: { readonly depthLimit?: boolean } } | undefined
  /** 官方消息交接；缺这个方法时派工层如实报不可用，不另建消息队列。 */
  sendMessage?(sender: unknown, targetId: string, content: readonly unknown[], options?: { readonly signal?: AbortSignal }): Promise<string>
}
interface HostTeam {
  isEnabled(caller: unknown): boolean
  createTask(caller: unknown, request: Record<string, unknown>, signal?: AbortSignal): Promise<HostTask>
  getTask(caller: unknown, id: string): HostTask
  updateTask(caller: unknown, request: Record<string, unknown>, signal?: AbortSignal): Promise<HostTask>
  listTasks?(caller: unknown): readonly HostTask[]
}
interface HostAgents { get(id: string): unknown }
interface SubagentOutcome {
  readonly output?: readonly unknown[]
  readonly structured?: unknown
  readonly stopReason?: string
  readonly diagnostic?: string
}

export interface DelegationRequest {
  /** 真实父 Agent（主会话或团队 Lead）。 */
  readonly parent: unknown
  /** 已校验角色值；名称、描述与任务文本都不能代替它。 */
  readonly role: string
  /** 官方 Team 任务 id。 */
  readonly taskId: string
  readonly label: string
  /** 自包含任务书正文。 */
  readonly prompt: string
  readonly signal: AbortSignal
}

export interface DelegationRun {
  readonly role: DelegationRole
  readonly taskId: string
  readonly childId: string
  readonly runId?: string
  readonly result: Promise<SubagentOutcome>
  readonly activation: { dispose(): Promise<void> }
}

export interface DelegationOutcome {
  readonly completed: boolean
  readonly taskId: string
  readonly status?: string
  readonly revision?: number
  /** 未标完成的原因：stopReason:*、no-evidence、owner-mismatch、caller-unavailable。 */
  readonly reason?: string
}

export interface RoleDelegationOptions {
  /** 角色内容模块（redteam）所在的模块根：派工前用它核对 role-<role> 规则确实存在且启用。 */
  moduleRoot: string
  roles?: readonly string[]
  warn?: (message: string) => void
}

export interface RoleDelegationRuntime {
  /** 派工资格：缺服务、Team 关闭、provider 无 depthLimit、已关闭都给明确原因。 */
  availability(parent?: unknown): RoleDelegationAvailability
  /** 登记官方任务（Team 是唯一所有者，返回官方视图）。 */
  submitTask(parent: unknown, request: { subject: string; description: string; blockedBy?: readonly string[]; writeScopes?: readonly string[] }): Promise<HostTask>
  /** 派发一次带角色的真实子代理启动。 */
  delegate(request: DelegationRequest): Promise<DelegationRun>
  /** agent 创建钩子：在首个 assemble 前写入角色事实。 */
  bindCreated(agent: unknown): Promise<void>
  /** 结果回收：真实运行 completed 且任务归属本次运行才标 completed。 */
  settle(run: DelegationRun, options?: { caller?: unknown; expectedRevision?: number }): Promise<DelegationOutcome>
  /** 角色运行时事实（moduleId + sessionId → role），供变量适配器读取。 */
  roleFactsOf(moduleId: string, sessionId: string): Record<string, string> | undefined
  /** 给真实根会话分配指挥角色（plan）。 */
  assignRootRole(agent: unknown, role: string): void
  /** 释放来源：撤销未消费的 intent，不打断任何已启动子任务。 */
  release(parent?: unknown): void
  /** 关闭派工：不再接受新派工，保留官方任务与子会话。 */
  close(): void
  /** 当前已绑定的子会话（诊断与 08 汇总用）。 */
  bindings(): readonly { readonly childSession: string; readonly role: string; readonly taskId?: string }[]
  /** 官方任务全量视图（恢复时读已有事实，不建第二份任务表）。 */
  tasksOf(parent: unknown): readonly HostTask[]
  /** 官方消息交接：向同一棵树的真实成员投递，返回官方 inbox 消息 id。 */
  message(sender: unknown, targetId: string, text: string, signal?: AbortSignal): Promise<string>
  /** 撤回一个会话的角色事实（关闭自动派工时撤回 plan，不动官方任务与已启动子任务）。 */
  revokeRole(target: unknown): void
  dispose(): void
}

interface PendingIntent { readonly role: DelegationRole; readonly taskId: string; readonly token: string }

interface RoleFact { readonly role: string; readonly parentSession?: string; readonly taskId?: string }
interface DispatchRun { readonly role: string; readonly taskId: string; readonly parentSession: string }

const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined
const sessionOf = (agent: unknown): DelegationSession | undefined => {
  const session = (agent as DelegationAgent | undefined)?.session
  if (session === undefined || session === null || typeof session !== 'object') return undefined
  const candidate = session as DelegationSession
  return text(candidate.id) === undefined ? undefined : candidate
}

/**
 * 角色委派运行时。角色的唯一真值来源是登记表（intent → 角色事实）；
 * 子会话里没有任何按名字猜角色的路径。
 */
export function createRoleDelegation(ctx: Context, options: RoleDelegationOptions): RoleDelegationRuntime {
  const roles = new Set<string>(options.roles ?? DELEGATION_ROLES)
  const warn = options.warn ?? (() => {})
  const intents = new Map<string, PendingIntent[]>()
  /** 派工事实（delegate 建立）：只用于认领与回收，不代表子会话已经拿到角色。 */
  const runs = new Map<string, DispatchRun>()
  /** 角色事实（绑定或分配后建立）：唯一真值来源，key 是真实会话 id。 */
  const roleFacts = new Map<string, RoleFact>()
  const runIds = new Map<string, string>()
  const claimed = new Set<string>()
  /** 在途认领：created 侧异步发起，结算前必须等它落地，避免「认领尚未生效就进入结算」。 */
  const claiming = new Map<string, Promise<void>>()
  /** 同一父会话的启动闸门：created 的到达顺序决定谁领走队首 intent，启动不能并发。 */
  const starting = new Map<string, Promise<void>>()
  let closed = false

  const subagentsOf = (): HostSubagents | undefined => ctx.get('subagents') as HostSubagents | undefined
  const teamOf = (): HostTeam | undefined => ctx.get('agentTeams') as HostTeam | undefined
  const agentsOf = (): HostAgents | undefined => ctx.get('agents') as HostAgents | undefined

  /** 登记任务的最低资格：服务在、Team 已开启、来源未关闭。 */
  const core = (parent?: unknown): RoleDelegationAvailability => {
    if (closed) return { ok: false, code: 'ROLE_DELEGATION_CLOSED', message: '自动派工已关闭：不再接受新派工' }
    if (subagentsOf() === undefined) return { ok: false, code: 'ROLE_DELEGATION_UNAVAILABLE', message: 'subagents 服务不可用：无法启动真实子代理' }
    const team = teamOf()
    if (team === undefined) return { ok: false, code: 'ROLE_DELEGATION_UNAVAILABLE', message: 'agentTeams 服务不可用：无法登记官方任务' }
    if (parent !== undefined && !team.isEnabled(parent)) {
      return { ok: false, code: 'TEAM_DISABLED', message: '当前根会话未开启 Agent Team：自动派工不可用' }
    }
    return { ok: true }
  }
  const availability = (parent?: unknown): RoleDelegationAvailability => {
    const base = core(parent)
    if (!base.ok) return base
    const subagents = subagentsOf()!
    const provider = subagents.getProvider?.(PROVIDER)
    if (provider === undefined) return { ok: false, code: 'ROLE_DELEGATION_UNAVAILABLE', message: `subagent provider "${PROVIDER}" 未注册` }
    if (provider.capabilities?.depthLimit !== true) {
      return { ok: false, code: 'ROLE_LEAF_LIMIT_UNAVAILABLE', message: `subagent provider "${PROVIDER}" 不支持 maxDepth：叶子限制未就绪，不伪称已施加` }
    }
    return { ok: true }
  }

  const assertRole = (value: unknown): DelegationRole => {
    if (typeof value !== 'string' || !roles.has(value)) {
      throw new RoleDelegationError('ROLE_INVALID', `未校验的执行角色值：${String(value)}；只接受 ${[...roles].join('/')}`)
    }
    return value as DelegationRole
  }

  /**
   * 角色正文归 redteam 模块的 role-<role> 规则所有。规则缺失或被关闭时派工会得到一个
   * 没有角色的子代理，因此在这里明确报不可用，而不是把「启动成功」当成「角色已生效」。
   */
  const assertContent = (role: string): void => {
    let rules: readonly { id: string; enabled?: boolean }[]
    try {
      rules = readModuleRules(join(options.moduleRoot, ROLE_MODULE_ID)).rules
    } catch {
      // 内容模块根本不在（例如只有服务桩的环境）：不在派工层伪造阻断，
      // 装配链本就投不出角色；能读到规则时才按启用状态判。
      return
    }
    const rule = rules.find(item => item.id === 'role-' + role)
    if (rule === undefined || rule.enabled === false) {
      throw new RoleDelegationError('ROLE_CONTENT_UNAVAILABLE', `角色内容规则 role-${role} 缺失或已关闭：派工无法在子代理首请求投递角色`)
    }
  }

  const remember = (session: DelegationSession, fact: RoleFact): void => {
    try {
      (session.append as unknown as (type: string, payload: Record<string, unknown>) => unknown)(ROLE_BINDING_EVENT, {
        role: fact.role,
        ...(fact.taskId === undefined ? {} : { taskId: fact.taskId }),
        ...(fact.parentSession === undefined ? {} : { parentSession: fact.parentSession }),
      })
    } catch (error) {
      // child 已 dispose 时官方拒绝追加；角色在本次运行内仍可用，只是无法跨恢复核验。
      warn(`prompt-tool: 角色事件写入失败（跨恢复不可核验）：${String((error as Error)?.message ?? error)}`)
    }
    roleFacts.set(session.id, fact)
  }

  /** 只从官方持久事实恢复：child 自己的角色事件 + header.parentSession 交叉。 */
  const folded = (session: DelegationSession): RoleFact | undefined => {
    let events: readonly unknown[]
    try { events = session.snapshotEvents() } catch { return undefined }
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index] as { type?: unknown; data?: unknown } | undefined
      if (event?.type !== ROLE_BINDING_EVENT) continue
      const data = event.data as Record<string, unknown> | undefined
      const role = text(data?.role)
      const parentSession = text(data?.parentSession)
      const taskId = text(data?.taskId)
      if (role === undefined || !roles.has(role) || parentSession === undefined) return undefined
      if (parentSession !== session.header.parentSession) return undefined
      return { role, parentSession, ...(taskId === undefined ? {} : { taskId }) }
    }
    return undefined
  }

  const claim = async (childId: string, taskId: string): Promise<void> => {
    // 官方只在子会话登记 resident 归属后才认它为 caller，而 agent/created 早于该登记；
    // 并发派发时这个窗口会拉长，因此按次数重试，而不是把「认领失败」当成「任务没 owner」。
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      try {
        const team = teamOf()
        const agent = agentsOf()?.get(childId)
        if (team === undefined || agent === undefined) return
        // 官方任务：认领由子代理自己发起，owner 即真实 child session。
        const task = team.getTask(agent, taskId)
        if (task.status !== 'pending') return
        await team.updateTask(agent, { taskId, expectedRevision: task.revision, action: 'claim' })
        return
      } catch (error) {
        if (attempt === CLAIM_ATTEMPTS - 1) {
          warn(`prompt-tool: 官方任务认领未完成（${taskId}）：${String((error as Error)?.message ?? error)}`)
          return
        }
        // 上下文已随插件/会话释放时不再重试，避免对已失效的官方服务继续写入。
        if (/inactive context/.test(String((error as Error)?.message ?? ''))) return
        // 释放后不再对官方任务写 claim：在途重试必须能被 closed 打断（S-04）。
        await new Promise(resolve => setTimeout(resolve, CLAIM_RETRY_MS))
        if (closed) return
      }
    }
  }

  /** 等 created 侧把本次 child 的角色事实落地：启动返回时它可能还没被派发到。 */
  const boundOnce = async (childId: string): Promise<void> => {
    if (childId === '') return
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      if (roleFacts.has(childId)) return
      await new Promise(resolve => setTimeout(resolve, CLAIM_RETRY_MS))
      if (closed) return
    }
  }

  // 事件名由 subagent 包声明；本包不依赖其类型，只读它携带的运行身份。
  // 这里用 events.on + 显式 offStart：本 service 的 ctx 不是装配 fiber，包 ctx.effect 会在释放期
  // 与 dispose 重复解绑；订阅生命周期由 runtime.dispose() 统一收口。
  const offStart = ctx.events.on('subagent/start', (info: unknown) => {
    const run = info as { readonly id?: unknown; readonly runId?: unknown } | undefined
    const childId = text(run?.id)
    if (childId === undefined) return
    const runId = text(run?.runId)
    if (runId !== undefined) runIds.set(childId, runId)
    const taskId = (runs.get(childId) ?? roleFacts.get(childId))?.taskId
    if (taskId === undefined || claimed.has(childId)) return
    claimed.add(childId)
    void claim(childId, taskId)
  })

  const takeIntent = (parentSession: string): PendingIntent | undefined => {
    const queue = intents.get(parentSession)
    const intent = queue?.shift()
    if (queue !== undefined && queue.length === 0) intents.delete(parentSession)
    return intent
  }
  const dropIntent = (token: string): void => {
    for (const [parentSession, queue] of intents) {
      const kept = queue.filter(intent => intent.token !== token)
      if (kept.length === 0) intents.delete(parentSession)
      else intents.set(parentSession, kept)
    }
  }

  return {
    availability,

    async submitTask(parent, request) {
      const reason = core(parent)
      if (!reason.ok) throw new RoleDelegationError(reason.code, reason.message)
      // Team 是任务/依赖/版本的唯一所有者：这里只透传官方写入，不缓存第二份。
      return await teamOf()!.createTask(parent, {
        subject: request.subject,
        description: request.description,
        ...(request.blockedBy === undefined ? {} : { blockedBy: request.blockedBy }),
        ...(request.writeScopes === undefined ? {} : { writeScopes: request.writeScopes }),
      })
    },

    async delegate(request) {
      const reason = availability(request.parent)
      if (!reason.ok) throw new RoleDelegationError(reason.code, reason.message)
      const role = assertRole(request.role)
      if (!(EXECUTABLE_ROLES as readonly string[]).includes(role)) {
        throw new RoleDelegationError('ROLE_NOT_EXECUTABLE', `${role} 是真实根会话的指挥角色，不能授予子代理；可派：${EXECUTABLE_ROLES.join('/')}`)
      }
      assertContent(role)
      const taskId = text(request.taskId)
      if (taskId === undefined) throw new RoleDelegationError('ROLE_TASK_REQUIRED', '角色派工必须绑定一项官方 Team 任务')
      const session = sessionOf(request.parent)
      if (session === undefined) throw new RoleDelegationError('ROLE_PARENT_REQUIRED', '角色派工需要真实父 Agent 身份')
      const team = teamOf()!
      // 未知任务/已完成任务保持官方语义：读不到就让官方错误冒泡。
      const task = team.getTask(request.parent, taskId)
      if (task.status === 'completed' || task.status === 'deleted') {
        throw new RoleDelegationError('ROLE_TASK_SETTLED', `官方任务 ${taskId} 已是 ${task.status}，不能再派工`)
      }
      const token = randomUUID()
      const queue = intents.get(session.id) ?? []
      queue.push({ role, taskId, token })
      intents.set(session.id, queue)
      // 队首 intent 由 created 的到达顺序领走：并发启动会让两个 child 交叉领到对方的任务，
      // 认领落在 A 的任务上、结算读的是 B 的任务，两边都报 owner-mismatch。
      // 因此同一父会话的启动串行，并且等到本次 child 的角色事实落地再放行下一次。
      const previous = starting.get(session.id) ?? Promise.resolve()
      let releaseStart: () => void = () => {}
      starting.set(session.id, new Promise<void>(resolve => { releaseStart = resolve }))
      let activation: Awaited<ReturnType<HostSubagents['startActivation']>>
      try {
        await previous
        activation = await subagentsOf()!.startActivation({
          provider: PROVIDER,
          label: request.label,
          prompt: [{ type: 'text', text: request.prompt }],
          parent: request.parent,
          signal: request.signal,
          delivery: 'caller',
          // 五执行角色默认叶子：宿主无默认值，必须显式给。
          maxDepth: LEAF_MAX_DEPTH,
        })
        // created 派发可能略晚于 startActivation 返回：等本次 child 消费掉自己那条 intent 再放行。
        await boundOnce(text(activation.childId) ?? '')
      } catch (error) {
        // 启动失败/取消：立即释放这次资格，绝不留可被下一个无关 child 领走的 intent。
        dropIntent(token)
        throw error
      } finally {
        releaseStart()
      }
      const childId = text(activation.childId) ?? ''
      if (!runs.has(childId)) runs.set(childId, { role, taskId, parentSession: session.id })
      const runId = runIds.get(childId)
      return {
        role,
        taskId,
        childId,
        ...(runId === undefined ? {} : { runId }),
        result: activation.result as Promise<SubagentOutcome>,
        activation,
      }
    },

    async bindCreated(agent) {
      // agent/created 的监听器被 await：这里失败也绝不能中断官方会话创建。
      try {
        const session = sessionOf(agent)
        if (session === undefined) return
        const parentSession = text(session.header.parentSession)
        if (parentSession === undefined) return
        const intent = takeIntent(parentSession)
        if (intent === undefined) {
          const restored = folded(session)
          if (restored !== undefined && !roleFacts.has(session.id)) roleFacts.set(session.id, restored)
          return
        }
        if (roleFacts.has(session.id)) {
          warn(`prompt-tool: 子会话 ${session.id} 已有执行角色，忽略第二次绑定`)
          return
        }
        // 先给装配链，再写持久事件：首请求必须已含角色正文。
        remember(session, { role: intent.role, taskId: intent.taskId, parentSession })
        // 认领不在这里 await：官方在 created 派发**settle 之后**才登记 child 的 resident 归属，
        // 而 created 派发是串行的——await 会同时挡住归属登记和后一个子会话的 created。
        // claim 自带重试，等在归属窗口内认领到同一次真实子会话；在途 Promise 留给 settle 前 await。
        const pending = claim(session.id, intent.taskId)
        claiming.set(session.id, pending)
        void pending.finally(() => { if (claiming.get(session.id) === pending) claiming.delete(session.id) })
      } catch (error) {
        warn(`prompt-tool: 角色绑定未完成：${String((error as Error)?.message ?? error)}`)
      }
    },

    async settle(run, options = {}) {
      const result = await run.result
      const missing = { completed: false, taskId: run.taskId } as const
      if (result?.stopReason !== 'completed') return { ...missing, reason: `stopReason:${String(result?.stopReason ?? 'unknown')}` }
      // 无证据不算完成：没有 assistant 输出的运行不产生成果。
      if (!Array.isArray(result.output) || result.output.length === 0) return { ...missing, reason: 'no-evidence' }
      const team = teamOf()
      if (team === undefined) return { ...missing, reason: 'agentTeams-unavailable' }
      const parentSession = roleFacts.get(run.childId)?.parentSession ?? runs.get(run.childId)?.parentSession
      const caller = options.caller ?? (parentSession === undefined ? undefined : agentsOf()?.get(parentSession))
      if (caller === undefined) return { ...missing, reason: 'caller-unavailable' }
      // 本次认领可能仍在重试窗口里：等它落地再按官方视图复核归属，不把「还没认领」读成「不是我的任务」。
      await claiming.get(run.childId)
      const task = team.getTask(caller, run.taskId)
      // 结果必须匹配真实运行：任务归属不是这次启动的 child 就不认领这次成果。
      if (task.ownerId !== run.childId) return { ...missing, reason: 'owner-mismatch' }
      const updated = await team.updateTask(caller, {
        taskId: run.taskId,
        expectedRevision: options.expectedRevision ?? task.revision,
        action: 'complete',
      })
      return { completed: true, taskId: run.taskId, status: updated.status, revision: updated.revision }
    },

    roleFactsOf(moduleId, sessionId) {
      if (moduleId !== ROLE_MODULE_ID) return undefined
      const fact = roleFacts.get(sessionId)
      return fact === undefined ? undefined : { role: fact.role }
    },

    assignRootRole(agent, role) {
      const value = assertRole(role)
      const session = sessionOf(agent)
      if (session === undefined) throw new RoleDelegationError('ROLE_PARENT_REQUIRED', '分配角色需要真实根 Agent 身份')
      // 指挥角色只作用于真实根会话：子会话拿到它只会得到一份没有受众的静默失败。
      if (session.header.parentSession !== undefined) {
        throw new RoleDelegationError('ROLE_PARENT_REQUIRED', `指挥角色 ${value} 只作用于真实根 Agent，子会话 ${session.id} 不能拿它`)
      }
      remember(session, { role: value })
    },

    release(parent) {
      if (parent === undefined) { intents.clear(); return }
      const id = typeof parent === 'string' ? parent : sessionOf(parent)?.id
      if (id !== undefined) intents.delete(id)
    },

    close() { closed = true; intents.clear() },

    bindings: () => [...roleFacts.entries()]
      .filter(([, fact]) => fact.parentSession !== undefined)
      .map(([childSession, fact]) => ({
        childSession,
        role: fact.role,
        ...(fact.taskId === undefined ? {} : { taskId: fact.taskId }),
      })),

    tasksOf(parent) {
      const team = teamOf()
      if (team?.listTasks === undefined) return []
      return team.listTasks(parent)
    },

    async message(sender, targetId, text, signal) {
      const subagents = subagentsOf()
      if (subagents?.sendMessage === undefined) {
        throw new RoleDelegationError('ROLE_MESSAGE_UNAVAILABLE', 'subagents 服务不支持 sendMessage：官方消息交接不可用')
      }
      // 官方 sendMessage 直接读 options.signal.throwIfAborted()：缺 signal 会变成宿主 TypeError，
      // 也不会真正取消；这里明确拒绝，让调用方补一次真实取消身份。
      if (signal === undefined || typeof (signal as AbortSignal).throwIfAborted !== 'function') {
        throw new RoleDelegationError('ROLE_MESSAGE_SIGNAL_REQUIRED', '官方 sendMessage 需要 AbortSignal：缺 signal 时明确拒绝，不伪造取消身份')
      }
      return await subagents.sendMessage(sender, targetId, [{ type: 'text', text }], { signal })
    },

    revokeRole(target) {
      const id = typeof target === 'string' ? target : sessionOf(target)?.id
      if (id !== undefined) roleFacts.delete(id)
    },

    dispose() {
      closed = true
      intents.clear()
      runs.clear()
      roleFacts.clear()
      runIds.clear()
      claimed.clear()
      claiming.clear()
      starting.clear()
      offStart()
    },
  }
}

/**
 * 能力协议选择：05 报告留给 07/08 的调用契约，把选红队/普通协议收成一个命名入口。
 * 关闭派工**不要**自动调回普通协议（规格 9/33）。
 */
export function selectCapabilityProtocol(moduleRoot: string, branch: 'redteam' | 'official'): void {
  const [moduleId, ruleId] = branch === 'redteam'
    ? [ROLE_MODULE_ID, 'protocol-redteam'] as const
    : ['unrestricted', 'protocol-official'] as const
  const directory = join(moduleRoot, moduleId)
  const snapshot = readModuleRules(directory)
  // 已选中即幂等短路：否则每次保存模块都会再写一次 module.yml，让客户端拿到的 revision 落后一格（S-03）。
  if (snapshot.rules.find(rule => rule.id === ruleId)?.enabled === true) return
  editModuleRules(directory, { expectedRevisions: snapshot.revisions, activateRuleId: ruleId })
}
