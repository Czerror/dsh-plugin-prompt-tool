/** 会话变量的唯一owner：官方Domain持久化，事务、迁移和元数据留在此处。 */
import { randomUUID } from 'node:crypto'
import { basename, dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { createTargetQueue } from '../shared/target-queue.ts'
import { assertModuleDirectory, assertModuleSnapshotSource } from './module-install.ts'
import { assertVariableValues } from './module-slices.ts'
import { canonicalDirectory, directoryKey, ModuleWriteError, revisionOf } from './module-write.ts'
import { withVariableDependencies } from './module-variables.ts'
import type { ModuleVariableRevisions } from './module-variables.ts'
import { readLegacySoulState } from './soul-state.ts'

export interface SessionVariableSnapshot { variables: Record<string, string>; updatedAt: Record<string, string>; revision: string | null }
export interface SessionVariableOwner {
  read(directory: string, sessionId: string): SessionVariableSnapshot
  edit(directory: string, sessionId: string, request: { changes: Record<string, string | null>; expectedRevision: string | null; expectedDependencies?: Partial<ModuleVariableRevisions> }, options?: { signal?: AbortSignal; assertAuthorized?: () => void }): Promise<SessionVariableSnapshot & { persisted: true }>
  dispose(): Promise<void>
}
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)), 'Invalid timestamp')
const schema = z.object({ directory: z.string(), sessionId: z.string(), variables: z.record(z.string(), z.string()), updatedAt: z.record(z.string(), timestamp), revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict().superRefine((value, ctx) => {
  try { validateValues(value.variables) } catch { ctx.addIssue({ code: 'custom', message: 'Invalid session variables' }) }
  if (!isDeepStrictEqual(Object.keys(value.variables).sort(), Object.keys(value.updatedAt).sort())) ctx.addIssue({ code: 'custom', message: 'Variable timestamps mismatch' })
})
const definition = defineDomain({ name: 'prompt_tool_session_variables', version: 1, tables: { sessions: domainTable(schema) } })
const conflict = () => new ModuleWriteError('会话变量版本冲突，请重新读取', 409, 'session-variables-conflict')
function validateValues(values: unknown): asserts values is Record<string, string> {
  assertVariableValues(values)
  const mark = values['soul.mark']
  if (mark !== undefined && (!mark.trim() || mark.length > 512 || Buffer.byteLength(mark) > 2048)) throw new ModuleWriteError('mark长度须为1–512字符且不超过2048字节')
}
function location(directory: string, sessionId: string) {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256) throw new ModuleWriteError('会话变量缺少实际会话身份')
  assertModuleSnapshotSource(dirname(directory), basename(directory))
  const dir = directoryKey(canonicalDirectory(directory))
  return { directory: dir, sessionId, key: revisionOf(dir + '\0' + sessionId) }
}
const copy = (state: SessionVariableSnapshot): SessionVariableSnapshot => ({ variables: { ...state.variables }, updatedAt: { ...state.updatedAt }, revision: state.revision })

export async function openSessionVariables(facility: DomainFacility): Promise<SessionVariableOwner> {
  const domain = await facility.open(definition), table = domain.table('sessions'), queue = createTargetQueue()
  const pending = new Set<Promise<unknown>>()
  let active = true
  let disposal: Promise<void> | undefined
  const assertActive = () => { if (!active) throw new Error('会话变量owner已释放') }
  const read = (directory: string, sessionId: string): SessionVariableSnapshot => {
    assertActive()
    const target = location(directory, sessionId), current = table.get(target.key)
    if (current) {
      if (current.directory !== target.directory || current.sessionId !== sessionId) throw new Error('会话变量身份不匹配')
      return copy(current)
    }
    const legacy = readLegacySoulState(directory, sessionId)
    return { variables: legacy.mark ? { 'soul.mark': legacy.mark.text } : {}, updatedAt: legacy.mark ? { 'soul.mark': legacy.mark.recordedAt } : {}, revision: legacy.revision }
  }
  return {
    read,
    edit(directory, sessionId, request, options = {}) {
      const operation = Promise.resolve().then(() => {
        assertActive()
        if (!request || typeof request.changes !== 'object' || request.changes === null || Array.isArray(request.changes) || Object.keys(request).some(key => !['changes', 'expectedRevision', 'expectedDependencies'].includes(key))) throw new ModuleWriteError('会话变量请求字段非法')
        if (request.expectedRevision !== null && (typeof request.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(request.expectedRevision))) throw new ModuleWriteError('会话变量需要当前expectedRevision，首次为null')
        const dependencies = request.expectedDependencies
        if (dependencies !== undefined && (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies) || Object.entries(dependencies).some(([key, value]) => !['module', 'global', 'settings'].includes(key) || !(key === 'global' && value === null) && !(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))))) throw new ModuleWriteError('会话变量读取依赖版本非法')
        assertVariableValues(Object.fromEntries(Object.entries(request.changes).map(([key, value]) => [key, value === null ? '' : value])))
        const target = location(directory, sessionId)
        // 所有会话写与持久变量共用全局锁，域内排队避免不同会话互相误报busy。
        return queue.run('variables', () => {
          assertActive(); options.signal?.throwIfAborted(); options.assertAuthorized?.()
          assertModuleDirectory(dirname(directory), basename(directory))
          return withVariableDependencies(directory, request.expectedDependencies ?? {}, async () => {
            assertActive(); options.signal?.throwIfAborted(); options.assertAuthorized?.()
            const before = read(directory, sessionId)
            if (before.revision !== request.expectedRevision) throw conflict()
            const variables = { ...before.variables }, updatedAt = { ...before.updatedAt }, now = new Date().toISOString()
            for (const [key, value] of Object.entries(request.changes)) {
              if (value === null) { delete variables[key]; delete updatedAt[key] }
              else if (variables[key] !== value) { variables[key] = value; updatedAt[key] = now }
            }
            validateValues(variables)
            if (table.get(target.key) && isDeepStrictEqual(variables, before.variables)) return { ...before, persisted: true as const }
            const next = { directory: target.directory, sessionId, variables, updatedAt, revision: revisionOf(randomUUID()) }
            schema.parse(next)
            options.signal?.throwIfAborted(); options.assertAuthorized?.()
            await table.put(target.key, next)
            return { ...copy(next), persisted: true as const }
          })
        })
      })
      pending.add(operation)
      void operation.then(() => pending.delete(operation), () => pending.delete(operation))
      return operation
    },
    dispose() {
      if (!disposal) { active = false; disposal = Promise.allSettled(pending).then(() => domain.close()) }
      return disposal
    },
  }
}
