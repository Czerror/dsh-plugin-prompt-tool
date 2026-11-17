import { randomUUID } from 'node:crypto'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { createTargetQueue } from '../shared/target-queue.ts'
import { revisionOf } from './module-write.ts'

export interface AssistedLimits { inputTarget: number; outputTokens: number; timeoutMs: number; sessionTokens: number; sessionMs: number; backlogTurns: number }
const attempt = z.object({ id: z.string(), message: z.string(), state: z.string(), tokens: z.number(), elapsedMs: z.number(), estimated: z.boolean(), reason: z.string().optional() }).strict()
const budget = z.object({ attempts: z.array(attempt), backlog: z.array(z.string()), notified: z.boolean(), stopped: z.boolean() }).strict()
const definition = defineDomain({ name: 'prompt_tool_soul_assisted', version: 1, tables: { budgets: domainTable(budget) } })
export type AssistedBudget = z.infer<typeof budget>

/** 根回合消费在调用前落盘；重启后未结算预留仍占用，不恢复次数。 */
export async function openAssistedBudget(facility: DomainFacility) {
  const domain = await facility.open(definition), table = domain.table('budgets'), queue = createTargetQueue()
  const empty = (): AssistedBudget => ({ attempts: [], backlog: [], notified: false, stopped: false })
  let active = true
  const pending = new Set<Promise<unknown>>()
  const read = (key: string): AssistedBudget => structuredClone(table.get(revisionOf(key)) ?? empty())
  const mutate = <T>(key: string, update: (value: AssistedBudget) => T): Promise<T> => {
    const work = queue.run(key, async () => {
      if (!active) throw new Error('辅助预算已释放')
      const value = read(key), result = update(value)
      await table.put(revisionOf(key), value)
      return result
    })
    pending.add(work)
    void work.then(() => pending.delete(work), () => pending.delete(work))
    return work
  }
  return {
    read,
    clearBacklog: (key: string) => mutate(key, value => { value.backlog = []; value.notified = false }),
    reserve: (key: string, message: string, inputTokens: number, limits: AssistedLimits) => mutate(key, value => {
      if (!message || !Number.isSafeInteger(inputTokens) || inputTokens < 1) throw new Error('辅助预算缺少真实回合或合法估算')
      const tokens = value.attempts.reduce((sum, row) => sum + row.tokens, 0), elapsedMs = value.attempts.reduce((sum, row) => sum + row.elapsedMs, 0)
      if (value.stopped || value.attempts.some(row => row.message === message)) return { state: 'deferred' as const, reason: value.stopped ? '实际用量超限，后续辅助已停止' : '本根用户回合已消费一次辅助额度' }
      if (tokens + inputTokens + limits.outputTokens > limits.sessionTokens || elapsedMs + limits.timeoutMs > limits.sessionMs) return { state: 'deferred' as const, reason: '根会话累计预留预算不足' }
      const row = { id: randomUUID(), message, state: 'reserved', tokens: inputTokens + limits.outputTokens, elapsedMs: limits.timeoutMs, estimated: true }
      value.attempts.push(row)
      return { state: 'reserved' as const, id: row.id }
    }),
    settle: (key: string, id: string, state: string, elapsedMs: number, tokens: number | undefined, limits: AssistedLimits, reason?: string, overrun = false) => mutate(key, value => {
      const row = value.attempts.find(row => row.id === id)
      if (!row || !Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error('辅助结算缺少预留或合法耗时')
      row.state = state; row.elapsedMs = Math.ceil(elapsedMs)
      if (reason) row.reason = reason
      if (tokens !== undefined && Number.isSafeInteger(tokens) && tokens >= 0) { row.tokens = tokens; row.estimated = false }
      if (overrun || value.attempts.reduce((sum, row) => sum + row.tokens, 0) > limits.sessionTokens || value.attempts.reduce((sum, row) => sum + row.elapsedMs, 0) > limits.sessionMs) {
        value.stopped = true
        row.reason = '实际辅助用量超过累计预算，已消费资源无法收回；后续辅助已停止'
      }
    }),
    backlog: (key: string, message: string, hasPending: boolean, limits: AssistedLimits) => mutate(key, value => {
      if (!hasPending) { value.backlog = []; value.notified = false; return false }
      if (message && !value.backlog.includes(message)) value.backlog.push(message)
      if (value.backlog.length < limits.backlogTurns || value.notified) return false
      value.notified = true
      return true
    }),
    async dispose() { active = false; await Promise.allSettled(pending); await domain.close() },
  }
}
