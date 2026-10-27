/** 检索只读权威来源；引用携定位和版本，不携访问权限。 */
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync } from 'node:fs'
import { readModuleFile } from './module-files.ts'
import { resolveModuleFilePath } from './module-file-path.ts'
import { modulePathExists } from './module-install.ts'
import { MAX_ASSET_BYTES, MAX_ASSET_FILES } from '../shared/asset-transfer.ts'
import { makeSessionReference, sessionReferenceText, MAX_REFERENCE_CHARS } from '../../engine/retrieval-reference.mjs'
import type { RetrievalEvent, SessionReference } from '../../engine/retrieval-reference.mjs'

export interface RetrievalSession { id: string; snapshotEvents: () => readonly RetrievalEvent[] }
export type LoadRetrievalSession = (id: string) => Promise<RetrievalSession | undefined>
export interface RetrievalScope { moduleId: string; dir: string; paths: readonly string[]; sessions?: readonly string[]; session?: RetrievalSession }
export type FileReference = { kind: 'file'; moduleId: string; path: string; revision: string; start: number; end: number }
export type RetrievalReference = FileReference | SessionReference
export type RetrievalHit = { reference: RetrievalReference; content: string }
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const MAX_CHUNK = MAX_REFERENCE_CHARS

function fileContent(scope: RetrievalScope, path: string): string {
  if (!scope.paths.some(allowed => allowed === path || (allowed.endsWith('/') && path.startsWith(allowed)))) throw new Error('检索来源未授权')
  resolveModuleFilePath(scope.dir, path, ['assets', 'data'], { allowRootMemory: true })
  return readModuleFile(scope.dir, path).content
}

function filePaths(scope: RetrievalScope): string[] {
  const paths = new Set<string>()
  let total = 0
  const walk = (path: string): void => {
    const resolved = resolveModuleFilePath(scope.dir, path, ['assets', 'data'], { allowRootMemory: true })
    if (!modulePathExists(resolved)) return
    const stat = lstatSync(resolved)
    if (stat.isDirectory()) {
      for (const entry of readdirSync(resolved).sort()) walk(path + '/' + entry)
    } else {
      if (!stat.isFile()) throw new Error('检索来源不是普通文件')
      if (!paths.has(path)) total += stat.size
      paths.add(path)
      if (paths.size > MAX_ASSET_FILES || total > MAX_ASSET_BYTES) throw new Error('检索来源超过数量或总大小上限')
    }
  }
  for (const path of scope.paths) {
    const selected = path.endsWith('/') ? path.slice(0, -1) : path
    const resolved = resolveModuleFilePath(scope.dir, selected, ['assets', 'data'], { allowRootMemory: true })
    if (!modulePathExists(resolved)) continue
    if (lstatSync(resolved).isDirectory() && !path.endsWith('/')) throw new Error('检索目录白名单必须以 / 结尾')
    walk(selected)
  }
  return [...paths]
}

