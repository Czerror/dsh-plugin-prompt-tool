/** 本机知识库授权：只由用户命令确认，模块导出不包含官方持久域。 */
import { constants, lstatSync, mkdirSync, realpath, realpathSync, readFileSync, writeFileSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, open, opendir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { createTargetQueue } from '../shared/target-queue.ts'
import { canonicalDirectory, directoryKey, revisionOf } from './module-write.ts'
import { assertModuleSnapshotSource } from './module-install.ts'
import type { LoadRetrievalSession } from './module-retrieval.ts'
import { createRetrievalEventProjection, retrievalEventRevision } from './module-retrieval.ts'
import { readSoulLedgerProjection } from './soul-ledger.ts'
import { openAssistedBudget } from './soul-assisted-budget.ts'
import { createSoulEvidence } from './soul-evidence.ts'
import { installModulePackage } from './module-package.ts'
import { createProjectIdentities } from './soul-project-identity.ts'
import type { AssetFile, AssetImportRequest } from '../shared/asset-transfer.ts'

const source = z.object({ id: z.string(), path: z.string(), scope: z.string(), version: z.string(), revoked: z.boolean() }).strict()
const project = z.object({ sessionId: z.string(), path: z.string(), identity: z.string() }).strict()
const history = z.object({ id: z.string(), sessionId: z.string(), seqs: z.array(z.number()), versions: z.array(z.string()), scope: z.string(), revoked: z.boolean(), automatic: z.boolean().optional() }).strict()
const participation = z.object({ sessionId: z.string(), boundary: z.number(), cursor: z.number(), scope: z.string(), generation: z.string(), parent: z.string().optional(), grants: z.array(z.string()), rootSessionId: z.string(), rootMessageId: z.string().optional() }).strict()
const recorded = z.object({ operation: z.string(), entryId: z.string(), sourceId: z.string(), sessionId: z.string(), seq: z.number(), time: z.number(), version: z.string(), scope: z.string(), rootSessionId: z.string(), rootMessageId: z.string().optional(), pending: z.boolean() }).strict()
const publication = z.object({ id: z.string(), path: z.string(), scope: z.string(), version: z.string(), roots: z.array(z.string()), rootVersions: z.array(z.string()), refs: z.array(z.string()) }).strict()
const assessment = z.object({ decision: z.enum(['adopt', 'candidate']), reason: z.string().trim().min(1).max(2048), unresolved: z.boolean(), counterRefs: z.array(z.string()).max(200) }).strict()
const learning = z.object({ id: z.string(), text: z.string(), layer: z.enum(['expression', 'judgment', 'experience', 'core', 'locked']), sourceId: z.string(), sourceVersion: z.string(), scope: z.string(), state: z.enum(['candidate', 'adopted', 'forgotten', 'withdrawn']), evidence: z.array(z.object({ id: z.string(), version: z.string() }).strict()).optional(), roots: z.array(z.string()).optional(), refs: z.array(z.string()).optional(), assessment: assessment.optional(), previous: z.string().optional(), confirmation: z.object({ sessionId: z.string(), revision: z.string() }).strict().optional(), inactiveReason: z.string().optional() }).strict()
const binding = z.object({ directory: z.string(), moduleIdentity: z.string(), assistedIdentity: z.string().optional(), root: z.string(), identity: z.string(), read: z.array(z.string()), write: z.array(z.string()), revision: z.string(), generation: z.string().optional(), sources: z.array(source).optional(), projects: z.array(project).optional(), histories: z.array(history).optional(), continuity: z.object({ enabled: z.boolean(), enabledAt: z.number(), generation: z.string() }).strict().optional(), participants: z.array(participation).optional(), records: z.array(recorded).optional(), publications: z.array(publication).optional(), learning: z.array(learning).optional() }).strict()
const definition = defineDomain({ name: 'prompt_tool_soul_knowledge', version: 1, tables: { bindings: domainTable(binding) } })
type Binding = z.infer<typeof binding>
export interface SoulKnowledgeRequest { moduleId: string; action: 'status' | 'preview' | 'confirm' | 'sources' | 'source-preview' | 'source-confirm' | 'revoke' | 'project' | 'enable' | 'disable' | 'learning-list' | 'learning-confirm' | 'learning-forget' | 'learning-withdraw'; root?: string; read?: string[]; write?: string[]; expectedRevision?: string; path?: string; scope?: 'general' | 'project'; projectDirectory?: string; sourceId?: string; sessionId?: string; seqs?: number[] }
export interface KnowledgeDocument { kind: 'knowledge'; moduleId: string; root: string; path: string; scope: string; sourceId: string; revision: string; content: string }
export interface SoulKnowledgeOwner {
  assisted: Awaited<ReturnType<typeof openAssistedBudget>>
  onChange(listener: () => void): () => void
  control(directory: string, sessionId?: string): () => void
  status(directory: string): { state: 'unbound' | 'bound' | 'unavailable'; binding?: Binding; consolidationRevision?: string; learningRevision?: string; reason?: string; entry: string }
  preview(directory: string, request: SoulKnowledgeRequest, signal: AbortSignal): Promise<Record<string, unknown>>
  confirm(directory: string, request: SoulKnowledgeRequest, signal: AbortSignal): Promise<ReturnType<SoulKnowledgeOwner['status']>>
  upgrade(directory: string, files: AssetFile[], request: AssetImportRequest, expectedBindingRevision: string | null, signal: AbortSignal): Promise<{ id: string; backupPath?: string }>
  sources(directory: string, sessionId: string): { state: string; documents: KnowledgeDocument[]; histories: z.infer<typeof history>[] }
  withEvidence<T>(scopes: readonly { directory: string; sessionId: string }[], signal: AbortSignal | undefined, callback: (verify: () => Promise<void>) => T | Promise<T>): Promise<T>
  readEvidence: LoadRetrievalSession
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
// fs.realpath 与 realpathSync 保留同样的路径拼写，fs.promises.realpath 会展开 Windows 别名。
const realpathAsync = promisify(realpath)
function fileVersion(stat: Stats) {
  return revisionOf(JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]))
}
async function asyncIdentity(path: string, check: () => void): Promise<string> {
  const absolute = resolve(path), anchor = parse(absolute).root
  let current = anchor
  for (const part of relative(anchor, absolute).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part)
    const stat = await lstat(current)
    check()
    if (!stat.isDirectory()) throw new Error('知识库路径含链接或非目录，授权不可用')
  }
  const stat = await lstat(absolute)
  check()
  if (!stat.isDirectory()) throw new Error('知识库根不是目录')
  const physical = await realpathAsync(absolute)
  check()
  // 短名、挂载点等别名会让字面路径与 realpath 不同却指向同一目录，只能按对象身份判断变化。
  const resolved = await lstat(physical)
  check()
  if (!resolved.isDirectory() || resolved.dev !== stat.dev || resolved.ino !== stat.ino) throw new Error('知识库实际路径已变化，请重新预览')
  return revisionOf(JSON.stringify([physical, stat.dev, stat.ino, stat.birthtimeMs]))
}
async function selectedFileDigest(path: string, version: string, buffer: Buffer, check: () => void) {
  const changed = () => new Error('所选旧资料已变化，请重新预览')
  check()
  await asyncIdentity(dirname(path), check)
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = await file.stat()
    check()
    await asyncIdentity(dirname(path), check)
    const current = await lstat(path)
    check()
    if (!stat.isFile() || !current.isFile() || fileVersion(stat) !== version || fileVersion(current) !== version) throw changed()
    const hash = createHash('sha256')
    let remaining = stat.size
    while (remaining > 0) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(remaining, buffer.length), null)
      check()
      if (bytesRead === 0) throw changed()
      hash.update(buffer.subarray(0, bytesRead))
      remaining -= bytesRead
    }
    if (fileVersion(await file.stat()) !== version) throw changed()
    return hash.digest('hex')
  } finally { await file.close() }
}
async function rootSnapshot(root: string, check: () => void) {
  const parent = await asyncIdentity(dirname(root), check)
  const changed = () => new Error('知识库目录已变化，预览已失效，请重新预览')
  let rootStat: Stats
  try { rootStat = await lstat(root) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    check()
    if (await asyncIdentity(dirname(root), check) !== parent) throw changed()
    const appeared = await lstat(root, { throwIfNoEntry: false })
    check()
    if (appeared) throw changed()
    return { identity: null, parent, entries: [] }
  }
  check()
  if (!rootStat.isDirectory()) throw changed()
  const rootIdentity = await asyncIdentity(root, check)
  type DirectoryVersion = { path: string; version: string }
  const rootVersion = { path: root, version: fileVersion(rootStat) }
  const directories = [rootVersion]
  async function verify(directory: DirectoryVersion) {
    const stat = await lstat(directory.path)
    check()
    if (!stat.isDirectory() || fileVersion(stat) !== directory.version) throw changed()
  }
  async function verifyChain(chain: DirectoryVersion[]) {
    if (await asyncIdentity(root, check) !== rootIdentity) throw changed()
    for (const directory of chain) await verify(directory)
  }
  const entries: { path: string; size: number; kind: string; version: string }[] = []
  let enumerated = 0
  async function visit(chain: DirectoryVersion[], directory: string, prefix: string, depth: number): Promise<void> {
    await verifyChain(chain)
    const names: string[] = []
    const opened = await opendir(directory, { bufferSize: 1 })
    try {
      check()
      await verifyChain(chain)
      for (;;) {
        const item = await opened.read()
        check()
        if (!item) break
        enumerated++
        if (enumerated > 2000) throw new Error('知识库预览超过2000项，请选择更小的根')
        names.push(item.name)
      }
    } finally { await opened.close() }
    await verifyChain(chain)
    for (const name of names.sort()) {
      const path = prefix + name, absolute = join(directory, name), stat = await lstat(absolute)
      check()
      const version = fileVersion(stat)
      entries.push({ path, size: stat.size, kind: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'special', version })
      if (stat.isDirectory() && !protectedPath(path)) {
        if (depth >= 8) throw new Error('知识库层级过深，请选择更小的根')
        const child = { path: absolute, version }
        directories.push(child)
        await visit([...chain, child], absolute, path + '/', depth + 1)
      }
    }
    await verifyChain(chain)
  }
  await visit([rootVersion], root, '', 0)
  for (const directory of directories) await verify(directory)
  if (await asyncIdentity(root, check) !== rootIdentity || await asyncIdentity(dirname(root), check) !== parent) throw changed()
  return { identity: rootIdentity, parent, entries }
}
export async function openSoulKnowledge(facility: DomainFacility, loadSession?: LoadRetrievalSession): Promise<SoulKnowledgeOwner> {
  const assisted = await openAssistedBudget(facility)
  const changeListeners = new Set<() => void>()
  const domain = await facility.open(definition).catch(async error => {
    await assisted.dispose().catch(() => {})
    throw error
  })
  const table = domain.table('bindings'), queue = createTargetQueue()
  const controls = new Map<string, { revision: string; token: symbol }>()
  const projects = createProjectIdentities(path => {
    for (const [id, value] of table.entries()) {
      if (value.projects?.some(row => row.path === path)) controls.delete(id)
    }
    for (const listener of changeListeners) { try { listener() } catch { /* 继续通知其他授权使用方。 */ } }
  })
  const projectIdentity = projects.read
  const prepareProjects = async (value: Binding, signal?: AbortSignal, sessionId?: string) => {
    for (const row of value.projects?.filter(row => !sessionId || row.sessionId === sessionId) ?? []) {
      if ((await projects.prepare(row.path, signal)).identity !== row.identity) throw new Error('会话项目身份变化，不能扩大授权')
    }
  }
  const saveBinding = async (id: string, value: Binding) => {
    await table.put(id, value)
    const revision = consolidationRevision(value)
    if (controls.get(id)?.revision !== revision) controls.set(id, { revision, token: Symbol() })
    for (const listener of changeListeners) { try { listener() } catch { /* 通知失败不撤销已持久化事实。 */ } }
  }
  const evidence = createSoulEvidence(loadSession)
  const observationCursors = new Map<string, number>()
  const loadEvidence = evidence.load
  let active = true
  const pending = new Set<Promise<unknown>>()
  const previews = new Map<string, string>()
  const bindingPreviews = new Map<string, { revision?: string; metadataRevision?: string }>()
  const key = (directory: string) => directoryKey(canonicalDirectory(directory))
  const assertActive = () => { if (!active) throw new Error('知识库持久状态已释放') }
  const moduleStamp = (directory: string) => {
    const stat = lstatSync(join(directory, 'module.yml'))
    if (!stat.isFile()) throw new Error('预设定义不是普通文件')
    return revisionOf(JSON.stringify([identity(directory), fileVersion(stat)]))
  }
  const consolidationRevision = (value: Binding) => {
    const recordedSources = new Set(value.records?.map(record => record.sourceId))
    return revisionOf(JSON.stringify({ ...value, revision: undefined,
      participants: value.participants?.map(({ cursor: _cursor, grants: _grants, ...row }) => row),
      histories: value.histories?.filter(row => !row.automatic || recordedSources.has(row.id) || row.revoked),
    }))
  }
  // Observation cursors and automatically indexed events are derived state;
  // they must not invalidate a user command's control-version CAS token.
  const observationControlSnapshot = (value: Binding) => {
    const copy = structuredClone(value)
    // Session/project discovery is derived from the current cwd; explicit project commands still CAS in manage().
    delete copy.projects
    // Participants are created and advanced by observation; user control uses
    // explicit project/enable/source records instead.
    delete copy.participants
    copy.histories = copy.histories?.filter(row => !row.automatic || row.revoked)
    return JSON.stringify({ ...copy, revision: undefined })
  }
  const assertIdentity = (directory: string, current: Pick<Binding, 'moduleIdentity' | 'root' | 'identity' | 'read' | 'write'>, verifiedModuleStamp?: string) => {
    if (verifiedModuleStamp === undefined) assertModuleSnapshotSource(dirname(directory), basename(directory))
    else if (moduleStamp(directory) !== verifiedModuleStamp) throw new Error('来源模块身份已变化，请重新预览确认')
    if (identity(directory) !== current.moduleIdentity) throw new Error('来源模块身份已变化，请重新预览确认')
    if (identity(current.root) !== current.identity) throw new Error('知识库真实身份已变化，请重新预览确认')
    for (const path of [...current.read, ...current.write]) {
      safePath(path)
      const absolute = join(current.root, path)
      identity(dirname(absolute))
      const stat = lstatSync(absolute)
      if (stat.isSymbolicLink() || current.read.includes(path) && !stat.isFile() || current.write.includes(path) && !stat.isDirectory()) throw new Error('授权资料类型已变化或被替换为链接')
    }
  }
  const status = (directory: string, verifiedModuleStamp?: string): ReturnType<SoulKnowledgeOwner['status']> => {
    assertActive()
    const current = table.get(revisionOf(key(directory))), entry = '/prompt-tool knowledge <JSON：moduleId、action=preview|confirm|status>'
    if (!current) return { state: 'unbound', entry }
    try {
      assertIdentity(directory, current, verifiedModuleStamp)
      const revision = consolidationRevision(current)
      return { state: 'bound', binding: structuredClone(current), consolidationRevision: revision, learningRevision: revision, entry }
    } catch (error) { return { state: 'unavailable', reason: String((error as Error).message), entry } }
  }
  const prepareTarget = (directory: string, request: SoulKnowledgeRequest) => {
    if (!request || Object.keys(request).some(k => !['moduleId', 'action', 'root', 'read', 'write', 'expectedRevision'].includes(k)) || request.moduleId !== basename(directory)) throw new Error('知识库请求必须声明准确模块主语，不能含未知字段')
    if (request.root !== undefined && (typeof request.root !== 'string' || !isAbsolute(request.root))) throw new Error('知识库根必须为绝对路径')
    const root = resolve(request.root ?? join(directory, 'data'))
    if (root.split(/[\\/]/).some(part => /^\.(?:soul|runtime)$/i.test(part))) throw new Error('不能将运行状态保护区域作为知识库根')
    const read = request.read ?? [], write = request.write ?? []
    if (!Array.isArray(read) || !Array.isArray(write) || read.length > 200 || write.length > 2) throw new Error('知识库授权范围非法')
    for (const path of [...read, ...write]) safePath(path)
    if (write.some(path => !['general', 'projects'].includes(path))) throw new Error('写入范围只能明确选择general或projects')
    const stamp = moduleStamp(directory)
    assertModuleSnapshotSource(dirname(directory), basename(directory))
    if (moduleStamp(directory) !== stamp) throw new Error('来源模块身份已变化，请重新预览确认')
    return { root, read: [...read], write: [...write], stamp }
  }
  const inspectTarget = async (id: string, directory: string, target: ReturnType<typeof prepareTarget>, check: () => void) => {
    const { root, read, write, stamp } = target
    const snapshot = await rootSnapshot(root, check)
    check()
    if (moduleStamp(directory) !== stamp) throw new Error('来源模块身份已变化，请重新预览确认')
    const byPath = new Map(snapshot.entries.map(entry => [entry.path, entry]))
    const selected = [...new Set(read)].map(path => {
      const entry = byPath.get(path)
      if (entry?.kind !== 'file') throw new Error('所选旧资料不存在或不是普通文件')
      return entry
    })
    for (const path of write) {
      const entry = byPath.get(path)
      if (entry && entry.kind !== 'directory') throw new Error('拟创建范围已被文件或链接占用')
    }
    const current = table.get(revisionOf(id))
    const metadataRevision = revisionOf(JSON.stringify([id, stamp, root, read, write, snapshot, current?.revision ?? null]))
    return { snapshot, byPath, selected, metadataRevision }
  }
  const digestSelection = async (root: string, selected: Awaited<ReturnType<typeof inspectTarget>>['selected'], check: () => void) => {
    const buffer = Buffer.allocUnsafe(64 * 1024), digests: string[] = []
    for (const { path, version } of selected) digests.push(await selectedFileDigest(join(root, path), version, buffer, check))
    return digests
  }
  const stalePreview = () => new Error('知识库预览已失效，请重新预览确认')
  const recheckGrants = (root: string, read: string[], write: string[], value: Awaited<ReturnType<typeof inspectTarget>>) => {
    if (identity(dirname(root)) !== value.snapshot.parent) throw stalePreview()
    if (!value.snapshot.identity && lstatSync(root, { throwIfNoEntry: false })) throw stalePreview()
    if (value.snapshot.identity && identity(root) !== value.snapshot.identity) throw stalePreview()
    const reviewed = new Set<string>()
    for (const path of read) {
      const parts = path.split('/')
      let prefix = ''
      for (const [index, part] of parts.entries()) {
        prefix += prefix ? '/' + part : part
        if (reviewed.has(prefix)) continue
        const stat = lstatSync(join(root, prefix), { throwIfNoEntry: false })
        if (!stat || !(index === parts.length - 1 ? stat.isFile() : stat.isDirectory()) || fileVersion(stat) !== value.byPath.get(prefix)?.version) throw stalePreview()
        reviewed.add(prefix)
      }
    }
    for (const path of write) {
      const stat = lstatSync(join(root, path), { throwIfNoEntry: false }), entry = value.byPath.get(path)
      if (entry ? !stat?.isDirectory() || fileVersion(stat) !== entry.version : stat !== undefined) throw stalePreview()
    }
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
    evidence.assert(JSON.stringify([key(directory), sessionId]))
    const value = requireBinding(directory), project = scopeOf(value, sessionId)
    const participant = value.participants?.findLast(row => row.sessionId === sessionId)
    const inherited = (id: string) => !participant?.parent || participant.grants.includes(id)
    const documents = (value.sources ?? []).filter(item => !item.revoked && inherited(item.id) && (item.scope === 'general' || item.scope === project)).map(item => readSource(value, item))
    const histories = (value.histories ?? []).filter(item => {
      if (item.revoked || !inherited(item.id) || item.scope !== 'general' && item.scope !== project) return false
      if (item.seqs.some(seq => !evidence.includes(item.sessionId, seq))) throw new Error('当前证据集合已变化，请结束操作后重新准备')
      if (!item.automatic) return true
      return item.seqs.every(seq => evidence.reference(item.sessionId, seq)?.public)
    })
    const allowed = new Set([...documents.map(row => row.sourceId), ...histories.map(row => row.id)])
    let originals: Map<string, z.infer<typeof source> | z.infer<typeof history>> | undefined
    const historyAt = evidence.histories(histories)
    for (const row of value.publications ?? []) {
      if (!value.continuity?.enabled) continue
      if (!row.roots.every(id => allowed.has(id)) || row.scope !== 'general' && row.scope !== project) continue
      if (row.roots.some((id, index) => {
        const selected = historyAt(id)
        if (selected) return selected.version !== row.rootVersions[index]
        originals ??= new Map([...(value.sources ?? []), ...(value.histories ?? [])].map(source => [source.id, source]))
        return revisionOf(JSON.stringify(originals.get(id))) !== row.rootVersions[index]
      })) continue
      if (row.roots.some(id => historyAt(id)?.valid === false)) continue
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
    return (value.records ?? []).filter(row => allowed.has(row.sourceId) && evidence.reference(row.sessionId, row.seq)?.version === row.version)
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
    readEvidence: evidence.load,
    assisted,
    onChange(listener) { changeListeners.add(listener); return () => { changeListeners.delete(listener) } },
    status,
    control(directory, sessionId) {
      const access = status(directory)
      if (access.state !== 'bound') throw new Error('知识库授权不可用')
      const id = revisionOf(key(directory)), revision = access.consolidationRevision!
      if (controls.get(id)?.revision !== revision) controls.set(id, { revision, token: Symbol() })
      const token = controls.get(id)!.token
      const { root, moduleIdentity, identity: rootIdentity, read, write } = access.binding!
      const authorization = { root, moduleIdentity, identity: rootIdentity, read, write }
      const selectedProjects = access.binding!.projects?.filter(row => !sessionId || row.sessionId === sessionId) ?? []
      return () => {
        assertActive()
        if (controls.get(id)?.token !== token) throw new Error('输入、来源、授权或整理版本已变化')
        for (const row of selectedProjects) if (projectIdentity(row.path).identity !== row.identity) throw new Error('会话项目身份变化')
        assertIdentity(directory, authorization)
      }
    },
    sources,
    upgrade(directory, files, request, expectedBindingRevision, signal) {
      const operation = queue.run(key(directory), async () => {
        signal.throwIfAborted(); assertActive()
        const current = status(directory)
        if (current.state === 'unavailable' || (current.binding?.revision ?? null) !== expectedBindingRevision) throw new Error('升级知识库状态已变化，请重新预览')
        const previous = current.binding
        return installModulePackage(dirname(directory), files, request, { preserveAssets: true, signal,
          beforeCommit: () => {
            signal.throwIfAborted(); assertActive()
            const latest = status(directory)
            if (latest.state !== current.state || (latest.binding?.revision ?? null) !== expectedBindingRevision) throw new Error('升级知识库授权或身份已变化，请重新预览')
          },
          commit: async () => {
            if (!previous) return
            assertActive()
            const path = relative(directory, previous.root)
            const internal = path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep)
            const rootIdentity = identity(previous.root)
            if (!internal && rootIdentity !== previous.identity) throw new Error('升级期间知识库真实身份已变化')
            const next = { ...previous, moduleIdentity: identity(directory), identity: internal ? rootIdentity : previous.identity, assistedIdentity: previous.assistedIdentity ?? previous.moduleIdentity, revision: revisionOf(randomUUID()) }
            await saveBinding(revisionOf(key(directory)), next)
          },
        })
      })
      pending.add(operation)
      void operation.then(() => pending.delete(operation), () => pending.delete(operation))
      return operation
    },
    learning(directory, sessionId, includeInactive = false) {
      const value = requireBinding(directory), access = sources(directory, sessionId)
      if (!includeInactive && !value.continuity?.enabled) return []
      const historyAt = evidence.histories(access.histories)
      const learningById = new Map(value.learning?.map(row => [row.id, row]))
      const validity = new Map<string, boolean>()
      const valid = (row: z.infer<typeof learning>): boolean => {
        const cached = validity.get(row.id)
        if (cached !== undefined) return cached
        validity.set(row.id, false)
        if (row.previous) {
          const previous = learningById.get(row.previous)
          if (!previous || previous.state !== 'adopted' || !valid(previous)) return false
        }
        if (row.evidence?.some(item => {
          const source = historyAt(item.id)
          return !source || source.version !== item.version || !source.valid
        })) return false
        const source = historyAt(row.sourceId)
        const result = Boolean(source && source.version === row.sourceVersion && source.valid)
        validity.set(row.id, result)
        return result
      }
      if (includeInactive) {
        const project = scopeOf(value, sessionId), participant = value.participants?.findLast(row => row.sessionId === sessionId)
        return (value.learning ?? []).filter(row => (row.scope === 'general' || row.scope === project) && (!participant?.parent || participant.grants.includes(row.sourceId))).map(row => valid(row) ? row : { ...row, text: '[来源不可用，学习正文未展示]', ...(row.assessment ? { assessment: { ...row.assessment, reason: '[来源不可用，处理依据未展示]' } } : {}), inactiveReason: '来源撤权、缺失或版本变化；不生效，仅保留审阅元信息' })
      }
      const rows = (value.learning ?? []).filter(row => row.state === 'adopted' && valid(row))
      const replaced = new Set(rows.map(row => row.previous))
      return rows.filter(row => !replaced.has(row.id))
    },
    learn(directory, sessionId, request, signal, assertAuthorized) {
      return tracked(queue.run(key(directory), async () => {
        signal.throwIfAborted()
        const parsed = z.object({ text: z.string().min(1).max(2048), layer: learning.shape.layer, ref: z.string(), refs: z.array(z.string()).max(200).optional(), assessment: assessment.optional(), expectedRevision: z.string(), basis: z.enum(['explicit-long-term', 'inference']).default('inference'), previous: z.string().optional() }).strict().parse(request)
        const value = requireBinding(directory)
        if (!value.continuity?.enabled || consolidationRevision(value) !== parsed.expectedRevision) throw new Error('学习版本冲突或持续记忆关闭')
        await prepareProjects(value, signal, sessionId)
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
        const access = sources(directory, sessionId), dependencies = new Map<string, string>(), roots = new Set<string>(), supporting = new Set<string>(), derivedRefs = new Set<string>()
        const historyAt = evidence.histories(access.histories)
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
          const selected = historyAt(entry?.sourceId ?? ref)
          const origin = selected?.source
          if (!origin || origin.scope !== source.scope) throw new Error('学习证据缺失或范围不一致')
          if (!selected!.valid) throw new Error('学习证据版本变化')
          const originalSession = await loadEvidence(origin.sessionId)
          const events = new Map(originalSession?.snapshotEvents().map(event => [event.seq, event]))
          for (const [index, seq] of origin.seqs.entries()) {
            const event = events.get(seq)
            if (!event || revisionOf(JSON.stringify(event)) !== origin.versions[index]) throw new Error('学习证据版本变化')
            const data = (event as unknown as { data: { id?: string; source?: { kind?: string } } }).data
            // 只把经核实的真实用户消息计为独立经历；摘要和委派不创造根。
            if (event.type === 'user/message' && data.source?.kind === 'user' && data.id && !value.participants?.some(row => row.sessionId === origin.sessionId && row.parent)) {
              const root = data.id
              roots.add(root)
              if (support) supporting.add(root)
            }
          }
          dependencies.set(origin.id, revisionOf(JSON.stringify(origin)))
        }
        for (const ref of refs) await visit(ref, true)
        for (const ref of parsed.assessment?.counterRefs ?? []) await visit(ref, false)
        const currentParticipant = value.participants?.findLast(row => row.sessionId === sessionId && row.generation === value.continuity?.generation)
        const rootSession = await loadEvidence(currentParticipant?.rootSessionId ?? sessionId)
        // 最后一次加载可能使已检查来源变化；提交前同步复核完整依赖。
        const finalAccess = sources(directory, sessionId)
        const finalHistoryAt = evidence.histories(finalAccess.histories)
        for (const [id, version] of dependencies) {
          const origin = finalHistoryAt(id)
          if (!origin || origin.version !== version || !origin.valid) throw new Error('学习提交证据已变化或撤权')
        }
        for (const ref of derivedRefs) {
          if (!finalAccess.documents.some(item => item.sourceId === ref)) throw new Error('学习提交派生来源已失效')
        }
        if (parsed.previous && !owner.learning(directory, sessionId).some(row => row.id === parsed.previous)) throw new Error('被替换学习已失效')
        const latestInput = rootSession?.snapshotEvents().findLast(event => {
          const data = (event as unknown as { data?: { source?: { kind?: string } } }).data
          return event.type === 'user/message' && data?.source?.kind === 'user'
        }) as unknown as { data?: { id?: string } } | undefined
        if (!currentParticipant || latestInput?.data?.id !== currentParticipant.rootMessageId) throw new Error('新输入已使学习候选失效')
        signal.throwIfAborted(); assertAuthorized?.(); assertActive()
        if (requireBinding(directory).revision !== value.revision) throw new Error('学习提交版本冲突')
        const inferred = parsed.basis === 'inference' && supporting.size >= 2 && parsed.assessment?.decision === 'adopt' && !parsed.assessment.unresolved && !['core', 'locked'].includes(parsed.layer)
        const row = learning.parse({ id: revisionOf(JSON.stringify([refs, parsed.text, parsed.layer, parsed.previous, parsed.assessment])), text: parsed.text, layer: parsed.layer, sourceId: source.id, sourceVersion: revisionOf(JSON.stringify(source)), scope: source.scope, evidence: [...dependencies].map(([id, version]) => ({ id, version })), roots: [...roots], refs, ...(parsed.assessment ? { assessment: parsed.assessment } : {}), state: direct || inferred ? 'adopted' : 'candidate', ...(parsed.previous ? { previous: parsed.previous } : {}) })
        if (value.learning?.some(item => item.id === row.id)) return value.learning.find(item => item.id === row.id)!
        await saveBinding(revisionOf(key(directory)), { ...value, learning: [...(value.learning ?? []), row], revision: revisionOf(randomUUID()) })
        return row
      }))
    },
    async withEvidence(scopes, signal, callback) {
      assertActive(); signal?.throwIfAborted()
      const selections = []
      for (const { directory, sessionId } of scopes) {
        if (!sessionId) throw new Error('证据操作缺少真实会话')
        const value = requireBinding(directory)
        await prepareProjects(value, signal, sessionId)
        const project = scopeOf(value, sessionId), participant = value.participants?.findLast(row => row.sessionId === sessionId)
        const histories = (value.histories ?? []).filter(row => !row.revoked && (row.scope === 'general' || row.scope === project) && (!participant?.parent || participant.grants.includes(row.id)))
        selections.push({ key: JSON.stringify([key(directory), sessionId]), histories: [...histories, { sessionId, seqs: [] }, ...(participant ? [{ sessionId: participant.rootSessionId, seqs: [] }] : [])] })
      }
      return evidence.run(selections, signal, () => callback(evidence.verify))
    },
    records: visibleRecords,
    async consolidate(directory, sessionId, request, signal, assertAuthorized) {
      signal.throwIfAborted(); assertAuthorized?.()
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
        const historyAt = evidence.histories(historyRoots)
        for (const source of historyRoots) {
          if (!historyAt(source.id)?.valid) throw new Error('整理原始事件版本已变化')
        }
        const finalAccess = sources(directory, sessionId)
        const finalAllowed = new Set([...finalAccess.documents.map(row => row.sourceId), ...finalAccess.histories.map(row => row.id)])
        if (![...roots].every(root => finalAllowed.has(root))) throw new Error('整理来源版本或授权已变化')
        const latestInput = session?.snapshotEvents().findLast(event => {
          const data = (event as unknown as { data?: { source?: { kind?: string } } }).data
          return event.type === 'user/message' && data?.source?.kind === 'user'
        }) as unknown as { data?: { id?: string } } | undefined
        if (!participant || latestInput?.data?.id !== participant.rootMessageId) throw new Error('新输入已使整理候选失效')
        const entries = readSoulLedgerProjection(directory).entries
        for (const record of records.filter(row => request.refs.includes(row.entryId))) {
          if (!entries.some(entry => entry.id === record.entryId && (entry.origin as unknown as ContinuitySource | undefined)?.operation === record.operation)) throw new Error('整理账本条目已变化')
        }
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
            if (root && !visibleRecords(directory, sessionId).some(row => row.pending)) await assisted.clearBacklog(JSON.stringify([directory, next.assistedIdentity ?? next.moduleIdentity, root]))
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
        await prepareProjects(value, undefined, sessionId)
        const session = await evidence.loadRaw(sessionId)
        if (!session) throw new Error('真实会话不可读取')
        const events = session.snapshotEvents()
        const priorParticipant = value.participants?.find(row => row.sessionId === sessionId && row.generation === control.generation)
        const observationKey = JSON.stringify([key(directory), control.generation, sessionId])
        const cursor = Math.max(priorParticipant?.cursor ?? -1, observationCursors.get(observationKey) ?? -1)
        if (priorParticipant && !attached && (events.at(-1)?.seq ?? -1) <= cursor) return
        const projection = createRetrievalEventProjection()(events)
        const next = structuredClone(value)
        if (!parentSessionId && !next.projects?.some(row => row.sessionId === sessionId) && cwd) {
          try {
            const current = await projects.prepare(cwd)
            const matches = []
            for (const row of value.projects ?? []) {
              if (row.identity !== current.identity) continue
              try { if ((await projects.prepare(row.path)).identity === row.identity) matches.push(row) }
              catch { /* 其他会话失效项目不作为cwd归属依据。 */ }
            }
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
        participant.cursor = Math.max(participant.cursor, cursor)
        const existing = new Set(next.histories?.map(row => row.id))
        let offset = events.length
        while (offset > 0 && events[offset - 1]!.seq > participant.cursor) offset--
        for (const event of events.slice(offset)) {
          participant.cursor = event.seq
          const data = (event as unknown as { data: { id?: string; source?: { kind?: string } } }).data
          if (!data || event.time === undefined || event.time < control.enabledAt) continue
          if (!participant.parent && event.type === 'user/message' && data.source?.kind === 'user' && typeof data.id === 'string') participant.rootMessageId = data.id
          if (!projection.contents.has(event.seq)) continue
          const id = revisionOf(JSON.stringify([value.generation, sessionId, data.id ?? event.seq]))
          if (existing.has(id)) continue
          existing.add(id)
          ;(next.histories ??= []).push({ id, sessionId, seqs: [event.seq], versions: [retrievalEventRevision(event)], scope: participant.scope, revoked: false, automatic: true })
          participant.grants.push(id)
        }
        if (priorParticipant && !attached && next.histories?.length === value.histories?.length
          && participant.rootMessageId === priorParticipant.rootMessageId && next.projects?.length === value.projects?.length
          && !events.slice(offset).some(event => event.type === 'command/run' || event.type === 'command/done')) {
          observationCursors.set(observationKey, participant.cursor)
          return
        }
        reconcile(directory, next)
        if (requireBinding(directory).revision !== value.revision) throw new Error('知识来源版本已变化')
        assertActive(); assertAuthorized?.()
        if (observationControlSnapshot(next) !== observationControlSnapshot(value)) next.revision = revisionOf(randomUUID())
        else next.revision = value.revision
        await saveBinding(revisionOf(key(directory)), next)
        observationCursors.set(observationKey, participant.cursor)
      }))
    },
    record(directory, sessionId, operation, commit, signal) {
      return tracked(queue.run(key(directory), async () => {
        signal.throwIfAborted()
        const value = requireBinding(directory), participant = value.participants?.find(row => row.sessionId === sessionId && row.generation === value.continuity?.generation)
        if (!value.continuity?.enabled || !participant) throw new Error('持续记忆未启用或会话未参与Soul')
        await prepareProjects(value, signal, sessionId)
        const allowed = sources(directory, sessionId).histories
        const session = await loadEvidence(sessionId)
        const events = session?.snapshotEvents() ?? []
        const eventsBySeq = new Map(events.map(event => [event.seq, event]))
        const source = allowed.findLast(row => {
          if (row.sessionId !== sessionId || !participant.grants.includes(row.id)) return false
          const event = eventsBySeq.get(row.seqs[0]!)
          if (!event) return false
          const data = (event as unknown as { data?: { id?: string; source?: { kind?: string } } }).data
          return event.type === 'user/message' && (participant.parent || data?.source?.kind === 'user' && data.id === participant.rootMessageId)
        })
        if (!source) throw new Error('缺少当前已授权真实来源')
        const event = eventsBySeq.get(source.seqs[0]!)
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
        if (!['project', 'revoke', 'disable', 'learning-forget', 'learning-withdraw'].includes(request.action)) await prepareProjects(value, signal, sessionId)
        if (Object.keys(request).some(field => !['moduleId', 'action', 'expectedRevision', 'path', 'scope', 'projectDirectory', 'sourceId', 'sessionId', 'seqs'].includes(field))) throw new Error('知识来源请求含未知字段')
        if (request.action === 'learning-list') return { learning: owner.learning(directory, sessionId, true), active: owner.learning(directory, sessionId), revision: value.revision }
        if (request.action === 'sources') return { ...sources(directory, sessionId), registrations: [...(value.sources ?? []), ...(value.histories ?? [])], pending: value.read.filter(path => !value.sources?.some(item => item.path === path)), project: value.projects?.find(item => item.sessionId === sessionId) ?? null, revision: value.revision }
        if (request.expectedRevision !== value.revision && !['source-preview'].includes(request.action)) throw new Error('知识库状态版本冲突，请重新查询')
        const next = structuredClone(value)
        if (['learning-confirm', 'learning-forget', 'learning-withdraw'].includes(request.action)) {
          if (value.participants?.findLast(row => row.sessionId === sessionId)?.parent) throw new Error('子任务不能确认或管理用户学习')
          const row = next.learning?.find(row => row.id === request.sourceId)
          const project = value.projects?.find(item => item.sessionId === sessionId)?.identity
          const manageable = request.action === 'learning-confirm' ? sources(directory, sessionId).histories : (value.histories ?? []).filter(source => source.scope === 'general' || source.scope === project)
          if (!row || !manageable.some(source => source.id === row.sourceId && source.scope === row.scope)) throw new Error('学习不存在或当前无权管理')
          if (request.action === 'learning-confirm') {
            if (row.state !== 'candidate') throw new Error('只有候选可以确认')
            if (owner.learning(directory, sessionId, true).find(item => item.id === row.id)?.inactiveReason) throw new Error('学习依赖证据已失效')
            const source = value.histories!.find(source => source.id === row.sourceId)!
            await loadEvidence(source.sessionId)
            const selected = evidence.histories([source])(source.id)!
            if (selected.version !== row.sourceVersion || !selected.valid) throw new Error('学习证据已变化')
            row.state = 'adopted'
            row.confirmation = { sessionId, revision: value.revision }
          } else {
            row.state = request.action === 'learning-forget' ? 'forgotten' : 'withdrawn'
            const disabled = new Set([row.id])
            for (const item of next.learning ?? []) if (item.previous && disabled.has(item.previous)) { item.state = row.state; disabled.add(item.id) }
          }
        } else if (request.action === 'enable' || request.action === 'disable') {
          if (!(request.action === 'enable' ? scopeOf(value, sessionId) : value.projects?.find(row => row.sessionId === sessionId)?.identity)) throw new Error('启停持续记忆前必须明确选择项目')
          next.directory = canonicalDirectory(directory)
          next.continuity = request.action === 'enable' && value.continuity?.enabled ? value.continuity : { enabled: request.action === 'enable', enabledAt: Date.now(), generation: randomUUID() }
          if (request.action === 'enable' && !value.continuity?.enabled) {
            const session = await evidence.loadRaw(sessionId, signal)
            if (!session) throw new Error('无法核实启用会话界线')
            const boundary = session.snapshotEvents().reduce((max, event) => Math.max(max, event.seq), -1)
            ;(next.participants ??= []).push({ sessionId, scope: scopeOf(value, sessionId)!, boundary, cursor: boundary, generation: next.continuity.generation,
              rootSessionId: sessionId, grants: [...(value.sources ?? []), ...(value.histories ?? [])].filter(row => !row.revoked && (row.scope === 'general' || row.scope === scopeOf(value, sessionId))).map(row => row.id) })
          }
        } else if (request.action === 'project') {
          if (!request.projectDirectory) throw new Error('必须明确选择项目目录')
          const chosen = await projects.prepare(request.projectDirectory, signal), prior = next.projects?.find(item => item.sessionId === sessionId)
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
            const session = await evidence.loadRaw(request.sessionId, signal)
            if (!session || session.id !== request.sessionId) throw new Error('历史范围必须明确选择真实事件')
            const events = session.snapshotEvents(), eventsBySeq = new Map(events.map(event => [event.seq, event]))
            if (request.seqs.some(seq => !eventsBySeq.has(seq)) || new Set(request.seqs).size !== request.seqs.length) throw new Error('历史范围必须明确选择真实事件')
            const selectedSeqs = new Set(request.seqs)
            const selectedEvents = request.seqs.map(seq => eventsBySeq.get(seq)!)
            const item = { id: revisionOf(JSON.stringify([request.sessionId, request.seqs])), sessionId: request.sessionId, seqs: request.seqs, versions: selectedEvents.map(event => revisionOf(JSON.stringify(event))), scope, revoked: false }
            const revision = revisionOf(JSON.stringify([value.revision, sessionId, item, events.filter(event => selectedSeqs.has(event.seq))]))
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
    async preview(directory, request, signal) {
      signal.throwIfAborted(); assertActive()
      const target = prepareTarget(directory, request), id = key(directory)
      const preview: { revision?: string; metadataRevision?: string } = {}
      bindingPreviews.set(id, preview)
      const check = () => {
        signal.throwIfAborted(); assertActive()
        if (bindingPreviews.get(id) !== preview) throw stalePreview()
      }
      const operation = (async () => {
        const value = await inspectTarget(id, directory, target, check)
        const digests = value.selected.length ? await digestSelection(target.root, value.selected, check) : []
        if (value.selected.length && (await inspectTarget(id, directory, target, check)).metadataRevision !== value.metadataRevision) throw stalePreview()
        check()
        const { root, read, write } = target
        const { snapshot, metadataRevision } = value
        const revision = revisionOf(JSON.stringify([metadataRevision, digests]))
        Object.assign(preview, { metadataRevision, revision })
        return { state: 'preview', root, read, write, snapshot, revision, create: [...(snapshot.identity ? [] : [root]), ...write.filter(path => !snapshot.entries.some(item => item.path === path))], protected: ['ledger', 'SELF', 'AGENTS.md', 'CLAUDE.md', '.soul', '.runtime', '未知文件不授权、不搬迁、不覆盖'], scopes: { general: '通用资料', projects: '项目资料：接入本身不授予跨项目使用权限' } }
      })()
      pending.add(operation)
      try { return await operation } finally {
        pending.delete(operation)
        if (!preview.revision && bindingPreviews.get(id) === preview) bindingPreviews.delete(id)
      }
    },
    confirm(directory, request, signal) {
      const id = key(directory), preview = bindingPreviews.get(id)
      const check = () => {
        signal.throwIfAborted(); assertActive()
        if (!preview?.revision || request.expectedRevision !== preview.revision || bindingPreviews.get(id) !== preview) throw stalePreview()
      }
      const operation = queue.run(id, async () => {
        check()
        const target = prepareTarget(directory, request)
        const value = await inspectTarget(id, directory, target, check)
        if (preview?.metadataRevision !== value.metadataRevision) throw stalePreview()
        const digests = value.selected.length ? await digestSelection(target.root, value.selected, check) : []
        if (preview.revision !== revisionOf(JSON.stringify([value.metadataRevision, digests]))) throw stalePreview()
        if (value.selected.length && (await inspectTarget(id, directory, target, check)).metadataRevision !== value.metadataRevision) throw stalePreview()
        check()
        const { root, read, write, stamp } = target
        recheckGrants(root, read, write, value)
        if (!value.snapshot.identity) mkdirSync(root)
        for (const path of write) if (!value.byPath.has(path)) mkdirSync(join(root, path))
        const next = { directory: canonicalDirectory(directory), moduleIdentity: identity(directory), root: realpathSync(root), identity: identity(root), read, write, revision: revisionOf(randomUUID()), generation: randomUUID() }
        signal.throwIfAborted(); assertActive()
        await saveBinding(revisionOf(key(directory)), next)
        if (bindingPreviews.get(id) === preview) bindingPreviews.delete(id)
        return status(directory, stamp)
      })
      pending.add(operation)
      void operation.then(() => pending.delete(operation), () => pending.delete(operation))
      return operation
    },
    async dispose() {
      active = false
      evidence.dispose()
      projects.dispose()
      controls.clear()
      for (const listener of changeListeners) { try { listener() } catch { /* 释放继续清理其余监听。 */ } }
      changeListeners.clear(); previews.clear(); bindingPreviews.clear()
      await Promise.allSettled(pending); await assisted.dispose(); await domain.close()
    },
  }
  const learn = owner.learn, record = owner.record, consolidate = owner.consolidate, manage = owner.manage, observe = owner.observe
  owner.learn = (directory, sessionId, request, signal, assertAuthorized) => owner.withEvidence([{ directory, sessionId }], signal, () => learn(directory, sessionId, request, signal, assertAuthorized))
  owner.record = (directory, sessionId, operation, commit, signal) => owner.withEvidence([{ directory, sessionId }], signal, () => record(directory, sessionId, operation, commit, signal))
  owner.consolidate = (directory, sessionId, request, signal, assertAuthorized) => owner.withEvidence([{ directory, sessionId }], signal, () => consolidate(directory, sessionId, request, signal, assertAuthorized))
  owner.manage = (directory, request, sessionId, signal) => ['sources', 'learning-list', 'learning-confirm'].includes(request.action)
    ? owner.withEvidence([{ directory, sessionId }], signal, () => manage(directory, request, sessionId, signal))
    : manage(directory, request, sessionId, signal)
  owner.observe = (directory, sessionId, eventSeq, parentSessionId, assertAuthorized, attached, cwd) => parentSessionId
    ? owner.withEvidence([{ directory, sessionId: parentSessionId }], undefined, () => observe(directory, sessionId, eventSeq, parentSessionId, assertAuthorized, attached, cwd))
    : observe(directory, sessionId, eventSeq, parentSessionId, assertAuthorized, attached, cwd)
  for (const [id, value] of table.entries()) {
    try {
      const next = structuredClone(requireBinding(value.directory))
      for (const row of next.projects ?? []) {
        try { await projects.prepare(row.path) } catch { /* 单个失效项目不阻止其他会话恢复；读取时仍严格核对。 */ }
      }
      reconcile(value.directory, next)
      if (next.records?.length !== value.records?.length) {
        next.revision = revisionOf(randomUUID())
        await saveBinding(id, next)
      }
    } catch { /* 不可用来源保持原状；不扫描释放期间的新会话材料。 */ }
  }
  return owner
}
