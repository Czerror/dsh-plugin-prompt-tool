/** 显式会话短状态；真实会话选路径，正文与账本事件分开持久。 */
import { basename, dirname, join } from 'node:path'
import { assertModuleSnapshotSource, assertNoModuleLinks, modulePathExists } from './module-install.ts'
import { readModuleFile } from './module-files.ts'
import { record, revisionOf } from './module-write.ts'
import type { SessionVariableOwner } from './session-variables.ts'

export interface SoulMark { text: string; recordedAt: string }
export interface SoulState { mark: SoulMark | null; revision: string | null }

function statePath(moduleDir: string, sessionId: string): string {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256) throw new Error('Soul状态缺少实际会话身份')
  assertModuleSnapshotSource(dirname(moduleDir), basename(moduleDir))
  return `data/.soul/state-${revisionOf(sessionId)}.json`
}

export function readLegacySoulState(moduleDir: string, sessionId: string): SoulState {
  const path = statePath(moduleDir, sessionId)
  const target = join(moduleDir, path)
  assertNoModuleLinks(target)
  if (!modulePathExists(target)) return { mark: null, revision: null }
  const source = readModuleFile(moduleDir, path)
  if (source.bytes > 4096) throw new Error('Soul状态文件超过上限')
  let value: unknown
  try { value = JSON.parse(source.content) } catch { throw new Error('Soul状态文件损坏，不能重置') }
  if (!record(value) || value.version !== 1 || value.sessionId !== sessionId || !record(value.mark)
    || Object.keys(value).some(key => !['version', 'sessionId', 'mark'].includes(key))
    || Object.keys(value.mark).some(key => !['text', 'recordedAt'].includes(key))
    || typeof value.mark.text !== 'string' || !value.mark.text.trim() || value.mark.text.length > 512
    || Buffer.byteLength(value.mark.text) > 2048 || typeof value.mark.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.mark.recordedAt))) {
    throw new Error('Soul状态文件无效或会话身份不匹配')
  }
  return { mark: { text: value.mark.text, recordedAt: value.mark.recordedAt }, revision: revisionOf(source.content) }
}

export function readSoulState(moduleDir: string, sessionId: string, owner?: SessionVariableOwner): SoulState {
  if (!owner) return readLegacySoulState(moduleDir, sessionId)
  const state = owner.read(moduleDir, sessionId), text = state.variables['soul.mark']
  return { revision: state.revision, mark: text === undefined ? null : { text, recordedAt: state.updatedAt['soul.mark']! } }
}

export async function markSoulState(moduleDir: string, sessionId: string, input: { text: unknown; expectedRevision: unknown }, signal?: AbortSignal, owner?: SessionVariableOwner, assertAuthorized?: () => void): Promise<SoulState> {
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 512 || Buffer.byteLength(input.text) > 2048) throw new Error('mark长度须为1–512字符且不超过2048字节')
  if (input.expectedRevision !== null && (typeof input.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedRevision))) throw new Error('mark需要当前expectedRevision，首次为null')
  if (!owner) throw new Error('会话变量持久化依赖不可用，不能写入mark')
  const state = await owner.edit(moduleDir, sessionId, { changes: { 'soul.mark': input.text }, expectedRevision: input.expectedRevision }, { signal, assertAuthorized })
  return { revision: state.revision, mark: { text: state.variables['soul.mark']!, recordedAt: state.updatedAt['soul.mark']! } }
}
