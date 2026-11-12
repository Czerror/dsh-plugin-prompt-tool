import { randomUUID } from 'node:crypto'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { BRIDGE_ENDPOINTS } from '../../shared/bridge-contract.ts'
import type { RewindRequest, RewindResult, RewindTargetResult } from '../../shared/rewind.ts'
import type { BridgeRuntime } from '../bridge-runtime.ts'
import { rewindEnabled } from '../../../engine/rewind-control.mjs'
import { isRewindMarker, rewindPlan } from '../../../engine/rewind-marker.mjs'
import { historyEvents } from '../../../engine/history.mjs'
import { rewindTodos } from '../../../engine/rewind-todo.mjs'

type Plan = ReturnType<typeof rewindPlan> & { agent: Agent; runId?: string; mode: 'once' | 'round'; handle?: AgentHandle; committed?: RewindTargetResult }
interface Run { id: string; parent: Agent; parentTurn: number; child: Agent; fromSeq: number; runId: string; endSeq?: number }
interface Grant {
  principal: unknown
  expires: number
}
interface Ticket {
  request: RewindRequest
  credential: string
  plans: Plan[]
  expires: number
  result?: Promise<RewindResult>
  attempts?: Map<string, Promise<RewindResult>>
}
interface Access {
  decide(request: { principal: unknown; action: string; resources: { kind: string; id: string }[]; args: unknown[] }): { kind: string }
}
const GLOBAL_CREDENTIAL = '__PROMPT_TOOL_REWIND__'
const TTL = 10 * 60_000
const string = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
const isCatalog = (event: { type: string }): boolean => event.type === 'subagent/catalog'

