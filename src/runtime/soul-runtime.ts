/** Soul宿主接线：历史只读句柄、检索授权与SELF/维护共享owner。 */
import { createSoulDelivery, proposeSoulDelivery, deliverySource, messageText, digest } from './soul-delivery.ts'
import { readModuleLocalCommitInfo } from '../host/module-local-state.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SoulStateObservation } from './soul-state-tools.ts'
import type { ModuleToolHost } from '../host/module-tool-target.ts'
import { assertModuleSnapshotSource } from '../host/module-install.ts'
import { readModuleFacts } from '../host/module-params.ts'
import { deriveSoulSelfParts, renderSoulSelf, validateSelfBudget } from '../host/soul-self.ts'
import { eventMessage } from '../../engine/delivery.mjs'
import { readSoulState } from '../host/soul-state.ts'
import { readSoulLedgerProjection } from '../host/soul-ledger.ts'
import { readSoulDiagnostics } from '../host/soul-diagnostics.ts'
import { readSoulUpgradePreview } from '../host/soul-upgrade.ts'
import { readModuleVariables } from '../host/module-variables.ts'
import type { SessionVariableOwner } from '../host/session-variables.ts'
import type { SoulKnowledgeOwner } from '../host/soul-knowledge.ts'
import { evaluateTemplate } from '../../engine/template-evaluation.mjs'
import { interpolateVariables, stripUnresolvedRefs } from '../../engine/interpolate.mjs'
import { readSoulPressure } from './soul-pressure.ts'
import type { SoulPressure } from './soul-pressure.ts'
import { createSoulReminder } from './soul-reminder.ts'
import { recoveryObservationOf } from '../../engine/generation-recovery.mjs'
import type { RuleSoulReminder } from '../../engine/rule-runtime.mjs'
import { createModuleRetrievalProvider } from './module-retrieval-tools.ts'
import { loadKnowledgeSession } from './soul-knowledge.ts'
import { createSoulMaintenanceProvider } from './soul-maintenance.ts'
import { createSoulAssisted } from './soul-assisted.ts'
import { SOUL_MAINTENANCE_SERVICE, SOUL_SELF_SERVICE, toolServiceName } from '../../engine/service-names.mjs'

