/** Soul宿主接线：历史只读句柄、检索授权与SELF/维护共享owner。 */
import { statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SoulStateObservation } from './soul-state-tools.ts'
import type { ModuleToolHost } from '../host/module-tool-target.ts'
import { assertModuleSnapshotSource } from '../host/module-install.ts'
import { readModuleFacts } from '../host/module-params.ts'
import { renderSoulSelf, validateSelfBudget } from '../host/soul-self.ts'
import { readSoulState } from '../host/soul-state.ts'
import { readSoulLedgerProjection } from '../host/soul-ledger.ts'
import { readSoulDiagnostics } from '../host/soul-diagnostics.ts'
import { readSoulUpgradePreview } from '../host/soul-upgrade.ts'
import { readSoulPressure } from './soul-pressure.ts'
import type { SoulPressure } from './soul-pressure.ts'
import { createSoulReminder } from './soul-reminder.ts'
import { contextRuntimeOf } from '../../engine/context-provenance.mjs'
import { recoveryObservationOf } from '../../engine/generation-recovery.mjs'
import type { RuleSoulReminder } from '../../engine/rule-runtime.mjs'
import { createModuleRetrievalProvider } from './module-retrieval-tools.ts'
import type { RetrievalEvent } from '../../engine/retrieval-reference.mjs'
import { createSoulMaintenanceProvider } from './soul-maintenance.ts'
import { SOUL_MAINTENANCE_SERVICE, SOUL_SELF_SERVICE, toolServiceName } from '../../engine/service-names.mjs'

