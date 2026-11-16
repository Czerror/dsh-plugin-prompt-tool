/** 本机知识库授权：只由用户命令确认，模块导出不包含官方持久域。 */
import { lstatSync, mkdirSync, readdirSync, realpathSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { createTargetQueue } from '../shared/target-queue.ts'
import { canonicalDirectory, directoryKey, revisionOf } from './module-write.ts'
import { assertModuleSnapshotSource } from './module-install.ts'
import type { LoadRetrievalSession } from './module-retrieval.ts'
import { readSoulLedgerProjection } from './soul-ledger.ts'
import { openAssistedBudget } from './soul-assisted-budget.ts'

const source = z.object({ id: z.string(), path: z.string(), scope: z.string(), version: z.string(), revoked: z.boolean() }).strict()
const project = z.object({ sessionId: z.string(), path: z.string(), identity: z.string() }).strict()
const history = z.object({ id: z.string(), sessionId: z.string(), seqs: z.array(z.number()), versions: z.array(z.string()), scope: z.string(), revoked: z.boolean(), automatic: z.boolean().optional() }).strict()
const participation = z.object({ sessionId: z.string(), boundary: z.number(), cursor: z.number(), scope: z.string(), generation: z.string(), parent: z.string().optional(), grants: z.array(z.string()), rootSessionId: z.string(), rootMessageId: z.string().optional() }).strict()
const recorded = z.object({ operation: z.string(), entryId: z.string(), sourceId: z.string(), sessionId: z.string(), seq: z.number(), time: z.number(), version: z.string(), scope: z.string(), rootSessionId: z.string(), rootMessageId: z.string().optional(), pending: z.boolean() }).strict()
const publication = z.object({ id: z.string(), path: z.string(), scope: z.string(), version: z.string(), roots: z.array(z.string()), rootVersions: z.array(z.string()), refs: z.array(z.string()) }).strict()
const assessment = z.object({ decision: z.enum(['adopt', 'candidate']), reason: z.string().trim().min(1).max(2048), unresolved: z.boolean(), counterRefs: z.array(z.string()).max(200) }).strict()
const learning = z.object({ id: z.string(), text: z.string(), layer: z.enum(['expression', 'judgment', 'experience', 'core', 'locked']), sourceId: z.string(), sourceVersion: z.string(), scope: z.string(), state: z.enum(['candidate', 'adopted', 'forgotten', 'withdrawn']), evidence: z.array(z.object({ id: z.string(), version: z.string() }).strict()).optional(), roots: z.array(z.string()).optional(), refs: z.array(z.string()).optional(), assessment: assessment.optional(), previous: z.string().optional(), confirmation: z.object({ sessionId: z.string(), revision: z.string() }).strict().optional(), inactiveReason: z.string().optional() }).strict()
const binding = z.object({ directory: z.string(), moduleIdentity: z.string(), root: z.string(), identity: z.string(), read: z.array(z.string()), write: z.array(z.string()), revision: z.string(), generation: z.string().optional(), sources: z.array(source).optional(), projects: z.array(project).optional(), histories: z.array(history).optional(), continuity: z.object({ enabled: z.boolean(), enabledAt: z.number(), generation: z.string() }).strict().optional(), participants: z.array(participation).optional(), records: z.array(recorded).optional(), publications: z.array(publication).optional(), learning: z.array(learning).optional() }).strict()
const definition = defineDomain({ name: 'prompt_tool_soul_knowledge', version: 1, tables: { bindings: domainTable(binding) } })
type Binding = z.infer<typeof binding>
export interface SoulKnowledgeRequest { moduleId: string; action: 'status' | 'preview' | 'confirm' | 'sources' | 'source-preview' | 'source-confirm' | 'revoke' | 'project' | 'enable' | 'disable' | 'learning-list' | 'learning-confirm' | 'learning-forget' | 'learning-withdraw'; root?: string; read?: string[]; write?: string[]; expectedRevision?: string; path?: string; scope?: 'general' | 'project'; projectDirectory?: string; sourceId?: string; sessionId?: string; seqs?: number[] }
export interface KnowledgeDocument { kind: 'knowledge'; moduleId: string; root: string; path: string; scope: string; sourceId: string; revision: string; content: string }
export interface SoulKnowledgeOwner {
  assisted: Awaited<ReturnType<typeof openAssistedBudget>>
  onChange(listener: () => void): () => void
  status(directory: string): { state: 'unbound' | 'bound' | 'unavailable'; binding?: Binding; consolidationRevision?: string; learningRevision?: string; reason?: string; entry: string }
  preview(directory: string, request: SoulKnowledgeRequest): Record<string, unknown>
  confirm(directory: string, request: SoulKnowledgeRequest, signal: AbortSignal): Promise<ReturnType<SoulKnowledgeOwner['status']>>
  sources(directory: string, sessionId: string): { state: string; documents: KnowledgeDocument[]; histories: z.infer<typeof history>[] }
  refreshEvidence(directory: string): Promise<void>
  learn(directory: string, sessionId: string, request: { text: string; layer: string; ref: string; refs?: string[]; assessment?: z.infer<typeof assessment>; expectedRevision: string; basis?: string; previous?: string }, signal: AbortSignal, assertAuthorized?: () => void): Promise<Record<string, unknown>>
  learning(directory: string, sessionId: string, includeInactive?: boolean): z.infer<typeof learning>[]
  manage(directory: string, request: SoulKnowledgeRequest, sessionId: string, signal: AbortSignal): Promise<Record<string, unknown>>
  assertFile(directory: string, absolute: string, sessionId?: string, write?: boolean): void
  observe(directory: string, sessionId: string, eventSeq?: number, parentSessionId?: string, assertAuthorized?: () => void, attached?: boolean, cwd?: string): Promise<void>
  record(directory: string, sessionId: string, operation: string, commit: (source: ContinuitySource) => { entry: Record<string, unknown> }, signal: AbortSignal): Promise<Record<string, unknown>>
  records(directory: string, sessionId: string): z.infer<typeof recorded>[]
  recording(directory: string, sessionId: string): { persisted: number; pending: number; derivedFailed: number }
  consolidate(directory: string, sessionId: string, request: { expectedRevision: string; text: string; refs: string[] }, signal: AbortSignal, assertAuthorized?: () => void): Promise<Record<string, unknown>>
  dispose(): Promise<void>
}
export interface ContinuitySource { sourceId: string; sessionId: string; seq: number; time: number; version: string; scope: string; operation: string; rootSessionId: string; rootMessageId?: string }
const protectedPath = (path: string) => path.split('/').some(part => /^(?:\.soul|\.runtime|02-(?:soul|墨)\.jsonl|SELF(?:\..*)?|AGENTS\.md|CLAUDE\.md|ledger(?:\..*)?|state(?:-.*)?\.json)$/i.test(part))
function safePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes(':') || path.includes('\0') || isAbsolute(path) || path.split('/').some(p => !p || p === '.' || p === '..') || protectedPath(path)) throw new Error('知识库资料范围非法或属于保护区域')
}
/** 对每级组件拒绝链接；身份包含文件系统对象，不能仅比较路径字符串。 */
function identity(path: string): string {
  const absolute = resolve(path), anchor = parse(absolute).root
  let current = anchor
  for (const part of relative(anchor, absolute).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part)
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error('知识库路径含链接，授权不可用')
  }
  const stat = lstatSync(absolute)
  if (!stat.isDirectory()) throw new Error('知识库根不是目录')
  return revisionOf(JSON.stringify([realpathSync(absolute), stat.dev, stat.ino, stat.birthtimeMs]))
}
function projectIdentity(path: string): { path: string; identity: string } {
  if (!isAbsolute(path)) throw new Error('项目目录必须由用户明确指定绝对路径')
  const canonical = realpathSync(path)
  identity(canonical)
  let ancestor = canonical, gitDirectory = false
  for (;;) {
    try { lstatSync(join(ancestor, '.git')); gitDirectory = true; break }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  if (!gitDirectory) return { path: canonical, identity: 'directory:' + identity(canonical) }
  let common: string
  try { common = execFileSync('git', ['-C', canonical, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  catch { throw new Error('项目Git身份无法确认') }
  return { path: canonical, identity: 'git:' + identity(realpathSync(common)) }
}
function rootSnapshot(root: string) {
  let rootIdentity: string
  try { rootIdentity = identity(root) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { identity: null, parent: identity(dirname(root)), entries: [] }
  }
  const entries: { path: string; size: number; kind: string; version: string }[] = []
  function visit(directory: string, prefix: string, depth: number): void {
    for (const name of readdirSync(directory).sort()) {
      if (entries.length >= 2000) throw new Error('知识库预览超过2000项，请选择更小的根')
      const path = prefix + name, stat = lstatSync(join(directory, name))
      entries.push({ path, size: stat.size, kind: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'special', version: revisionOf(JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])) })
      if (stat.isDirectory() && !protectedPath(path)) {
        if (depth >= 8) throw new Error('知识库层级过深，请选择更小的根')
        visit(join(directory, name), path + '/', depth + 1)
      }
    }
  }
  visit(root, '', 0)
  return { identity: rootIdentity, parent: identity(dirname(root)), entries }
}
export async function openSoulKnowledge(facility: DomainFacility, loadSession?: LoadRetrievalSession): Promise<SoulKnowledgeOwner> {
  const assisted = await openAssistedBudget(facility)
  const changeListeners = new Set<() => void>()
  const domain = await facility.open(definition).catch(async error => {
    await assisted.dispose().catch(() => {})
    throw error
  })
  const table = domain.table('bindings'), queue = createTargetQueue()
  const saveBinding = async (id: string, value: Binding) => {
    await table.put(id, value)
    for (const listener of changeListeners) { try { listener() } catch { /* 通知失败不撤销已持久化事实。 */ } }
  }
  const evidenceSessions = new Map<string, Awaited<ReturnType<LoadRetrievalSession>>>()
  const loadEvidence = async (id: string) => {
    const session = await loadSession?.(id)
    evidenceSessions.set(id, session)
    return session
  }
  let active = true
  const pending = new Set<Promise<unknown>>()
  const previews = new Map<string, string>()
  const key = (directory: string) => directoryKey(canonicalDirectory(directory))
  const assertActive = () => { if (!active) throw new Error('知识库持久状态已释放') }
  const consolidationRevision = (value: Binding) => revisionOf(JSON.stringify({ ...value, revision: undefined,
    participants: value.participants?.map(({ cursor: _cursor, grants: _grants, ...row }) => row),
    histories: value.histories?.filter(row => !row.automatic || value.records?.some(record => record.sourceId === row.id) || row.revoked),
  }))
  // Observation cursors and automatically indexed events are derived state;
  // they must not invalidate a user command's control-version CAS token.
  const observationControlSnapshot = (value: Binding) => {
    const copy = structuredClone(value)
    // Session/project discovery is derived from the current cwd; explicit project commands still CAS in manage().
    delete copy.projects
    copy.participants = copy.participants?.map(row => {
      const stable = { ...row } as Record<string, unknown>
      delete stable.cursor
      delete stable.grants
      return stable as typeof row
    })
    copy.histories = copy.histories?.filter(row => !row.automatic || row.revoked)
    return JSON.stringify({ ...copy, revision: undefined })
  }
  const status: SoulKnowledgeOwner['status'] = directory => {
    assertActive()
    const current = table.get(revisionOf(key(directory))), entry = '/prompt-tool knowledge <JSON：moduleId、action=preview|confirm|status>'
    if (!current) return { state: 'unbound', entry }
    try {
      assertModuleSnapshotSource(dirname(directory), basename(directory))
      if (identity(directory) !== current.moduleIdentity) throw new Error('来源模块身份已变化，请重新预览确认')
      if (identity(current.root) !== current.identity) throw new Error('知识库真实身份已变化，请重新预览确认')
      for (const path of [...current.read, ...current.write]) {
        safePath(path)
        const absolute = join(current.root, path)
        identity(dirname(absolute))
        const stat = lstatSync(absolute)
        if (stat.isSymbolicLink() || current.read.includes(path) && !stat.isFile() || current.write.includes(path) && !stat.isDirectory()) throw new Error('授权资料类型已变化或被替换为链接')
      }
      return { state: 'bound', binding: structuredClone(current), consolidationRevision: consolidationRevision(current), learningRevision: consolidationRevision(current), entry }
    } catch (error) { return { state: 'unavailable', reason: String((error as Error).message), entry } }
  }
  const prepare = (directory: string, request: SoulKnowledgeRequest) => {
    assertActive()
    assertModuleSnapshotSource(dirname(directory), basename(directory))
    if (!request || Object.keys(request).some(k => !['moduleId', 'action', 'root', 'read', 'write', 'expectedRevision'].includes(k)) || request.moduleId !== basename(directory)) throw new Error('知识库请求必须声明准确模块主语，不能含未知字段')
    if (request.root !== undefined && (typeof request.root !== 'string' || !isAbsolute(request.root))) throw new Error('知识库根必须为绝对路径')
    const root = resolve(request.root ?? join(directory, 'data'))
    if (root.split(/[\\/]/).some(part => /^\.(?:soul|runtime)$/i.test(part))) throw new Error('不能将运行状态保护区域作为知识库根')
    const read = request.read ?? [], write = request.write ?? []
    if (!Array.isArray(read) || !Array.isArray(write) || read.length > 200 || write.length > 2) throw new Error('知识库授权范围非法')
    for (const path of [...read, ...write]) safePath(path)
    if (write.some(path => !['general', 'projects'].includes(path))) throw new Error('写入范围只能明确选择general或projects')
    const snapshot = rootSnapshot(root)
    for (const path of read) if (!snapshot.entries.some(item => item.path === path && item.kind === 'file')) throw new Error('所选旧资料不存在或不是普通文件')
    for (const path of write) if (snapshot.entries.some(item => item.path === path && item.kind !== 'directory')) throw new Error('拟创建范围已被文件或链接占用')
    const current = table.get(revisionOf(key(directory)))
    const moduleStat = lstatSync(join(directory, 'module.yml'))
    const revision = revisionOf(JSON.stringify([key(directory), identity(directory), moduleStat.size, moduleStat.mtimeMs, moduleStat.ctimeMs, root, read, write, snapshot, current?.revision ?? null]))
    return { root, read: [...read], write: [...write], snapshot, revision }
  }
  const requireBinding = (directory: string) => {
    const value = status(directory)
    if (value.state !== 'bound' || !value.binding) throw new Error('知识库未接入或授权不可用：' + (value.reason ?? value.state))
    return value.binding
  }
  const scopeOf = (value: Binding, sessionId: string) => {
    const selected = value.projects?.find(item => item.sessionId === sessionId)
    if (selected && projectIdentity(selected.path).identity !== selected.identity) throw new Error('会话项目身份变化，不能扩大授权')
    return selected?.identity
  }
  const readSource = (value: Binding, item: z.infer<typeof source>): KnowledgeDocument => {
    safePath(item.path)
    if (!value.read.includes(item.path)) throw new Error('来源不在已确认读取范围')
    identity(dirname(join(value.root, item.path)))
    const stat = lstatSync(join(value.root, item.path))
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('知识来源不可读取')
    const content = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(join(value.root, item.path)))
    const revision = revisionOf(content)
    if (revision !== item.version) throw new Error('知识来源版本变化，请重新预览确认')
    return { kind: 'knowledge', moduleId: basename(value.directory), root: revisionOf(JSON.stringify([value.identity, value.moduleIdentity, value.generation ?? null])), path: item.path, scope: item.scope, sourceId: item.id, revision, content }
  }
  const sources: SoulKnowledgeOwner['sources'] = (directory, sessionId) => {
    const value = requireBinding(directory), project = scopeOf(value, sessionId)
    const participant = value.participants?.findLast(row => row.sessionId === sessionId)
    const inherited = (id: string) => !participant?.parent || participant.grants.includes(id)
    const documents = (value.sources ?? []).filter(item => !item.revoked && inherited(item.id) && (item.scope === 'general' || item.scope === project)).map(item => readSource(value, item))
    const histories = (value.histories ?? []).filter(item => !item.revoked && inherited(item.id) && (item.scope === 'general' || item.scope === project))
    const allowed = new Set([...documents.map(row => row.sourceId), ...histories.map(row => row.id)])
    for (const row of value.publications ?? []) {
      if (!value.continuity?.enabled) continue
      if (!row.roots.every(id => allowed.has(id)) || row.scope !== 'general' && row.scope !== project) continue
      if (row.roots.some((id, index) => revisionOf(JSON.stringify([...(value.sources ?? []), ...(value.histories ?? [])].find(source => source.id === id))) !== row.rootVersions[index])) continue
      if (row.roots.some(id => {
        const source = histories.find(source => source.id === id)
        if (!source) return false
        const session = evidenceSessions.get(source.sessionId)
        return !session || source.seqs.some((seq, index) => revisionOf(JSON.stringify(session.snapshotEvents().find(event => event.seq === seq))) !== source.versions[index])
      })) continue
      try {
        identity(dirname(join(value.root, row.path)))
        const stat = lstatSync(join(value.root, row.path))
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) continue
        const content = readFileSync(join(value.root, row.path), 'utf8')
        if (revisionOf(content) !== row.version) continue
        documents.push({ kind: 'knowledge', moduleId: basename(directory), root: revisionOf(JSON.stringify([value.identity, value.moduleIdentity, value.generation ?? null])), path: row.path, scope: row.scope, sourceId: row.id, revision: row.version, content })
      } catch { /* 不可用的不可变版本停止使用，不扫描替代文件。 */ }
    }
    return { state: project ? 'ready' : 'pending-classification', documents, histories }
  }
  const tracked = <T>(operation: Promise<T>): Promise<T> => {
    pending.add(operation)
    void operation.then(() => pending.delete(operation), () => pending.delete(operation))
    return operation
  }
  const visibleRecords = (directory: string, sessionId: string) => {
    const value = requireBinding(directory), allowed = new Set(sources(directory, sessionId).histories.map(row => row.id))
    return (value.records ?? []).filter(row => allowed.has(row.sourceId))
  }
  const reconcile = (directory: string, value: Binding) => {
    for (const entry of readSoulLedgerProjection(directory).entries) {
      const origin = entry.origin as unknown as ContinuitySource | undefined
      if (!origin || typeof origin.operation !== 'string' || value.records?.some(row => row.operation === origin.operation)) continue
      const source = value.histories?.find(row => row.id === origin.sourceId && row.sessionId === origin.sessionId && row.seqs.includes(origin.seq))
      if (!source || source.versions[source.seqs.indexOf(origin.seq)] !== origin.version || source.scope !== origin.scope) continue
      ;(value.records ??= []).push({ ...origin, entryId: entry.id, pending: true })
    }
  }
  const owner: SoulKnowledgeOwner = {
    assisted,
    onChange(listener) { changeListeners.add(listener); return () => { changeListeners.delete(listener) } },
    status,
    sources,
    learning(directory, sessionId, includeInactive = false) {
      const value = requireBinding(directory), access = sources(directory, sessionId)
      if (!includeInactive && !value.continuity?.enabled) return []
      const allowed = new Set(access.histories.map(row => row.id))
      const valid = (row: z.infer<typeof learning>, trail = new Set<string>()): boolean => {
        if (trail.has(row.id)) return false
        if (row.previous) {
          const previous = value.learning?.find(item => item.id === row.previous)
          if (!previous || previous.state !== 'adopted' || !valid(previous, new Set([...trail, row.id]))) return false
        }
        if (row.evidence?.some(item => {
          const source = access.histories.find(source => source.id === item.id), session = source && evidenceSessions.get(source.sessionId)
          return !source || revisionOf(JSON.stringify(source)) !== item.version || !session || source.seqs.some((seq, index) => revisionOf(JSON.stringify(session.snapshotEvents().find(event => event.seq === seq))) !== source.versions[index])
        })) return false
        const source = access.histories.find(source => source.id === row.sourceId)
        const session = source && evidenceSessions.get(source.sessionId)
        return Boolean(allowed.has(row.sourceId) && source && revisionOf(JSON.stringify(source)) === row.sourceVersion && session && source.seqs.every((seq, index) => revisionOf(JSON.stringify(session.snapshotEvents().find(event => event.seq === seq))) === source.versions[index]))
      }
      if (includeInactive) {
        const project = scopeOf(value, sessionId), participant = value.participants?.findLast(row => row.sessionId === sessionId)
        return (value.learning ?? []).filter(row => (row.scope === 'general' || row.scope === project) && (!participant?.parent || participant.grants.includes(row.sourceId))).map(row => valid(row) ? row : { ...row, text: '[来源不可用，学习正文未展示]', ...(row.assessment ? { assessment: { ...row.assessment, reason: '[来源不可用，处理依据未展示]' } } : {}), inactiveReason: '来源撤权、缺失或版本变化；不生效，仅保留审阅元信息' })
      }
      const rows = (value.learning ?? []).filter(row => row.state === 'adopted' && valid(row))
      return rows.filter(row => !rows.some(next => next.previous === row.id))
    },
    learn(directory, sessionId, request, signal, assertAuthorized) {
      return tracked(queue.run(key(directory), async () => {
        signal.throwIfAborted()
        const parsed = z.object({ text: z.string().min(1).max(2048), layer: learning.shape.layer, ref: z.string(), refs: z.array(z.string()).max(200).optional(), assessment: assessment.optional(), expectedRevision: z.string(), basis: z.enum(['explicit-long-term', 'inference']).default('inference'), previous: z.string().optional() }).strict().parse(request)
        const value = requireBinding(directory)
        if (!value.continuity?.enabled || consolidationRevision(value) !== parsed.expectedRevision) throw new Error('学习版本冲突或持续记忆关闭')
        const record = visibleRecords(directory, sessionId).find(row => row.entryId === parsed.ref)
        const source = sources(directory, sessionId).histories.find(row => row.id === record?.sourceId)
        if (!source) throw new Error('学习必须引用有效正式记录')
        const session = await loadEvidence(source.sessionId)
        const event = session?.snapshotEvents().find(event => event.seq === record!.seq)
        if (!event || revisionOf(JSON.stringify(event)) !== record!.version) throw new Error('学习原始来源版本已变化')
        const data = (event as unknown as { data: { source?: { kind?: string }; content?: Array<{ type: string; text?: string }> } }).data
        const participant = value.participants?.findLast(row => row.sessionId === source.sessionId)
        const original = data.content?.filter(row => row.type === 'text').map(row => row.text ?? '').join('\n')
        // 否定临时范围的表述不构成临时限制，其他临时措辞仍阻止直接采纳。
        const scopeText = original?.replace(/(?:不|并非|绝非|不是)(?:只|仅仅|仅)?(?:是|限于|限)?(?:这次|本次|暂时|今天|当前任务)|not (?:just |only )(?:this time|temporar\w*)/gi, '')
        // 语义识别归模型；作者、长期范围和核心确认门由真实原始事件约束。
        const direct = parsed.basis === 'explicit-long-term' && !participant?.parent && event.type === 'user/message' && data.source?.kind === 'user' && typeof scopeText === 'string' && /以后|今后|长期|始终|总是|from now on|always|going forward/i.test(scopeText) && !/这次|本次|暂时|今天|当前任务|just this|this time|temporar/i.test(scopeText) && !/身份|核心|原则|锁定|identity|principle|locked/i.test(original!) && !['core', 'locked'].includes(parsed.layer)
        if (parsed.previous && !owner.learning(directory, sessionId).some(row => row.id === parsed.previous && row.layer === parsed.layer && row.scope === source.scope)) throw new Error('被替换学习不存在或不适用')
        const access = sources(directory, sessionId), evidence = new Map<string, string>(), roots = new Set<string>(), supporting = new Set<string>(), derivedRefs = new Set<string>()
        const refs = [...new Set([parsed.ref, ...(parsed.refs ?? [])])]
        const visit = async (ref: string, support: boolean, trail = new Set<string>()): Promise<void> => {
          if (trail.has(ref)) throw new Error('学习证据循环')
          const derived = value.publications?.find(row => row.id === ref)
          if (derived) {
            if (!access.documents.some(row => row.sourceId === ref)) throw new Error('学习派生来源失效')
            derivedRefs.add(ref)
            for (const child of derived.refs) await visit(child, support, new Set([...trail, ref]))
            return
          }
          const entry = visibleRecords(directory, sessionId).find(row => row.entryId === ref)
          const origin = access.histories.find(row => row.id === (entry?.sourceId ?? ref))
          if (!origin || origin.scope !== source.scope) throw new Error('学习证据缺失或范围不一致')
          const originalSession = await loadEvidence(origin.sessionId)
          for (const [index, seq] of origin.seqs.entries()) {
            const event = originalSession?.snapshotEvents().find(row => row.seq === seq)
            if (!event || revisionOf(JSON.stringify(event)) !== origin.versions[index]) throw new Error('学习证据版本变化')
            const data = (event as unknown as { data: { id?: string; source?: { kind?: string } } }).data
            // 只把经核实的真实用户消息计为独立经历；摘要和委派不创造根。
            if (event.type === 'user/message' && data.source?.kind === 'user' && data.id && !value.participants?.some(row => row.sessionId === origin.sessionId && row.parent)) {
              const root = data.id
              roots.add(root)
              if (support) supporting.add(root)
            }
          }
          evidence.set(origin.id, revisionOf(JSON.stringify(origin)))
        }
        for (const ref of refs) await visit(ref, true)
        for (const ref of parsed.assessment?.counterRefs ?? []) await visit(ref, false)
        // 最后一次加载可能使已检查来源变化；提交前同步复核完整依赖。
        const finalAccess = sources(directory, sessionId)
        for (const [id, version] of evidence) {
          const origin = finalAccess.histories.find(item => item.id === id), session = origin && evidenceSessions.get(origin.sessionId)
          if (!origin || revisionOf(JSON.stringify(origin)) !== version || !session || origin.seqs.some((seq, index) => revisionOf(JSON.stringify(session.snapshotEvents().find(event => event.seq === seq))) !== origin.versions[index])) throw new Error('学习提交证据已变化或撤权')
        }
        for (const ref of derivedRefs) {
          if (!finalAccess.documents.some(item => item.sourceId === ref)) throw new Error('学习提交派生来源已失效')
        }
        if (parsed.previous && !owner.learning(directory, sessionId).some(row => row.id === parsed.previous)) throw new Error('被替换学习已失效')
        signal.throwIfAborted(); assertAuthorized?.(); assertActive()
        if (requireBinding(directory).revision !== value.revision) throw new Error('学习提交版本冲突')
        const inferred = parsed.basis === 'inference' && supporting.size >= 2 && parsed.assessment?.decision === 'adopt' && !parsed.assessment.unresolved && !['core', 'locked'].includes(parsed.layer)
        const row = learning.parse({ id: revisionOf(JSON.stringify([refs, parsed.text, parsed.layer, parsed.previous, parsed.assessment])), text: parsed.text, layer: parsed.layer, sourceId: source.id, sourceVersion: revisionOf(JSON.stringify(source)), scope: source.scope, evidence: [...evidence].map(([id, version]) => ({ id, version })), roots: [...roots], refs, ...(parsed.assessment ? { assessment: parsed.assessment } : {}), state: direct || inferred ? 'adopted' : 'candidate', ...(parsed.previous ? { previous: parsed.previous } : {}) })
        if (value.learning?.some(item => item.id === row.id)) return value.learning.find(item => item.id === row.id)!
        await saveBinding(revisionOf(key(directory)), { ...value, learning: [...(value.learning ?? []), row], revision: revisionOf(randomUUID()) })
        return row
      }))
    },
    async refreshEvidence(directory) {
      const value = requireBinding(directory), roots = new Set([...(value.publications ?? []).flatMap(row => row.roots), ...(value.learning ?? []).flatMap(row => [row.sourceId, ...(row.evidence ?? []).map(item => item.id)])])
      for (const id of new Set((value.histories ?? []).filter(row => roots.has(row.id) && !row.revoked).map(row => row.sessionId))) await loadEvidence(id)
      assertActive(); requireBinding(directory)
    },
    records: visibleRecords,
    async consolidate(directory, sessionId, request, signal, assertAuthorized) {
      signal.throwIfAborted(); assertAuthorized?.()
      await owner.refreshEvidence(directory)
      signal.throwIfAborted(); assertAuthorized?.()
      if (typeof request.text !== 'string' || !request.text.trim() || Buffer.byteLength(request.text) > 1024 * 1024 || !Array.isArray(request.refs) || !request.refs.length || request.refs.length > 200 || request.refs.some(ref => typeof ref !== 'string' || ref.length > 256) || typeof request.expectedRevision !== 'string') throw new Error('整理正文或引用非法、缺失或超限')
      const value = requireBinding(directory), access = sources(directory, sessionId)
      const id = revisionOf(JSON.stringify([sessionId, request.expectedRevision, request.text, request.refs]))
      const prior = value.publications?.find(row => row.id === id)
      if (prior) return { state: access.documents.some(row => row.sourceId === id) ? 'published' : 'inactive', candidateId: id }
      if (!value.continuity?.enabled || consolidationRevision(value) !== request.expectedRevision) throw new Error('整理版本冲突或持续记忆已关闭')
      const records = visibleRecords(directory, sessionId)
      const available = new Set([...access.documents.map(row => row.sourceId), ...access.histories.map(row => row.id)])
      const roots = new Set<string>(), scopes = new Set<string>(), processed = new Set<string>()
      for (const ref of request.refs) {
        const entry = records.find(row => row.entryId === ref)
        const derived = value.publications?.find(row => row.id === ref && available.has(row.id))
        const original = [...(value.sources ?? []), ...(value.histories ?? [])].find(row => row.id === ref && available.has(row.id))
        if (original && 'automatic' in original && original.automatic && !records.some(row => row.sourceId === original.id)) throw new Error('自动会话材料须先登记稳定条目再整理')
        if (entry) { roots.add(entry.sourceId); scopes.add(entry.scope); if (entry.pending) processed.add(entry.entryId) }
        else if (derived) { derived.roots.forEach(root => roots.add(root)); scopes.add(derived.scope) }
        else if (original) { roots.add(original.id); scopes.add(original.scope) }
        else throw new Error('整理引用不存在、未发布、循环或已失效')
      }
      if (!processed.size) return { state: 'no-work' }
      const project = scopeOf(value, sessionId), scope = scopes.size === 1 && scopes.has('general') ? 'general' : project
      if (!scope || [...scopes].some(item => item !== 'general' && item !== scope)) throw new Error('整理来源跨越未授权项目')
      const area = scope === 'general' ? 'general' : 'projects'
      if (!value.write.includes(area)) throw new Error('整理目标区域未授权写入')
      const verify = async () => {
        signal.throwIfAborted(); assertAuthorized?.(); assertActive()
        const current = requireBinding(directory)
        if (consolidationRevision(current) !== request.expectedRevision || scopeOf(current, sessionId) !== project) throw new Error('整理版本、输入或授权已变化')
        const currentAccess = sources(directory, sessionId)
        const allowed = new Set([...currentAccess.documents.map(row => row.sourceId), ...currentAccess.histories.map(row => row.id)])
        if (![...roots].every(root => allowed.has(root))) throw new Error('整理证据已失效')
        const historyRoots = currentAccess.histories.filter(row => roots.has(row.id))
        const participant = current.participants?.findLast(row => row.sessionId === sessionId && row.generation === current.continuity?.generation)
        for (const source of historyRoots) await loadEvidence(source.sessionId)
        await loadEvidence(sessionId)
        const session = await loadEvidence(participant?.rootSessionId ?? sessionId)
        for (const source of historyRoots) {
          const original = evidenceSessions.get(source.sessionId)
          if (!original || source.seqs.some((seq, index) => revisionOf(JSON.stringify(original.snapshotEvents().find(event => event.seq === seq))) !== source.versions[index])) throw new Error('整理原始事件版本已变化')
        }
        const finalAccess = sources(directory, sessionId)
        const finalAllowed = new Set([...finalAccess.documents.map(row => row.sourceId), ...finalAccess.histories.map(row => row.id)])
        if (![...roots].every(root => finalAllowed.has(root))) throw new Error('整理来源版本或授权已变化')
        const latestInput = session?.snapshotEvents().findLast(event => {
          const data = (event as unknown as { data?: { source?: { kind?: string } } }).data
          return event.type === 'user/message' && data?.source?.kind === 'user'
        }) as unknown as { data?: { id?: string } } | undefined
        if (!participant || latestInput?.data?.id !== participant.rootMessageId) throw new Error('新输入已使整理候选失效')
        signal.throwIfAborted(); assertAuthorized?.(); assertActive()
        if (requireBinding(directory).revision !== current.revision) throw new Error('整理提交版本冲突')
      }
      await verify()
      const path = area + '/soul-publication-' + id + '.md', absolute = join(value.root, path)
      identity(dirname(absolute))
      try { writeFileSync(absolute, request.text, { flag: 'wx', encoding: 'utf8' }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const stat = lstatSync(absolute)
        if (!stat.isFile() || stat.isSymbolicLink() || readFileSync(absolute, 'utf8') !== request.text) throw new Error('候选版本已被替换，不能覆盖')
      }
      try {
        return await tracked(queue.run(key(directory), async () => {
          await verify()
          if (readFileSync(absolute, 'utf8') !== request.text || lstatSync(absolute).isSymbolicLink()) throw new Error('候选正文版本已变化')
          const next = structuredClone(requireBinding(directory))
          const row = { id, path, scope, version: revisionOf(request.text), roots: [...roots], rootVersions: [...roots].map(id => revisionOf(JSON.stringify([...(next.sources ?? []), ...(next.histories ?? [])].find(source => source.id === id)))), refs: [...request.refs] }
          ;(next.publications ??= []).push(row)
          for (const record of next.records ?? []) if (processed.has(record.entryId)) record.pending = false
          next.revision = revisionOf(randomUUID())
          signal.throwIfAborted(); assertActive(); assertAuthorized?.()
          await saveBinding(revisionOf(key(directory)), next)
          const root = next.participants?.findLast(row => row.sessionId === sessionId && row.generation === next.continuity?.generation)?.rootSessionId
          try {
            if (root && !visibleRecords(directory, sessionId).some(row => row.pending)) await assisted.clearBacklog(JSON.stringify([directory, next.moduleIdentity, root]))
          } catch { /* 发布已生效，提示重置失败不能撤销正文。 */ }
          return { state: 'published', candidateId: id, revision: next.revision, reference: row }
        }))
      } catch (error) { return { state: 'candidate', candidateId: id, path, persisted: true, active: false, error: String(error), recovery: '候选已保存但未生效；使用同一正文、引用及预期版本重验，不能覆盖新版本' } }
    },
    recording(directory, sessionId) {
      const records = visibleRecords(directory, sessionId), allowed = new Set(sources(directory, sessionId).histories.map(row => row.id))
      const raw = readSoulLedgerProjection(directory).entries.filter(entry => {
        const origin = entry.origin as unknown as ContinuitySource | undefined
        return origin && allowed.has(origin.sourceId)
      })
      return { persisted: raw.length, pending: records.filter(row => row.pending).length, derivedFailed: raw.filter(entry => !records.some(row => row.entryId === entry.id)).length }
    },
    observe(directory, sessionId, eventSeq, parentSessionId, assertAuthorized, attached, cwd) {
      return tracked(queue.run(key(directory), async () => {
        const value = requireBinding(directory), control = value.continuity
        if (!control?.enabled) return
        const session = await loadEvidence(sessionId)
        if (!session) throw new Error('真实会话不可读取')
        const events = session.snapshotEvents()
        const next = structuredClone(value)
        if (!parentSessionId && !next.projects?.some(row => row.sessionId === sessionId) && cwd) {
          try {
            const current = projectIdentity(cwd)
            const matches = (value.projects ?? []).filter(row => row.identity === current.identity && projectIdentity(row.path).identity === row.identity)
            if (new Set(matches.map(row => row.identity)).size === 1) (next.projects ??= []).push({ sessionId, ...current })
          } catch { /* 目录不能匹配已声明项目时保持待归类。 */ }
        }
        let participant = next.participants?.find(row => row.sessionId === sessionId && row.generation === control.generation)
        if (participant && attached && eventSeq !== undefined) participant.cursor = Math.max(participant.cursor, eventSeq - 1)
        if (!participant) {
          const parent = parentSessionId && next.participants?.find(row => row.sessionId === parentSessionId && row.generation === control.generation)
          const scope = parent ? parent.scope : scopeOf(next, sessionId)
          if (!scope || parentSessionId && !parent) return
          const boundary = eventSeq === undefined ? events.reduce((max, row) => Math.max(max, row.seq), -1) : eventSeq - 1
          participant = { sessionId, scope, generation: control.generation, boundary,
            cursor: boundary, grants: parent ? [...sources(directory, parent.sessionId).documents, ...sources(directory, parent.sessionId).histories].map(row => 'sourceId' in row ? row.sourceId : row.id) : [...(value.histories ?? []), ...(value.sources ?? [])].filter(row => !row.revoked && (row.scope === 'general' || row.scope === scope)).map(row => row.id),
            rootSessionId: parent ? parent.rootSessionId : sessionId, ...(parent ? { parent: parent.sessionId, rootMessageId: parent.rootMessageId } : {}) }
          const priorTask = next.participants?.findLast(row => row.sessionId === sessionId && row.parent)
          if (priorTask) {
            participant.grants = participant.grants.filter(id => priorTask.grants.includes(id))
            participant.rootSessionId = priorTask.rootSessionId
            participant.rootMessageId = priorTask.rootMessageId
          }
          ;(next.participants ??= []).push(participant)
          if (parent) {
            const project = value.projects?.find(row => row.sessionId === parent.sessionId)
            if (project) (next.projects ??= []).push({ ...project, sessionId })
          }
        }
        if (participant.parent) {
          const parent = next.participants?.find(row => row.sessionId === participant!.parent && row.generation === control.generation)
          if (!parent) return
        }
        for (const event of events.filter(row => row.seq > participant!.cursor)) {
          participant.cursor = event.seq
          if (!['user/message', 'assistant/message', 'tool/result'].includes(event.type)) continue
          const data = (event as unknown as { data: { id?: string; source?: { kind?: string } } }).data
          if (!data || data.source?.kind === 'runtime-context' || event.time === undefined || event.time < control.enabledAt) continue
          const id = revisionOf(JSON.stringify([value.generation, sessionId, data.id ?? event.seq]))
          if (!participant.parent && event.type === 'user/message' && data.source?.kind === 'user' && typeof data.id === 'string') participant.rootMessageId = data.id
          if (next.histories?.some(row => row.id === id)) continue
          ;(next.histories ??= []).push({ id, sessionId, seqs: [event.seq], versions: [revisionOf(JSON.stringify(event))], scope: participant.scope, revoked: false, automatic: true })
          participant.grants.push(id)
        }
        reconcile(directory, next)
        if (requireBinding(directory).revision !== value.revision) throw new Error('知识来源版本已变化')
        assertActive(); assertAuthorized?.()
        if (observationControlSnapshot(next) !== observationControlSnapshot(value)) next.revision = revisionOf(randomUUID())
        else next.revision = value.revision
        await saveBinding(revisionOf(key(directory)), next)
      }))
    },
    record(directory, sessionId, operation, commit, signal) {
      return tracked(queue.run(key(directory), async () => {
        signal.throwIfAborted()
        const value = requireBinding(directory), participant = value.participants?.find(row => row.sessionId === sessionId && row.generation === value.continuity?.generation)
        if (!value.continuity?.enabled || !participant) throw new Error('持续记忆未启用或会话未参与Soul')
        const allowed = sources(directory, sessionId).histories
        const session = await loadEvidence(sessionId)
        const source = allowed.findLast(row => row.sessionId === sessionId && participant.grants.includes(row.id) && session?.snapshotEvents().some(event => {
          const data = (event as unknown as { data?: { id?: string; source?: { kind?: string } } }).data
          return event.seq === row.seqs[0] && event.type === 'user/message' && (participant.parent || data?.source?.kind === 'user' && data.id === participant.rootMessageId)
        }))
        if (!source) throw new Error('缺少当前已授权真实来源')
        const event = session?.snapshotEvents().find(row => row.seq === source.seqs[0])
        if (!event || event.time === undefined || revisionOf(JSON.stringify(event)) !== source.versions[0]) throw new Error('原始事件版本已变化')
        signal.throwIfAborted(); assertActive()
        if (requireBinding(directory).revision !== value.revision) throw new Error('知识来源版本已变化')
        const origin = { operation, sourceId: source.id, sessionId, seq: event.seq, time: event.time, version: source.versions[0]!, scope: source.scope, rootSessionId: participant.rootSessionId, ...(participant.rootMessageId ? { rootMessageId: participant.rootMessageId } : {}) }
        const result = commit(origin)
        try {
          const next = structuredClone(requireBinding(directory))
          reconcile(directory, next)
          next.revision = revisionOf(randomUUID())
          signal.throwIfAborted(); assertActive()
          await saveBinding(revisionOf(key(directory)), next)
          const actualOperation = (result.entry.origin as ContinuitySource | undefined)?.operation ?? operation
          const record = next.records?.find(row => row.operation === actualOperation)
          if (!record) throw new Error('原始条目未能关联有效来源')
          return { ...result, persisted: true, reference: record ?? null, derived: { state: 'pending' } }
        } catch (error) { return { ...result, persisted: true, derived: { state: 'failed', error: String(error), recovery: '原始记录已保存；恢复会补登记，不要重放事实' } } }
      }))
    },
    assertFile(directory, absolute, sessionId, write = false) {
      assertActive()
      const local = relative(directory, absolute).split('\\').join('/').toLowerCase()
      if (table.get(revisionOf(key(directory))) && ['data/02-soul.jsonl', 'data/02-墨.jsonl', 'data/.soul/self.md'].includes(local)) throw new Error('旧账本及SELF诊断快照待归类，不能经普通文件入口使用')
      const managed = [...table.entries()].map(([, value]) => value).filter(value => {
        const path = relative(value.root, absolute)
        return path === '' || path !== '..' && !path.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(path)
      })
      if (!managed.length) return
      const raw = table.get(revisionOf(key(directory)))
      if (!raw || !managed.some(value => value.directory === raw.directory)) throw new Error('受管知识资料不属于当前模块授权')
      const path = relative(raw.root, absolute).split('\\').join('/')
      // 接入根内的未知资料仍待归类；不能经通用文件工具绕过登记。
      if (!sessionId || write || !sources(directory, sessionId).documents.some(item => item.path === path)) throw new Error('受管知识资料未授权，不能经通用文件工具访问')
    },
    async manage(directory, request, sessionId, signal) {
      const operation = queue.run(key(directory), async () => {
        signal.throwIfAborted()
        const value = requireBinding(directory)
        if (!sessionId || request.moduleId !== basename(directory)) throw new Error('知识来源操作缺少真实会话或模块主语')
        if (Object.keys(request).some(field => !['moduleId', 'action', 'expectedRevision', 'path', 'scope', 'projectDirectory', 'sourceId', 'sessionId', 'seqs'].includes(field))) throw new Error('知识来源请求含未知字段')
        if (request.action === 'learning-list') return { learning: owner.learning(directory, sessionId, true), active: owner.learning(directory, sessionId), revision: value.revision }
        if (request.action === 'sources') return { ...sources(directory, sessionId), registrations: [...(value.sources ?? []), ...(value.histories ?? [])], pending: value.read.filter(path => !value.sources?.some(item => item.path === path)), project: value.projects?.find(item => item.sessionId === sessionId) ?? null, revision: value.revision }
        if (request.expectedRevision !== value.revision && !['source-preview'].includes(request.action)) throw new Error('知识库状态版本冲突，请重新查询')
        const next = structuredClone(value)
        if (['learning-confirm', 'learning-forget', 'learning-withdraw'].includes(request.action)) {
          if (value.participants?.findLast(row => row.sessionId === sessionId)?.parent) throw new Error('子任务不能确认或管理用户学习')
          const row = next.learning?.find(row => row.id === request.sourceId)
          if (!row || !sources(directory, sessionId).histories.some(source => source.id === row.sourceId)) throw new Error('学习不存在或当前无权管理')
          if (request.action === 'learning-confirm') {
            if (row.state !== 'candidate') throw new Error('只有候选可以确认')
            await owner.refreshEvidence(directory)
            if (owner.learning(directory, sessionId, true).find(item => item.id === row.id)?.inactiveReason) throw new Error('学习依赖证据已失效')
            const source = value.histories!.find(source => source.id === row.sourceId)!
            const session = await loadEvidence(source.sessionId)
            if (revisionOf(JSON.stringify(source)) !== row.sourceVersion || source.seqs.some((seq, index) => revisionOf(JSON.stringify(session?.snapshotEvents().find(event => event.seq === seq))) !== source.versions[index])) throw new Error('学习证据已变化')
            row.state = 'adopted'
            row.confirmation = { sessionId, revision: value.revision }
          } else {
            row.state = request.action === 'learning-forget' ? 'forgotten' : 'withdrawn'
            const disabled = new Set([row.id])
            for (const item of next.learning ?? []) if (item.previous && disabled.has(item.previous)) { item.state = row.state; disabled.add(item.id) }
          }
        } else if (request.action === 'enable' || request.action === 'disable') {
          if (!scopeOf(value, sessionId)) throw new Error('启用持续记忆前必须明确选择项目')
          next.directory = canonicalDirectory(directory)
          next.continuity = request.action === 'enable' && value.continuity?.enabled ? value.continuity : { enabled: request.action === 'enable', enabledAt: Date.now(), generation: randomUUID() }
          if (request.action === 'enable' && !value.continuity?.enabled) {
            const session = await loadEvidence(sessionId)
            if (!session) throw new Error('无法核实启用会话界线')
            const boundary = session.snapshotEvents().reduce((max, event) => Math.max(max, event.seq), -1)
            ;(next.participants ??= []).push({ sessionId, scope: scopeOf(value, sessionId)!, boundary, cursor: boundary, generation: next.continuity.generation,
              rootSessionId: sessionId, grants: [...(value.sources ?? []), ...(value.histories ?? [])].filter(row => !row.revoked && (row.scope === 'general' || row.scope === scopeOf(value, sessionId))).map(row => row.id) })
          }
        } else if (request.action === 'project') {
          if (!request.projectDirectory) throw new Error('必须明确选择项目目录')
          const chosen = projectIdentity(request.projectDirectory), prior = next.projects?.find(item => item.sessionId === sessionId)
          if (prior && prior.identity !== chosen.identity) throw new Error('会话已绑定其他项目，不能静默改变归属')
          next.projects = [...(next.projects ?? []).filter(item => item.sessionId !== sessionId), { sessionId, ...chosen }]
        } else if (request.action === 'revoke') {
          const selected = [...(next.sources ?? []), ...(next.histories ?? [])].find(item => item.id === request.sourceId)
          if (!selected) throw new Error('来源不存在')
          selected.revoked = true
        } else if (request.action === 'source-preview' || request.action === 'source-confirm') {
          if ((!request.path && !request.sessionId) || (request.path && request.sessionId) || !['general', 'project'].includes(request.scope ?? '')) throw new Error('必须明确选择资料或会话与通用或项目归属')
          const scope = request.scope === 'general' ? 'general' : scopeOf(value, sessionId)
          if (!scope) throw new Error('会话尚未绑定项目')
          if (request.sessionId) {
            if (typeof request.sessionId !== 'string' || request.sessionId.length > 256 || !Array.isArray(request.seqs) || !request.seqs.length || request.seqs.length > 1000 || request.seqs.some(seq => !Number.isSafeInteger(seq) || seq < 0)) throw new Error('历史范围必须明确选择真实事件')
            const session = await loadEvidence(request.sessionId)
            if (!session || session.id !== request.sessionId || !Array.isArray(request.seqs) || !request.seqs.length || request.seqs.length > 1000 || request.seqs.some(seq => !Number.isSafeInteger(seq) || !session.snapshotEvents().some(event => event.seq === seq)) || new Set(request.seqs).size !== request.seqs.length) throw new Error('历史范围必须明确选择真实事件')
            const item = { id: revisionOf(JSON.stringify([request.sessionId, request.seqs])), sessionId: request.sessionId, seqs: request.seqs, versions: request.seqs.map(seq => revisionOf(JSON.stringify(session.snapshotEvents().find(event => event.seq === seq)))), scope, revoked: false }
            const revision = revisionOf(JSON.stringify([value.revision, sessionId, item, session.snapshotEvents().filter(event => request.seqs!.includes(event.seq))]))
            const previewKey = key(directory) + ':' + sessionId
            if (request.action === 'source-preview') { previews.set(previewKey, revision); return { state: 'source-preview', source: item, revision, expectedRevision: value.revision } }
            if (previews.get(previewKey) !== revision || requireBinding(directory).revision !== value.revision) throw new Error('来源预览失效，请重新预览')
            next.histories = [...(next.histories ?? []).filter(row => row.id !== item.id), item]
            previews.delete(previewKey)
          } else {
          if (!request.path) throw new Error('缺少资料路径')
          if (request.path.split('/').some(part => part.startsWith('soul-publication-'))) throw new Error('候选资料只能经受控发布纳入')
          safePath(request.path)
          if (!value.read.includes(request.path)) throw new Error('来源不在已确认读取范围')
          identity(dirname(join(value.root, request.path)))
          const stat = lstatSync(join(value.root, request.path))
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('知识来源不可读取')
          const content = readFileSync(join(value.root, request.path))
          const item = { id: revisionOf(JSON.stringify([value.identity, request.path])), path: request.path, scope, version: revisionOf(new TextDecoder('utf-8', { fatal: true }).decode(content)), revoked: false }
          readSource(value, item)
          const revision = revisionOf(JSON.stringify([value.revision, sessionId, item]))
          const previewKey = key(directory) + ':' + sessionId
          if (request.action === 'source-preview') { previews.set(previewKey, revision); return { state: 'source-preview', source: item, revision, expectedRevision: value.revision } }
          if (previews.get(previewKey) !== revision) throw new Error('来源预览失效，请重新预览')
          next.sources = [...(next.sources ?? []).filter(row => row.id !== item.id), item]
          previews.delete(previewKey)
          }
        } else throw new Error('知识来源操作无效')
        if (requireBinding(directory).revision !== value.revision) throw new Error('知识库状态版本冲突，请重新查询')
        next.revision = revisionOf(randomUUID())
        signal.throwIfAborted(); assertActive()
        await saveBinding(revisionOf(key(directory)), next)
        return { state: 'persisted', revision: next.revision }
      })
      pending.add(operation)
      void operation.then(() => pending.delete(operation), () => pending.delete(operation))
      return operation
    },
    preview(directory, request) {
      const value = prepare(directory, request)
      previews.set(key(directory), value.revision)
      return { state: 'preview', ...value, create: [...(value.snapshot.identity ? [] : [value.root]), ...value.write.filter(path => !value.snapshot.entries.some(item => item.path === path))], protected: ['ledger', 'SELF', 'AGENTS.md', 'CLAUDE.md', '.soul', '.runtime', '未知文件不授权、不搬迁、不覆盖'], scopes: { general: '通用资料', projects: '项目资料：接入本身不授予跨项目使用权限' } }
    },
    confirm(directory, request, signal) {
      const operation = queue.run(key(directory), async () => {
        signal.throwIfAborted()
        const value = prepare(directory, request)
        if (!request.expectedRevision || request.expectedRevision !== value.revision || previews.get(key(directory)) !== value.revision) throw new Error('知识库预览已失效，请重新预览确认')
        if (!value.snapshot.identity) mkdirSync(value.root)
        for (const path of value.write) if (!value.snapshot.entries.some(item => item.path === path)) mkdirSync(join(value.root, path))
        const next = { directory: canonicalDirectory(directory), moduleIdentity: identity(directory), root: realpathSync(value.root), identity: identity(value.root), read: value.read, write: value.write, revision: revisionOf(randomUUID()), generation: randomUUID() }
        signal.throwIfAborted(); assertActive()
        await saveBinding(revisionOf(key(directory)), next)
        previews.delete(key(directory))
        return status(directory)
      })
      pending.add(operation)
      void operation.then(() => pending.delete(operation), () => pending.delete(operation))
      return operation
    },
    async dispose() {
      active = false
      for (const listener of changeListeners) { try { listener() } catch { /* 释放继续清理其余监听。 */ } }
      changeListeners.clear(); previews.clear()
      await Promise.allSettled(pending); await assisted.dispose(); await domain.close()
    },
  }
  for (const [id, value] of table.entries()) {
    try {
      const next = structuredClone(requireBinding(value.directory))
      for (const id of new Set((next.histories ?? []).filter(row => !row.revoked).map(row => row.sessionId))) await loadEvidence(id)
      reconcile(value.directory, next)
      if (next.records?.length !== value.records?.length) {
        next.revision = revisionOf(randomUUID())
        await saveBinding(id, next)
      }
    } catch { /* 不可用来源保持原状；不扫描释放期间的新会话材料。 */ }
  }
  return owner
}
