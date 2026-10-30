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
export interface RetrievalScope { moduleId: string; dir: string; paths: readonly string[]; sessions?: readonly string[]; session?: RetrievalSession; synonymsFile?: string }
export type FileReference = { kind: 'file'; moduleId: string; path: string; revision: string; start: number; end: number }
export type RetrievalReference = FileReference | SessionReference
export type RetrievalHit = { reference: RetrievalReference; content: string; match?: 'exact' | 'normalized' | 'synonym'; time?: string | null; timeState?: 'known' | 'unknown' }
export interface RetrievalQuery { query?: string; mode?: 'search' | 'timeline'; since?: string; until?: string; limit?: number; cursor?: string }
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const MAX_CHUNK = MAX_REFERENCE_CHARS
const normalize = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/(?<![0-9,])[0-9]{1,3}(?:,[0-9]{3})+(?![0-9,])/g, value => value.replaceAll(',', ''))
function includesQuery(text: string, query: string): boolean {
  let start = text.indexOf(query)
  while (start >= 0) {
    if (!/^[0-9]+$/.test(query) || (!/[0-9]/.test(text[start - 1] ?? '') && !/[0-9]/.test(text[start + query.length] ?? ''))) return true
    start = text.indexOf(query, start + 1)
  }
  return false
}
function matchKind(text: string, query: string): 'exact' | 'normalized' | undefined {
  if (includesQuery(text.toLowerCase(), query.toLowerCase())) return 'exact'
  if (includesQuery(normalize(text), normalize(query))) return 'normalized'
}
function synonymTerms(scope: RetrievalScope, query: string): { terms: string[]; content?: string } {
  if (!scope.synonymsFile) return { terms: [] }
  resolveModuleFilePath(scope.dir, scope.synonymsFile, ['assets', 'data'])
  const content = readModuleFile(scope.dir, scope.synonymsFile).content
  if (Buffer.byteLength(content) > 65536) throw new Error('检索近义表超过64 KiB')
  let groups: unknown
  try { groups = JSON.parse(content) } catch { throw new Error('检索近义表必须为JSON词组数组') }
  if (!Array.isArray(groups) || groups.length > 128 || groups.some(group => !Array.isArray(group) || group.length < 2 || group.length > 16 || group.some(term => typeof term !== 'string' || !term.trim() || term.length > 128))) throw new Error('检索近义表词组无效或超限')
  const needle = normalize(query), terms = new Set<string>()
  for (const group of groups as string[][]) if (group.some(term => normalize(term) === needle)) for (const term of group) if (normalize(term) !== needle) terms.add(term)
  if (terms.size > 32) throw new Error('检索近义扩展超过32项')
  return { terms: [...terms], content }
}
function timeOf(value: unknown): number | undefined {
  const time = typeof value === 'number' ? value : typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN
  return Number.isSafeInteger(time) && time >= 0 && time <= 8640000000000000 ? time : undefined
}

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
    if (current.moduleId !== scope.moduleId || current.dir !== scope.dir || (current.session?.id !== id && !current.sessions?.includes(id))) throw new Error('检索会话未授权')
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
    return { events, rows, session }
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
    const selected: RetrievalHit[] = []
    let bytes = 0
    for (const hit of hits) {
      bytes += Buffer.byteLength(JSON.stringify(hit))
      if (bytes > 65536) break
      selected.push(hit)
    }
    return { hits: selected }
  }
  const timeline = async (input: RetrievalQuery, limit: number) => {
    const scope = scopeOf(), hits: RetrievalHit[] = [], versions: unknown[] = [], revalidate: Array<() => void> = []
    const since = input.since === undefined ? undefined : timeOf(input.since), until = input.until === undefined ? undefined : timeOf(input.until)
    if ((input.since !== undefined && since === undefined) || (input.until !== undefined && until === undefined) || (since !== undefined && until !== undefined && since > until)) throw new Error('时间线需要明确有效的since/until时间')
    let bytes = 0
    const add = (reference: RetrievalReference, content: string, value: unknown): void => {
      bytes += Buffer.byteLength(content)
      if (bytes > MAX_ASSET_BYTES) throw new Error('时间线来源超过64 MiB')
      const time = timeOf(value)
      if ((since !== undefined || until !== undefined) && (time === undefined || (since !== undefined && time < since) || (until !== undefined && time > until))) return
      if (input.query !== undefined && !matchKind(content, input.query)) return
      hits.push({ reference, content, time: time === undefined ? null : new Date(time).toISOString(), timeState: time === undefined ? 'unknown' : 'known' })
    }
    for (const path of filePaths(scope)) {
      if (!['02-soul.jsonl', '02-墨.jsonl'].includes(path.split('/').at(-1)!)) continue
      const content = fileContent(scope, path), revision = digest(content)
      versions.push(['file', path, revision])
      revalidate.push(() => { if (digest(fileContent(scopeOf(), path)) !== revision) throw new Error('时间线来源已变化，请重新查询') })
      let offset = 0
      for (const line of content.split('\n')) {
        if (line.trim()) {
          let row: { t?: unknown }
          try { row = JSON.parse(line) } catch { throw new Error('时间线账本含无效记录') }
          if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('时间线账本含无效记录')
          for (let part = 0; part < line.length; part += MAX_CHUNK) add({ kind: 'file', moduleId: scope.moduleId, path, revision, start: offset + part, end: offset + Math.min(line.length, part + MAX_CHUNK) }, line.slice(part, part + MAX_CHUNK), row.t)
        }
        offset += line.length + 1
      }
    }
    for (const id of sessionIds(scope)) {
      const { events, rows, session } = await indexSession(scope, id)
      const revision = digest(JSON.stringify(events))
      versions.push(['session', id, revision])
      revalidate.push(() => {
        assertSessionAuthorized(scope, id)
        if (digest(JSON.stringify(session.snapshotEvents())) !== revision) throw new Error('时间线来源已变化，请重新查询')
      })
      const times = new Map(events.map(event => [event.seq, event.time]))
      for (const row of rows) {
        for (let start = 0; start < row.content.length; start += MAX_CHUNK) {
          const end = Math.min(row.content.length, start + MAX_CHUNK)
          add(makeSessionReference(scope.moduleId, id, events, [row.seq], { start, end }), row.content.slice(start, end), times.get(row.seq))
        }
      }
    }
    resultOf(scope, hits)
    const current = scopeOf()
    if (JSON.stringify([current.moduleId, current.dir, current.paths, [...sessionIds(current)]]) !== JSON.stringify([scope.moduleId, scope.dir, scope.paths, [...sessionIds(scope)]])) throw new Error('时间线来源声明已变化')
    for (const check of revalidate) check()
    const sourceKey = (hit: RetrievalHit): string => hit.reference.kind === 'file' ? '0:' + hit.reference.path + ':' + String(hit.reference.start).padStart(12, '0') : '1:' + hit.reference.sessionId + ':' + String(hit.reference.seqs[0]).padStart(16, '0') + ':' + hit.reference.start
    hits.sort((a, b) => (a.time === b.time ? 0 : a.time === null ? 1 : b.time === null ? -1 : a.time!.localeCompare(b.time!)) || sourceKey(a).localeCompare(sourceKey(b)))
    const version = digest(JSON.stringify([scope.moduleId, scope.dir, scope.paths, [...sessionIds(scope)], versions, input.query ?? null, since ?? null, until ?? null, limit]))
    let offset = 0
    if (input.cursor !== undefined) {
      let cursor: { version: string; offset: number }
      try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) } catch { throw new Error('时间线游标无效') }
      if (!cursor || Object.keys(cursor).sort().join(',') !== 'offset,version' || cursor.version !== version || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset >= hits.length) throw new Error('时间线游标已失效，请重新查询')
      offset = cursor.offset
    }
    const selected: RetrievalHit[] = []
    let outputBytes = 0
    for (const hit of hits.slice(offset, offset + limit)) {
      outputBytes += Buffer.byteLength(JSON.stringify(hit))
      if (outputBytes > 65536) break
      selected.push(hit)
    }
    const next = offset + selected.length
    return { hits: selected, ...(next < hits.length ? { nextCursor: Buffer.from(JSON.stringify({ version, offset: next })).toString('base64url') } : {}) }
  }
  return {
    async search(input: RetrievalQuery) {
      if (input.mode !== undefined && input.mode !== 'search' && input.mode !== 'timeline') throw new Error('检索模式无效')
      if ((input.query !== undefined || input.mode !== 'timeline') && (typeof input.query !== 'string' || input.query.trim().length === 0 || input.query.length > 1024)) throw new Error('检索 query 必须为1–1024字符')
      const limit = input.limit ?? 20
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('检索 limit 必须为1–50')
      if (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 2048)) throw new Error('时间线游标无效')
      if (input.mode === 'timeline') return timeline(input, limit)
      if (input.since !== undefined || input.until !== undefined || input.cursor !== undefined) throw new Error('时间过滤和游标只用于时间线')
      const scope = scopeOf(), query = input.query!, candidates: RetrievalHit[] = []
      const synonyms = synonymTerms(scope, query)
      let candidateBytes = 0
      const add = (hit: RetrievalHit): void => {
        const match = matchKind(hit.content, query)
        if (!match && !scope.synonymsFile) return
        candidateBytes += Buffer.byteLength(hit.content)
        if (candidateBytes > MAX_ASSET_BYTES) throw new Error('检索候选超过64 MiB')
        candidates.push({ ...hit, ...(match ? { match } : {}) })
      }
      for (const path of filePaths(scope)) {
        const content = fileContent(scope, path), revision = digest(content)
        let offset = 0
        for (const line of content.split('\n')) {
          for (let part = 0; part < line.length; part += MAX_CHUNK) {
            const text = line.slice(part, part + MAX_CHUNK)
            add({ reference: { kind: 'file', moduleId: scope.moduleId, path, revision, start: offset + part, end: offset + part + text.length }, content: text })
            if (!scope.synonymsFile && candidates.length === limit) return resultOf(scope, candidates)
          }
          offset += line.length + 1
        }
      }
      for (const id of sessionIds(scope)) {
        const { events, rows } = await indexSession(scope, id)
        for (const row of rows) {
          for (let start = 0; start < row.content.length; start += MAX_CHUNK) {
            const end = Math.min(row.content.length, start + MAX_CHUNK), text = row.content.slice(start, end)
            const reference = makeSessionReference(scope.moduleId, id, events, [row.seq], { start, end })
            add({ reference, content: text })
            if (!scope.synonymsFile && candidates.length === limit) return resultOf(scope, candidates)
          }
        }
      }
      const hits: RetrievalHit[] = []
      for (const candidate of candidates) {
        const match = matchKind(candidate.content, query)
        if (match) hits.push({ ...candidate, match })
      }
      hits.sort((a, b) => Number(a.match === 'normalized') - Number(b.match === 'normalized'))
      if (hits.length < 3 && synonyms.terms.length) for (const candidate of candidates) {
        if (!matchKind(candidate.content, query) && synonyms.terms.some(term => matchKind(candidate.content, term))) hits.push({ ...candidate, match: 'synonym' })
      }
      const current = scopeOf()
      if (current.synonymsFile !== scope.synonymsFile || (scope.synonymsFile && readModuleFile(current.dir, scope.synonymsFile).content !== synonyms.content)) throw new Error('检索近义表已变化，请重新搜索')
      const selected: RetrievalHit[] = []
      let bytes = 0
      for (const hit of hits.slice(0, limit)) {
        const size = Buffer.byteLength(JSON.stringify(hit))
        if (bytes + size > 65536) break
        bytes += size; selected.push(hit)
      }
      return resultOf(scope, selected)
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
