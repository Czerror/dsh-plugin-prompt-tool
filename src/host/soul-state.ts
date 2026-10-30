/** 显式会话短状态；真实会话选路径，正文与账本事件分开持久。 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { assertModuleDirectory, assertModuleSnapshotSource, assertNoModuleLinks, modulePathExists } from './module-install.ts'
import { ensureDataDirectory, resolveModuleFilePath } from './module-file-path.ts'
import { readModuleFile } from './module-files.ts'
import { record, revisionOf, withModuleLock } from './module-write.ts'

export interface SoulMark { text: string; recordedAt: string }
export interface SoulState { mark: SoulMark | null; revision: string | null }

function statePath(moduleDir: string, sessionId: string): string {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256) throw new Error('Soul状态缺少实际会话身份')
  assertModuleSnapshotSource(dirname(moduleDir), basename(moduleDir))
  return `data/.soul/state-${revisionOf(sessionId)}.json`
}

export function readSoulState(moduleDir: string, sessionId: string): SoulState {
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

export function markSoulState(moduleDir: string, sessionId: string, input: { text: unknown; expectedRevision: unknown }, signal?: AbortSignal): SoulState {
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 512 || Buffer.byteLength(input.text) > 2048) throw new Error('mark长度须为1–512字符且不超过2048字节')
  if (input.expectedRevision !== null && (typeof input.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedRevision))) throw new Error('mark需要当前expectedRevision，首次为null')
  const text = input.text, expected = input.expectedRevision
  assertModuleDirectory(dirname(moduleDir), basename(moduleDir))
  const path = statePath(moduleDir, sessionId)
  signal?.throwIfAborted()
  return withModuleLock(dirname(moduleDir), basename(moduleDir), () => {
    signal?.throwIfAborted()
    assertModuleDirectory(dirname(moduleDir), basename(moduleDir))
    const before = readSoulState(moduleDir, sessionId)
    if (before.revision !== expected) throw new Error('mark版本冲突，请重读当前状态')
    if (before.mark?.text === text) return before
    const data = ensureDataDirectory(moduleDir), stateDir = join(data, '.soul')
    assertNoModuleLinks(stateDir)
    mkdirSync(stateDir, { recursive: true })
    const target = resolveModuleFilePath(moduleDir, path, ['data'])
    const temporary = join(stateDir, '.mark-' + randomUUID() + '.tmp')
    const content = JSON.stringify({ version: 1, sessionId, mark: { text, recordedAt: new Date().toISOString() } }) + '\n'
    try {
      writeFileSync(temporary, content, { flag: 'wx', encoding: 'utf8' })
      signal?.throwIfAborted()
      if (readSoulState(moduleDir, sessionId).revision !== expected) throw new Error('mark版本冲突，请重读当前状态')
      renameSync(temporary, target)
    } finally { rmSync(temporary, { force: true }) }
    return readSoulState(moduleDir, sessionId)
  })
}