export function createModuleRetrieval(scopeOf: () => RetrievalScope, loadSession?: LoadRetrievalSession) {
  const indexes = new Map<string, { events: readonly RetrievalEvent[]; rows: { seq: number; content: string }[] }>()
  const assertSessionAuthorized = (scope: RetrievalScope, id: string): void => {
    const current = scopeOf()
    if (current.moduleId !== scope.moduleId || (current.session?.id !== id && !current.sessions?.includes(id))) throw new Error('检索会话未授权')
  }
  async function authorizedSession(scope: RetrievalScope, id: string): Promise<RetrievalSession> {
    assertSessionAuthorized(scope, id)
    if (scope.session?.id === id) return scope.session
    if (!scope.sessions?.includes(id)) throw new Error('检索会话未授权')
    let session: RetrievalSession | undefined
    try { session = await loadSession?.(id) } catch { throw new Error('授权会话不可读取') }
    assertSessionAuthorized(scope, id)
    if (!session || session.id !== id) throw new Error('授权会话不可读取')
    return session
  }
  async function indexSession(scope: RetrievalScope, id: string) {
    const session = await authorizedSession(scope, id), events = [...session.snapshotEvents()]
    assertSessionAuthorized(scope, id)
    const prior = indexes.get(id)
    // 官方事件快照不可变；纯追加只索引后缀，替换或恢复则重建派生索引。
    const appendOnly = prior !== undefined && events.length >= prior.events.length && prior.events.every((event, i) => events[i] === event)
    const rows = appendOnly ? [...prior.rows] : []
    for (const event of events.slice(appendOnly ? prior.events.length : 0)) {
      if (!Number.isSafeInteger(event.seq) || event.seq < 0) throw new Error('授权会话事件身份无效')
      rows.push({ seq: event.seq, content: JSON.stringify(event) })
    }
    if (new Set(rows.map(row => row.seq)).size !== rows.length) throw new Error('授权会话事件身份重复')
    if (rows.reduce((bytes, row) => bytes + Buffer.byteLength(row.content), 0) > MAX_ASSET_BYTES) throw new Error('授权会话检索超过64 MiB上限')
    indexes.set(id, { events, rows })
    return { events, rows }
  }
  const sessionIds = (scope: RetrievalScope) => new Set([...(scope.session ? [scope.session.id] : []), ...(scope.sessions ?? [])])
  const resultOf = (scope: RetrievalScope, hits: RetrievalHit[]) => {
    const current = scopeOf()
    if (current.moduleId !== scope.moduleId || current.dir !== scope.dir) throw new Error('检索模块未授权')
    // 最后一次await后统一复核全部命中，先前收集的正文不能跨异步撤权返回。
    for (const { reference } of hits) {
      if (reference.kind === 'session') assertSessionAuthorized(current, reference.sessionId)
      else if (digest(fileContent(current, reference.path)) !== reference.revision) throw new Error('检索引用已失效，请重新搜索')
    }
    return { hits }
  }
  return {
    async search(input: { query: string; limit?: number }) {
      if (typeof input.query !== 'string' || input.query.trim().length === 0 || input.query.length > 1024) throw new Error('检索 query 必须为1–1024字符')
      const limit = input.limit ?? 20
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('检索 limit 必须为1–50')
      const scope = scopeOf(), query = input.query.toLowerCase(), hits: RetrievalHit[] = []
      for (const path of filePaths(scope)) {
        const content = fileContent(scope, path), revision = digest(content)
        let offset = 0
        for (const line of content.split('\n')) {
          for (let part = 0; part < line.length; part += MAX_CHUNK) {
            const text = line.slice(part, part + MAX_CHUNK)
            if (!text.toLowerCase().includes(query)) continue
            hits.push({ reference: { kind: 'file', moduleId: scope.moduleId, path, revision, start: offset + part, end: offset + part + text.length }, content: text })
            if (hits.length === limit) return resultOf(scope, hits)
          }
          offset += line.length + 1
        }
      }
      for (const id of sessionIds(scope)) {
        const { events, rows } = await indexSession(scope, id)
        for (const row of rows) {
          const match = row.content.toLowerCase().indexOf(query)
          if (match < 0) continue
          const start = Math.max(0, match - 128), end = Math.min(row.content.length, start + MAX_CHUNK)
          const reference = makeSessionReference(scope.moduleId, id, events, [row.seq], { start, end })
          hits.push({ reference, content: row.content.slice(start, end) })
          if (hits.length === limit) return resultOf(scope, hits)
        }
      }
      return resultOf(scope, hits)
    },
    async open(reference: RetrievalReference) {
      const scope = scopeOf()
      if (!reference || reference.moduleId !== scope.moduleId) throw new Error('检索引用未授权或无效')
      if (Object.keys(reference).some(key => !['kind', 'moduleId', 'path', 'revision', 'start', 'end', 'sessionId', 'seqs'].includes(key))) throw new Error('检索引用含未知字段')
      if (reference.kind === 'session') {
        const session = await authorizedSession(scope, reference.sessionId), events = session.snapshotEvents()
        assertSessionAuthorized(scope, reference.sessionId)
        const content = sessionReferenceText(events, reference.seqs)
        if (digest(content) !== reference.revision) throw new Error('检索引用已失效，请重新搜索')
        const expected = makeSessionReference(scope.moduleId, session.id, events, reference.seqs, reference)
        if (expected.revision !== reference.revision) throw new Error('检索引用已失效，请重新搜索')
        const nextReference = reference.end < content.length ? makeSessionReference(scope.moduleId, session.id, events, reference.seqs, { start: reference.end }) : undefined
        return { reference, content: content.slice(reference.start, reference.end), totalChars: content.length, ...(nextReference ? { nextReference } : {}) }
      }
      if (reference.kind !== 'file') throw new Error('检索引用无效')
      const content = fileContent(scope, reference.path)
      if (digest(content) !== reference.revision) throw new Error('检索引用已失效，请重新搜索')
      if (!Number.isSafeInteger(reference.start) || !Number.isSafeInteger(reference.end) || reference.start < 0 || reference.end <= reference.start || reference.end > content.length || reference.end - reference.start > MAX_CHUNK) throw new Error('检索引用范围无效')
      return { reference, content: content.slice(reference.start, reference.end) }
    },
    async refresh() {
      const scope = scopeOf(), files = filePaths(scope)
      for (const path of files) fileContent(scope, path)
      let events = 0
      const ids = sessionIds(scope)
      for (const id of ids) events += (await indexSession(scope, id)).rows.length
      for (const id of indexes.keys()) if (!ids.has(id)) indexes.delete(id)
      return { state: 'ready' as const, files: files.length, sessions: ids.size, events }
    },
  }
}