export function installSoulRuntime(ctx: Context, host: ModuleToolHost, moduleIds: (id: string) => readonly string[]): SoulStateObservation {
  let active = true
  const rendered = new Map<string, { at: string; candidates: string[]; sessionId: string }>()
  const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
  const delivered = new Map<string, string>()
  const source = (id: string, agent: Agent, signal?: AbortSignal): string => {
    signal?.throwIfAborted()
    if (!active || !agent?.session?.id || !moduleIds(agent.id).includes(id)) throw new Error('SELF来源模块未参与本Agent装配')
    return assertModuleSnapshotSource(host.root, id)
  }
  const keyOf = (id: string, agent: Agent): string => JSON.stringify([id, agent.session.id])
  const activityOf = (agent: Agent): string | null => {
    const events = agent.session.snapshotEvents()
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!
      if (['user/message', 'assistant/message', 'tool/call', 'tool/result', 'step/start', 'turn/end'].includes(event.type)
        && Number.isFinite(event.time)) return new Date(event.time).toISOString()
    }
    return null
  }
  // 定义暂时损坏时保留最近有效预算，不降低可用快照的注入上限。
  const budgets = new Map<string, { stamp: string; checkedAt: number; value: number }>()
  const readSelfBudget = (dir: string): number => {
    const stat = statSync(join(dir, 'module.yml'), { throwIfNoEntry: false })
    const stamp = stat ? `${stat.mtimeMs}:${stat.size}` : 'missing'
    const hit = budgets.get(dir)
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
  const retrieval = createModuleRetrievalProvider(host, async id => {
    const sessions = ctx.get('sessions') as { get(id: string): { id: string; snapshotEvents(): readonly RetrievalEvent[] } | undefined } | undefined
    const live = sessions?.get(id)
    if (live) return live
    const persistence = ctx.get('sessionPersistence') as {
      open(id: string, access: 'read'): Promise<{ read(offset: number, length: number): Promise<{ events: readonly RetrievalEvent[] }>; close(): Promise<void> }>
    } | undefined
    if (!persistence) throw new Error('历史会话持久服务不可用')
    const handle = await persistence.open(id, 'read')
    try {
      const { events } = await handle.read(0, 100001)
      if (events.length > 100000 || Buffer.byteLength(JSON.stringify(events)) > 32 * 1024 * 1024) throw new Error('授权会话超出检索预算')
      return { id, snapshotEvents: () => events }
    } finally { await handle.close() }
  })
  const maintenance = createSoulMaintenanceProvider({ refreshRetrieval: (agent, id, signal) => retrieval.refresh(agent, id, signal) })
  const reminder = createSoulReminder((id, agent) => readSoulLedgerProjection(source(id, agent as Agent)))
  const pressure = (dir: string, agent: Agent): SoulPressure | { state: 'disabled' } | { state: 'unknown'; reason: string } => {
    try {
      const thresholds = readModuleFacts(dir).effectiveConfigs?.['soul-maintenance']?.pressureThresholds
      return Array.isArray(thresholds) ? readSoulPressure(ctx, agent, thresholds) : { state: 'disabled' as const }
    } catch { return { state: 'unknown' as const, reason: '水位配置或会话观测不可用' } }
  }
  ctx.provide(toolServiceName('retrieval'), retrieval)
  ctx.provide(SOUL_MAINTENANCE_SERVICE, maintenance)
  const status = (id: string, agent: Agent) => {
    const dir = source(id, agent), ledger = readSoulLedgerProjection(dir), state = readSoulState(dir, agent.session.id)
    return { clock: new Date().toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      sessionId: agent.session.id, revision: state.revision, mark: state.mark ? { ...state.mark } : null, activityAt: activityOf(agent),
      ledger: { total: ledger.total, open: ledger.open, pendingReview: ledger.pendingReview, initialized: ledger.initialized, pendingVersion: ledger.pendingVersion },
      index: { ...retrieval.status(agent, id) }, pressure: pressure(dir, agent),
      renderedAt: rendered.get(keyOf(id, agent))?.at ?? null, deliveredAt: delivered.get(keyOf(id, agent)) ?? null }
  }
  ctx.provide(SOUL_SELF_SERVICE, {
    status,
    reminder,
    committed: (id: string, agent: Agent) => {
      source(id, agent)
      retrieval.invalidateModule(id)
      void maintenance.tick(id)
      return { state: maintenance.status(id).state === 'disabled' ? 'stale-maintenance-disabled' : 'refresh-pending' }
    },
    render: (id: string, agent: Agent, signal?: AbortSignal): Promise<string> => {
      const dir = source(id, agent, signal), budget = readSelfBudget(dir)
      return Promise.resolve().then(() => {
        if (source(id, agent, signal) !== dir) throw new Error('SELF来源发生变化')
        const state = readSoulState(dir, agent.session.id)
        const water = pressure(dir, agent)
        const text = renderSoulSelf(dir, agent, signal, budget, retrieval.status(agent, id), [
          `- 显式状态：${state.mark?.text ?? '尚未标记'}；标记时刻：${state.mark?.recordedAt ?? '无'}`,
          `- 实际活动时刻：${activityOf(agent) ?? '未观测'}`,
          `- SELF实际投递观测：${delivered.get(keyOf(id, agent)) ?? '尚未观测'}`,
          ...(water.state === 'disabled' ? [] : [water.state === 'known'
            ? `- 上下文水位：${(water.ratio * 100).toFixed(1)}%（${water.tokens}/${water.capacity}；${water.source}）；${water.guidance}。此为提示，不自动压缩。`
            : `- 上下文水位：未知；${water.reason}`]),
        ])
        source(id, agent, signal)
        if (rendered.size > 1024) rendered.delete(rendered.keys().next().value!)
        const key = keyOf(id, agent), candidates = [...(rendered.get(key)?.candidates ?? []), digest(text)].slice(-16)
        rendered.set(key, { at: new Date().toISOString(), candidates, sessionId: agent.session.id })
        return text
      })
    },
  })
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const data = event.data as { message?: { source?: { kind?: string; form?: string; sections?: Array<{ text?: string }> } } }
    const observed = data.message?.source
    if (observed?.kind !== 'runtime-context' || observed.form !== 'snapshot') return
    for (const [key, candidate] of rendered) if (candidate.sessionId === session.id
      && observed.sections?.some(section => typeof section.text === 'string' && candidate.candidates.includes(digest(section.text)))) {
      if (delivered.size > 1024) delivered.delete(delivered.keys().next().value!)
      delivered.set(key, new Date(event.time).toISOString())
    }
  }))
  ctx.effect(() => () => { active = false; maintenance.dispose(); budgets.clear(); rendered.clear(); delivered.clear() })
  const observe = (exec: ToolExecution, id: string) => {
    if (!exec.agent) throw new Error('Soul状态缺少实际Agent')
    return status(id, exec.agent)
  }
  return { status: observe, check: async (exec, id, includeUpgrade) => {
    if (!exec.agent) throw new Error('Soul状态缺少实际Agent')
    const agent = exec.agent, dir = source(id, agent), key = keyOf(id, agent)
    const diagnostics = readSoulDiagnostics(dir, { index: retrieval.status(agent, id),
      selfRenderedAt: rendered.get(key)?.at, selfDeliveredAt: delivered.get(key),
      maintenance: maintenance.status(id), context: contextRuntimeOf(agent)?.status(), recovery: recoveryObservationOf(agent) })
    const sessionId = agent.session.id
    const upgrade = includeUpgrade ? await readSoulUpgradePreview(dir) : { status: 'not-applicable' as const }
    if (source(id, agent, exec.signal) !== dir || agent.session.id !== sessionId) throw new Error('Soul诊断来源或会话已变化')
    return { ...diagnostics, checks: diagnostics.checks.map(check => ({ ...check })),
      upgrade: upgrade.status === 'not-applicable' ? { status: includeUpgrade ? upgrade.status : 'not-requested', expectedRevision: null, conflicts: [], candidate: null, files: [], apply: null } : { status: upgrade.status, expectedRevision: upgrade.expectedRevision, conflicts: upgrade.conflicts,
        candidate: upgrade.candidate, files: upgrade.files.map(file => ({ ...file })), apply: upgrade.apply } }
  } }
}

export function soulReminderOf(ctx: Context): RuleSoulReminder | undefined {
  return (ctx.get(SOUL_SELF_SERVICE) as { reminder?: RuleSoulReminder } | undefined)?.reminder
}