export function installSoulRuntime(ctx: Context, host: ModuleToolHost, moduleIds: (id: string) => readonly string[], sessions: () => SessionVariableOwner | undefined, knowledge?: () => SoulKnowledgeOwner | undefined): SoulStateObservation {
  let active = true
  const sessionOwner = (): SessionVariableOwner => {
    const owner = sessions?.()
    if (owner === undefined) throw new Error('会话变量持久化依赖不可用，不能读取当前状态')
    return owner
  }
  const rendered = new Map<string, { at: string; candidates: string[]; sessionId: string }>()
  const acceptedDelivery = createSoulDelivery()
  const delivered = new Map<string, string>()
  const source = (id: string, agent: Agent, signal?: AbortSignal): string => {
    signal?.throwIfAborted()
    if (!active || !agent?.session?.id || !moduleIds(agent.id).includes(id)) throw new Error('SELF来源模块未参与本Agent装配')
    return assertModuleSnapshotSource(host.root, id)
  }
  const keyOf = (id: string, agent: Agent): string => JSON.stringify([id, agent.session.id])
  const withEvidence = async <T>(ids: readonly string[], agent: Agent, signal: AbortSignal | undefined, callback: () => T | Promise<T>): Promise<T> => {
    const owner = knowledge?.()
    if (knowledge && !owner) throw new Error('学习授权持久状态不可用')
    const scopes = ids.map(id => ({ directory: source(id, agent, signal), sessionId: agent.session.id })).filter(scope => owner?.status(scope.directory).state !== 'unbound')
    const consume = () => {
      if (knowledge?.() !== owner) throw new Error('学习持久状态已变化')
      for (const id of ids) source(id, agent, signal)
      return callback()
    }
    return owner && scopes.length ? owner.withEvidence(scopes, signal, consume) : consume()
  }
  const admit = async (id: string, agent: Agent, seq?: number, attached = false) => {
    const dir = source(id, agent), owner = knowledge?.()
    if (!owner || owner.status(dir).state === 'unbound') return
    const parentId = agent.session.header.parentSession
    if (parentId) {
      const subagents = ctx.get('subagents') as { rootOf(agent: Agent): Agent } | undefined
      const agents = ctx.get('agents') as { get(id: string): Agent | undefined } | undefined
      const parent = agents?.get(parentId)
      if (!parent || !subagents || subagents.rootOf(parent) !== subagents.rootOf(agent)) throw new Error('子代理真实委派关系不可核实')
      source(id, parent)
    }
    await owner.observe(dir, agent.session.id, seq, parentId, () => { source(id, agent) }, attached, agent.session.header.cwd)
    source(id, agent)
  }
  const activityOf = (agent: Agent): string | null => {
    const events = agent.session.snapshotEvents()
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!
      if (['user/message', 'assistant/message', 'tool/call', 'tool/result', 'step/start', 'turn/end'].includes(event.type)
        && Number.isFinite(event.time)) return new Date(event.time).toISOString()
    }
    return null
  }
  const assisted = createSoulAssisted(ctx, () => knowledge?.(), source, admit)
  // 定义暂时损坏时保留最近有效预算，不降低可用快照的注入上限。
  const budgets = new Map<string, { stamp: string; checkedAt: number; value: number }>()
  const readSelfBudget = (dir: string): number => {
    const hit = budgets.get(dir)
    let stamp = ''
    try { stamp = readModuleLocalCommitInfo(dir)?.generation ?? '' }
    catch { return hit?.value ?? validateSelfBudget() }
    if (hit !== undefined && hit.stamp === stamp && performance.now() - hit.checkedAt < 1000) return hit.value
    let value = hit?.value ?? validateSelfBudget()
    try {
      const facts = readModuleFacts(dir)
      if (facts.sourceMode !== 'unknown') value = validateSelfBudget(facts.effectiveConfigs?.['soul-maintenance']?.budgetBytes)
    }
    catch { /* 定义内容读取与预算校验失败不覆盖最近有效值。 */ }
    budgets.set(dir, { stamp, checkedAt: performance.now(), value })
    return value
  }
  const retrieval = createModuleRetrievalProvider(host, id => loadKnowledgeSession(ctx, id), knowledge)
  const maintenance = createSoulMaintenanceProvider({ refreshRetrieval: (agent, id, signal) => retrieval.refresh(agent, id, signal), withEvidence: (id, agent, signal, callback) => withEvidence([id], agent, signal, callback) })
  const legacyAllowed = (dir: string): boolean => {
    if (!knowledge) return true
    const owner = knowledge()
    if (!owner) throw new Error('知识来源授权持久状态不可用')
    return owner.status(dir).state === 'unbound'
  }
  const reminder = createSoulReminder((id, agent) => {
    const dir = source(id, agent as Agent)
    if (!legacyAllowed(dir)) throw new Error('旧账本待归类，停止自动提醒贡献')
    return readSoulLedgerProjection(dir)
  })
  const pressure = (dir: string, agent: Agent): SoulPressure | { state: 'disabled' } | { state: 'unknown'; reason: string } => {
    try {
      const thresholds = readModuleFacts(dir).effectiveConfigs?.['soul-maintenance']?.pressureThresholds
      return Array.isArray(thresholds) ? readSoulPressure(ctx, agent, thresholds) : { state: 'disabled' as const }
    } catch { return { state: 'unknown' as const, reason: '水位配置或会话观测不可用' } }
  }
  ctx.provide(toolServiceName('retrieval'), retrieval)
  ctx.provide(SOUL_MAINTENANCE_SERVICE, maintenance)
  const status = (id: string, agent: Agent) => {
    const dir = source(id, agent), ledger = readSoulLedgerProjection(dir), state = readSoulState(dir, agent.session.id, sessionOwner())
    return { clock: new Date().toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      sessionId: agent.session.id, revision: state.revision, mark: state.mark ? { ...state.mark } : null, activityAt: activityOf(agent),
      ledger: { total: ledger.total, open: ledger.open, pendingReview: ledger.pendingReview, initialized: ledger.initialized, pendingVersion: ledger.pendingVersion },
      index: { ...retrieval.status(agent, id) }, pressure: pressure(dir, agent),
      renderedAt: rendered.get(keyOf(id, agent))?.at ?? null, deliveredAt: delivered.get(keyOf(id, agent)) ?? null }
  }
  const readValue = (id: string, key: string, agent: Agent, signal?: AbortSignal): string | undefined => {
    const dir = source(id, agent, signal)
    if (!readModuleVariables(dir, { runtime: true }).enabled) return undefined
    if (key === 'session.id') return agent.session.id
    if (key === 'session.audience') return (agent.session.header.delegationDepth ?? 0) > 0 ? 'subagent' : 'main'
    if (key === 'clock.iso') return new Date().toISOString()
    if (key === 'clock.timeZone') return Intl.DateTimeFormat().resolvedOptions().timeZone
    if (key.startsWith('soul.')) {
      if (key === 'soul.learning' && !legacyAllowed(dir)) return knowledge?.()?.learning(dir, agent.session.id).map(row => row.text).join('\n')
      if (!legacyAllowed(dir)) return undefined
      if (key === 'soul.mark' || key === 'soul.markAt') {
        const mark = readSoulState(dir, agent.session.id, sessionOwner()).mark
        return key === 'soul.mark' ? mark?.text : mark?.recordedAt
      }
      const ledger = readSoulLedgerProjection(dir)
      if (key === 'soul.open') return String(ledger.open)
      if (key === 'soul.pendingReview') return String(ledger.pendingReview)
      if (key === 'soul.total') return String(ledger.total)
      if (key === 'soul.lead') return ledger.lead?.['概要']
      if (key === 'soul.leadSessionId') return ledger.lead?.by
    }
    if (key === 'index.state' || key === 'index.observedAt') {
      const index = retrieval.status(agent, id)
      return key === 'index.state' ? index.state : index.observedAt
    }
    if (key === 'pressure.state' || key === 'pressure.ratio') {
      const water = pressure(dir, agent)
      return key === 'pressure.state' ? water.state : water.state === 'known' ? String(water.ratio) : undefined
    }
    return undefined
  }
  ctx.provide(SOUL_SELF_SERVICE, {
    status,
    withEvidence,
    assistedStatus: assisted.status,
    requestAssisted: assisted.request,
    detached: assisted.detached,
    admit,
    attached: (id: string, agent: Agent, boundary: number) => admit(id, agent, boundary + 1, true),
    assertParticipating: source,
    readValue,
    reminder,
    renderChanges: (id: string, agent: Agent, signal?: AbortSignal) => withEvidence([id], agent, signal, () => {
      const dir = source(id, agent, signal), owner = knowledge?.()
      const audience = (agent.session.header.delegationDepth ?? 0) > 0 ? 'subagent' : 'main'
      const learning = owner?.status(dir).state === 'bound' ? owner.learning(dir, agent.session.id).map(row => ({ id: `learning:${row.id}`, text: `- ${row.text}`, protected: row.layer === 'core' || row.layer === 'locked' })) : []
      const facts: Array<{ id: string; text: string }> = []
      const ledger = readSoulLedgerProjection(dir)
      const allowed = legacyAllowed(dir) ? null : new Set(owner?.status(dir).binding?.continuity?.enabled ? owner.records(dir, agent.session.id).map(row => row.entryId) : [])
      if (ledger.lead && (allowed === null || allowed.has(ledger.lead.id))) facts.push({ id: 'ledger:lead', text: `- 当前主导：${ledger.lead.by}；${ledger.lead['概要']}` })
      for (const item of ledger.items) if (allowed === null || allowed.has(item.id)) facts.push({ id: `ledger:${item.id}`, text: `- [${item.status}] ${item.id}：${item.entry['概要']}` })
      const state = readSoulState(dir, agent.session.id, sessionOwner())
      if (state.mark) facts.push({ id: 'mark:session', text: `- 显式状态：${state.mark.text}` })
      const water = pressure(dir, agent)
      if (water.state === 'known' && water.level !== 'normal') facts.push({ id: 'pressure:warning', text: `- 上下文水位：${water.guidance}` })
      const parts = deriveSoulSelfParts(dir, agent, readSelfBudget(dir), learning, facts, sourceText => {
        if (!sourceText.includes('{{')) return { text: sourceText, revision: '' }
        const snapshot = readModuleVariables(dir, { runtime: true })
        if (!snapshot.enabled) return { text: stripUnresolvedRefs(interpolateVariables(sourceText, {}, agent.session)).text, revision: '' }
        const session = sessionOwner().read(dir, agent.session.id)
        const result = evaluateTemplate(sourceText, { module: snapshot.module, global: snapshot.global, sessionVariables: session.variables, session: agent.session, readOnly: true, sourceId: `${id}:self`, readRuntime: key => readValue(id, key, agent, signal) })
        return { text: result.text, revision: '' }
      })
      const proposal = proposeSoulDelivery(parts, acceptedDelivery(agent, id, audience), agent.session.id, audience, readSelfBudget(dir), water.state === 'known')
      if (!proposal) return null
      const { text } = proposal
      source(id, agent, signal)
      const key = keyOf(id, agent)
      if (rendered.size > 1024) rendered.delete(rendered.keys().next().value!)
      rendered.set(key, { at: new Date().toISOString(), candidates: [...(rendered.get(key)?.candidates ?? []), digest(text)].slice(-16), sessionId: agent.session.id })
      return proposal
    }),
    committed: (id: string, agent: Agent) => {
      source(id, agent)
      retrieval.invalidateModule(id)
      void maintenance.tick(id)
      return { state: maintenance.status(id).state === 'disabled' ? 'stale-maintenance-disabled' : 'refresh-pending' }
    },
    render: (id: string, agent: Agent, signal?: AbortSignal): Promise<string> => {
      const dir = source(id, agent, signal), budget = readSelfBudget(dir)
      return withEvidence([id], agent, signal, () => {
        const owner = knowledge?.()
        if (knowledge?.() !== owner) throw new Error('SELF学习持久状态已变化')
        if (source(id, agent, signal) !== dir) throw new Error('SELF来源发生变化')
        const state = readSoulState(dir, agent.session.id, sessionOwner())
        const water = pressure(dir, agent)
        const assistedState = assisted.status(id, agent)
        const handoff: string[] = []
        if (owner?.status(dir).binding?.continuity?.enabled) {
          const allowed = new Set(owner.records(dir, agent.session.id).map(row => row.entryId))
          const ledger = readSoulLedgerProjection(dir)
          const items = [...ledger.items.filter(item => item.status === 'open' && allowed.has(item.id)).map(item => ({ id: item.id, entry: item.entry, status: item.status })),
            ...ledger.entries.filter(entry => entry.type === 'container' && allowed.has(entry.id)).reverse().map(entry => ({ id: entry.id, entry, status: 'container' }))]
          for (const item of items.slice(0, 3)) handoff.push(`- [${item.status}] ${item.id}；${item.entry.by}；${item.entry.t}：${item.entry['概要']}${item.entry.ref ? `；出处：${item.entry.ref}` : ''}`)
          if (items.length > 3) handoff.push(`- 未注入交接：${items.length - 3}；可用 soul_ledger list 按授权回取。`)
        }
        const text = renderSoulSelf(dir, agent, signal, budget, retrieval.status(agent, id), [
          `- 显式状态：${state.mark?.text ?? '尚未标记'}；标记时刻：${state.mark?.recordedAt ?? '无'}`,
          ...(typeof assistedState.notice === 'string' ? [`- 整理提示：${assistedState.notice}`] : []),
          ...(water.state === 'disabled' ? [] : [water.state === 'known'
            ? `- 上下文水位：${water.guidance}。此为提示，不自动压缩。`
            : `- 上下文水位：未知；${water.reason}`]),
          ...handoff,
        ], sourceText => {
          if (!sourceText.includes('{{')) return { text: sourceText, revision: '' }
          const snapshot = readModuleVariables(dir, { runtime: true })
          if (!snapshot.enabled) return { text: stripUnresolvedRefs(interpolateVariables(sourceText, {}, agent.session)).text, revision: snapshot.revisions.settings }
          const session = sessionOwner().read(dir, agent.session.id)
          const result = evaluateTemplate(sourceText, { module: snapshot.module, global: snapshot.global, sessionVariables: session.variables,
            session: agent.session, readOnly: true, sourceId: `${id}:self`, readRuntime: key => readValue(id, key, agent, signal) })
          return { text: result.text, revision: JSON.stringify([snapshot.revisions, session.revision]) }
        }, legacyAllowed(dir), owner?.status(dir).state === 'bound' ? owner.learning(dir, agent.session.id).map(row => ({ text: `- ${row.text}`, protected: row.layer === 'core' || row.layer === 'locked' })) : [])
        source(id, agent, signal)
        if (rendered.size > 1024) rendered.delete(rendered.keys().next().value!)
        const key = keyOf(id, agent), candidates = [...(rendered.get(key)?.candidates ?? []), digest(text)].slice(-16)
        rendered.set(key, { at: new Date().toISOString(), candidates, sessionId: agent.session.id })
        return text
      })
    },
  })
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const agents = ctx.get('agents') as { get(id: string): Agent | undefined } | undefined
    const agent = agents?.get(session.id)
    if (agent && ['user/message', 'assistant/message', 'tool/call', 'tool/result', 'command/run', 'command/done', 'turn/end'].includes(event.type)) for (const id of moduleIds(agent.id)) {
      void admit(id, agent, event.seq).then(async () => {
        if (event.type === 'turn/end' && ['completed', 'no-visible-output'].includes((event.data as { reason?: { kind?: string } }).reason?.kind ?? '') && readModuleFacts(source(id, agent)).effectiveConfigs?.['soul-maintenance']?.enabled === true) await assisted.request(id, agent)
      }).catch(error => ctx.logger?.warn?.(`Soul来源登记或整理失败：${String(error)}`))
    }
    const data = event.data as { message?: { source?: { kind?: string; form?: string; sections?: Array<{ text?: string }> } } }
    const observed = data.message?.source
    const changeSource = deliverySource(eventMessage(event)?.source)
    if (event.type === 'user/message' && changeSource
      && changeSource.sessionId === session.id && changeSource.soulDelivery?.version === 1
      && changeSource.soulDelivery.sessionId === session.id && typeof changeSource.moduleId === 'string'
      && typeof changeSource.actionId === 'string'
      && session.surface.nodes.includes(event.seq)
      && (() => {
        const message = session.deriveEventMessage(event), text = messageText(message)
        return deliverySource(message?.source)?.soulDelivery.digest === changeSource.soulDelivery.digest
          && text !== undefined && rendered.get(JSON.stringify([changeSource.moduleId, session.id]))?.candidates.includes(digest(text))
      })()) {
      delivered.set(JSON.stringify([changeSource.moduleId, session.id]), new Date(event.time).toISOString())
    }
    if (observed?.kind !== 'runtime-context' || observed.form !== 'snapshot') return
    for (const [key, candidate] of rendered) if (candidate.sessionId === session.id
      && observed.sections?.some(section => typeof section.text === 'string' && candidate.candidates.includes(digest(section.text)))) {
      if (delivered.size > 1024) delivered.delete(delivered.keys().next().value!)
      delivered.set(key, new Date(event.time).toISOString())
    }
  }))
  ctx.effect(() => {
    const agents = ctx.get('agents') as { list(): Agent[] } | undefined
    for (const agent of agents?.list() ?? []) for (const id of moduleIds(agent.id)) {
      void admit(id, agent).catch(error => ctx.logger?.warn?.(`Soul恢复对账失败：${String(error)}`))
    }
    return () => {}
  })
  ctx.effect(() => () => { active = false; assisted.dispose(); maintenance.dispose(); budgets.clear(); rendered.clear(); delivered.clear() })
  const observe = (exec: ToolExecution, id: string) => {
    if (!exec.agent) throw new Error('Soul状态缺少实际Agent')
    return status(id, exec.agent)
  }
  return { status: observe, check: async (exec, id, includeUpgrade) => {
    if (!exec.agent) throw new Error('Soul状态缺少实际Agent')
    const agent = exec.agent, dir = source(id, agent), key = keyOf(id, agent)
    if (includeUpgrade && !legacyAllowed(dir)) throw new Error('受控知识库已接入，模型不能展开完整升级正文；请使用用户升级入口')
    const diagnostics = readSoulDiagnostics(dir, { index: retrieval.status(agent, id),
      selfRenderedAt: rendered.get(key)?.at, selfDeliveredAt: delivered.get(key),
      maintenance: maintenance.status(id), recovery: recoveryObservationOf(agent) })
    const sessionId = agent.session.id
    const upgrade = includeUpgrade ? await readSoulUpgradePreview(dir) : { status: 'not-applicable' as const }
    if (includeUpgrade && !legacyAllowed(dir)) throw new Error('知识来源授权已变化，不能返回升级正文')
    if (source(id, agent, exec.signal) !== dir || agent.session.id !== sessionId) throw new Error('Soul诊断来源或会话已变化')
    return { ...diagnostics, checks: diagnostics.checks.map(check => ({ ...check })),
      upgrade: upgrade.status === 'not-applicable' ? { status: includeUpgrade ? upgrade.status : 'not-requested', expectedRevision: null, conflicts: [], candidate: null, files: [], apply: null } : { status: upgrade.status, expectedRevision: upgrade.expectedRevision, conflicts: upgrade.conflicts,
        candidate: upgrade.candidate, files: upgrade.files.map(file => ({ ...file })), apply: upgrade.apply } }
  } }
}

export function soulReminderOf(ctx: Context): RuleSoulReminder | undefined {
  return (ctx.get(SOUL_SELF_SERVICE) as { reminder?: RuleSoulReminder } | undefined)?.reminder
}

export function soulRuntimeValueOf(ctx: Context, id: string, key: string, agent: Agent, signal?: AbortSignal): string | undefined {
  return (ctx.get(SOUL_SELF_SERVICE) as { readValue?: (id: string, key: string, agent: Agent, signal?: AbortSignal) => string | undefined } | undefined)?.readValue?.(id, key, agent, signal)
}