/** One page grant and one bounded transaction; no client supplied ranges or child lists. */
export function registerRewind(runtime: BridgeRuntime): (() => void)[] {
  const ctx = runtime.agentScope
  const grants = new Map<string, Grant>(), tickets = new Map<string, Ticket>(), locks = new Map<string, string>()
  const sessions = new WeakSet<object>()
  const runs = new Map<string, Run>()
  const releases: (() => void)[] = []
  let active = true
  const sweep = setInterval(() => {
    for (const [key, grant] of grants) if (grant.expires <= Date.now()) grants.delete(key)
    for (const [key, ticket] of tickets) if (ticket.expires <= Date.now() && !ticket.plans.some(plan => locks.has(plan.agent.id))) {
      tickets.delete(key)
      for (const plan of ticket.plans) void plan.handle?.dispose().catch(error => ctx.logger.warn('回退临时子会话释放失败：' + errorText(error)))
    }
  }, 60_000)
  sweep.unref()
  releases.push(() => clearInterval(sweep))
  const attach = (session: Agent['session']): void => {
    if (sessions.has(session)) return
    sessions.add(session)
    const original = session.deriveEventMessage
    const messages = session.deriveMessages
    const interpret: typeof original = function (this: Agent['session'], event) {
      if (!active) return original.call(this, event)
      if (isRewindMarker(event)) return null
      return original.call(this, event)
    }
    session.deriveEventMessage = interpret
    const derive: typeof messages = function (this: Agent['session']) {
      if (!active) return messages.call(this)
      const markers = new Set(historyEvents(this).filter(isRewindMarker).map(event => (event.data as { id: string }).id))
      return messages.call(this).filter(message => !markers.has(message.id))
    }
    session.deriveMessages = derive
    releases.push(() => {
      if (session.deriveEventMessage === interpret) session.deriveEventMessage = original
      if (session.deriveMessages === derive) session.deriveMessages = messages
    })
  }
  const authorize = (credential: string, sessionId: string): void => {
    const grant = grants.get(credential)
    if (!active || !grant || grant.expires <= Date.now()) throw new Error('当前页面回退凭据已失效，请刷新页面')
    const access = ctx.get('remoteAccess' as never) as unknown as Access | undefined
    if (!access || access.decide({ principal: grant.principal, action: 'session/prompt', resources: [{ kind: 'session', id: sessionId }], args: [] }).kind !== 'allow') {
      throw new Error('当前页面没有该会话的操作权限')
    }
  }
  const local = (id: string): Agent => {
    const agent = ctx.agents.get(id as Agent['id'])
    if (!agent) throw new Error('目标不是当前可操作的本地会话')
    attach(agent.session)
    return agent
  }
  const fixedPlan = (agent: Agent, mode: 'once' | 'round' = 'once'): Plan => {
    if (!rewindEnabled(agent)) throw new Error('当前会话未启用会话回退规则')
    return { ...rewindPlan(agent.session, mode, (source, turnSeq) => {
      const run = runs.get(source.senderSessionId)
      return run?.parent.id === agent.id && run.parentTurn === turnSeq && run.endSeq !== undefined
    }), agent, mode }
  }
  const check = (plan: Plan, credential: string): Plan => {
    authorize(credential, plan.agent.id)
    if (local(plan.agent.id) !== plan.agent || plan.agent.session !== plan.session) throw new Error('目标会话所有者已改变')
    if (plan.committed) {
      if (historyEvents(plan.session).findLast(event => event.type === 'turn/start')?.seq !== plan.observedTurnSeq) throw new Error('会话已进入新轮，不能重试旧待办更新')
      return plan
    }
    const current = fixedPlan(plan.agent, plan.mode)
    if (current.turnSeq !== plan.turnSeq || current.observedTurnSeq !== plan.observedTurnSeq || current.inputId !== plan.inputId || current.inputSeq !== plan.inputSeq || current.lastInputSeq !== plan.lastInputSeq) throw new Error('会话已进入新输入或新轮，请重新回退')
    if (plan.runId !== undefined && runs.get(plan.agent.id)?.runId !== plan.runId) throw new Error('子代理执行身份已改变')
    return current
  }

  const roundPlans = async (caller: Agent, credential: string): Promise<Plan[]> => {
    let main = caller
    const seen = new Set<string>()
    while (main.session.header.origin === 'subagent' && main.session.header.parentSession) {
      if (seen.has(main.id)) throw new Error('主子会话关联存在循环')
      seen.add(main.id)
      const run = runs.get(main.id)
      if (!run || run.child !== main || run.parent.id !== main.session.header.parentSession) throw new Error('缺少该子代理的真实主轮关联，请在委派前启用插件')
      main = run.parent
    }
    const plans = [fixedPlan(main, 'round')]
    const selected = new Set([main.id])
    try {
    for (let index = 0; index < plans.length; index++) {
      const parent = plans[index]!
      const history = historyEvents(parent.agent.session)
      const nextTurn = history.find(event => event.type === 'turn/start' && event.seq > parent.turnSeq)?.seq ?? Infinity
      const catalog = history.filter(isCatalog)
      for (const run of runs.values()) {
        if (run.parent.id !== parent.agent.id || run.parentTurn !== parent.turnSeq) continue
        if (selected.has(run.child.id)) throw new Error('主子会话关联存在循环')
        selected.add(run.child.id)
        if (!catalog.some(event => (event.data as { childId?: string }).childId === run.id)) throw new Error('子代理缺少官方目录事实')
        authorize(credential, run.id)
        let child = ctx.agents.get(run.id as Agent['id']), handle: AgentHandle | undefined
        if (!child) {
          if (run.endSeq === undefined) throw new Error('子代理缺少已观察的完成边界')
          handle = await ctx.agents.resume({ resumeSessionId: run.child.id, setup: (_scope, restored) => {
            if (restored.session.header.parentSession !== parent.agent.id || restored.session.header.origin !== 'subagent') throw new Error('子代理持久父身份已改变')
            if (historyEvents(restored.session).findLast(event => event.type !== 'session/end-seed')?.seq !== run.endSeq) throw new Error('子代理持久事件边界已改变，不能自动恢复回退')
            if (restored.inbox.nextStep.length > 0 || restored.inbox.nextTurn.length > 0) throw new Error('子代理存在待执行输入，不能自动恢复回退')
          } })
          child = handle.agent
          attach(child.session)
        } else if (child !== run.child) throw new Error('子代理所有者已改变')
        let plan: Plan
        try {
          if (child.session.header.parentSession !== parent.agent.id) throw new Error('子代理主会话已改变')
          plan = { ...fixedPlan(child, 'round'), handle }
          if (plan.inputSeq < run.fromSeq) throw new Error('子代理当前输入不属于该次真实委派')
        } catch (error) { await handle?.dispose(); throw error }
        plans.push({ ...plan, runId: run.runId })
      }
      // A catalog child created during this turn without an observed activation is unsafe.
      for (const event of catalog) {
        const id = (event.data as { childId?: string }).childId
        if (event.seq > parent.turnSeq && event.seq < nextTurn && id && runs.get(id)?.parentTurn !== parent.turnSeq) throw new Error('该轮含缺少真实执行关联的子代理')
      }
    }
    return plans
    } catch (error) {
      for (const plan of plans) await plan.handle?.dispose()
      throw error
    }
  }

  releases.push(ctx.on('agent/created', ({ agent }) => { attach(agent.session); return undefined }))
  for (const agent of ctx.agents.list()) attach(agent.session)
  releases.push(ctx.on('agent/disposed', ({ agent }) => {
    for (const [id, run] of runs) {
      if (run.child === agent) run.endSeq = historyEvents(agent.session).at(-1)?.seq
      if (run.parent === agent && agent.session.header.origin !== 'subagent') runs.delete(id)
    }
  }))
  // This official lifecycle is emitted only after local residency is published.
  const listenRun = ctx.on.bind(ctx) as unknown as (name: 'subagent/start', handler: (info: { id: string; parentSessionId: string; runId: string; local: boolean }) => void) => () => void
  releases.push(listenRun('subagent/start', info => {
    const parent = ctx.agents.get(info.parentSessionId as Agent['id']), child = ctx.agents.get(info.id as Agent['id'])
    if (!info.local || !parent || !child || parent.status === 'idle') return
    const turn = historyEvents(parent.session).findLast(event => event.type === 'turn/start')
    if (!turn || child.session.header.parentSession !== parent.id || runs.size >= 256 && !runs.has(info.id)) return
    runs.set(info.id, { id: info.id, parent, child, parentTurn: turn.seq, fromSeq: historyEvents(child.session).length, runId: info.runId })
  }))
  const commitTarget = async (plan: Plan, credential: string): Promise<RewindTargetResult> => {
    try {
      check(plan, credential)
      if (plan.agent.status !== 'idle') {
        plan.agent.cancel({ kind: 'user' }, { keepInbox: true })
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([plan.agent.whenIdle(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('等待原轮静止超时；未提交回退')), 10_000) })])
        } finally { if (timer !== undefined) clearTimeout(timer) }
      }
      const result = await plan.agent.runMaintenance(async signal => {
        signal.throwIfAborted()
        const current = check(plan, credential)
        if (plan.committed) { rewindTodos(plan.agent); return plan.committed }
        const markerId = 'rewind-pt-' + randomUUID()
        const refs = current.refs
        plan.agent.session.append('user/message', { id: markerId as never, role: 'user', source: { kind: 'user' }, content: [] }, {
          surfaceOp: { op: 'replace', startSeq: refs[0] as never, endSeq: refs.at(-1) as never },
          sourceEventSeqs: refs as never,
        })
        plan.committed = { sessionId: plan.agent.id, status: 'committed' as const, markerId, sourceEventSeqs: refs, text: plan.text }
        rewindTodos(plan.agent)
        return plan.committed
      })
      try { await plan.handle?.dispose(); plan.handle = undefined }
      catch (error) { return { ...result, message: '已提交回退，临时子会话释放失败：' + errorText(error) } }
      return result
    } catch (error) { return { ...plan.committed, sessionId: plan.agent.id, status: 'failed', message: (plan.committed ? '历史回退已提交；待办更新未完成，可重试：' : '') + errorText(error) } }
  }

  releases.push(ctx.on('webserver/index-inject', (table, peer) => {
    for (const [key, grant] of grants) if (grant.expires <= Date.now()) grants.delete(key)
    const credential = randomUUID()
    grants.set(credential, { principal: peer.principal, expires: Date.now() + TTL })
    table.push({ kind: 'global', name: GLOBAL_CREDENTIAL, value: credential })
  }))
  const route = runtime.registerAgentRoute(BRIDGE_ENDPOINTS.rewind, { body: 'json', handle: async tx => {
    const request = tx.record
    if (!string(request.sessionId) || !string(request.requestId) || !string(request.credential)
      || !['preview', 'commit', 'retry'].includes(request.phase as string) || (request.mode !== 'once' && request.mode !== 'round')
      || (request.boundary !== undefined && !string(request.boundary))) {
      tx.write(400, { ok: false, code: 'rewind-invalid', message: '回退请求字段无效' }); return
    }
    const input = request as unknown as RewindRequest
    try { authorize(input.credential, input.sessionId) }
    catch (error) { tx.write(403, { ok: false, code: 'rewind-forbidden', message: errorText(error) }); return }
    try {
      if (input.phase === 'preview') {
        if (input.boundary !== undefined) throw new Error('预览不能携带提交边界')
        const agent = local(input.sessionId)
        if (tickets.size >= 256) throw new Error('当前页面回退请求过多，请等待旧边界到期')
        const plans = input.mode === 'round' ? await roundPlans(agent, input.credential) : [fixedPlan(agent)], boundary = randomUUID()
        try { for (const plan of plans) check(plan, input.credential) }
        catch (error) { for (const plan of plans) await plan.handle?.dispose(); throw error }
        tickets.set(boundary, { request: input, credential: input.credential, plans, expires: Date.now() + TTL })
        tx.write(200, { ok: true, value: { sessionId: input.sessionId, boundary, targets: plans.map(plan => ({ sessionId: plan.agent.id, status: 'unchanged' })) } }); return
      }
      const ticket = input.boundary === undefined ? undefined : tickets.get(input.boundary)
      if (!ticket || ticket.expires <= Date.now() || ticket.credential !== input.credential || ticket.request.sessionId !== input.sessionId || ticket.request.mode !== input.mode || input.phase === 'commit' && ticket.request.requestId !== input.requestId) throw new Error('回退边界凭据不匹配或过期，请重新预览')
      if (input.phase === 'retry') {
        if (!ticket.result || input.requestId === ticket.request.requestId) throw new Error('重试需要已完成结果及新的请求身份')
        ticket.attempts ??= new Map()
        const cached = ticket.attempts.get(input.requestId)
        if (cached) { tx.write(200, { ok: true, value: await cached }); return }
        if (ticket.attempts.size >= 8) throw new Error('该边界重试次数已达上限')
        const previous = await ticket.result
        const concurrent = ticket.attempts.get(input.requestId)
        if (concurrent) { tx.write(200, { ok: true, value: await concurrent }); return }
        const failed = ticket.plans.filter(plan => previous.targets.some(target => target.sessionId === plan.agent.id && target.status === 'failed'))
        for (const plan of failed) {
          if (locks.has(plan.agent.id)) throw new Error('该会话已有回退正在处理')
          check(plan, input.credential)
        }
        for (const plan of failed) locks.set(plan.agent.id, input.boundary!)
        const retry = (async () => {
          const targets = [...previous.targets]
          try {
            for (const plan of failed) {
              const target = await commitTarget(plan, input.credential)
              targets[targets.findIndex(value => value.sessionId === plan.agent.id)] = target
            }
            return { ...previous, targets }
          } finally { for (const plan of failed) if (locks.get(plan.agent.id) === input.boundary) locks.delete(plan.agent.id) }
        })()
        ticket.attempts.set(input.requestId, retry)
        ticket.result = retry
        tx.write(200, { ok: true, value: await retry }); return
      }
      if (!ticket.result) {
        if (ticket.expires <= Date.now()) throw new Error('回退边界已过期')
        for (const plan of ticket.plans) {
          if (locks.has(plan.agent.id)) throw new Error('该会话已有回退正在处理')
          check(plan, input.credential)
        }
        for (const plan of ticket.plans) locks.set(plan.agent.id, input.boundary!)
        ticket.result = (async () => {
          try {
            const targets: RewindTargetResult[] = []
            for (const plan of ticket.plans) targets.push(await commitTarget(plan, input.credential))
            return { sessionId: input.sessionId, boundary: input.boundary!, targets }
          } finally { for (const plan of ticket.plans) if (locks.get(plan.agent.id) === input.boundary) locks.delete(plan.agent.id) }
        })()
      }
      tx.write(200, { ok: true, value: await ticket.result })
    } catch (error) { tx.write(409, { ok: false, code: 'rewind-rejected', message: errorText(error) }) }
  } })
  return [route, () => {
    active = false
    grants.clear()
    for (const ticket of tickets.values()) for (const plan of ticket.plans) void plan.handle?.dispose().catch(error => ctx.logger.warn('回退临时子会话释放失败：' + errorText(error)))
    tickets.clear()
    runs.clear()
    for (const release of releases.reverse()) release()
  }]
}
