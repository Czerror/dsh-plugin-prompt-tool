/** 本机知识库授权：只由用户命令确认，模块导出不包含官方持久域。 */
import { lstatSync, mkdirSync, readdirSync, realpathSync, readFileSync } from 'node:fs'
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

const source = z.object({ id: z.string(), path: z.string(), scope: z.string(), version: z.string(), revoked: z.boolean() }).strict()
const project = z.object({ sessionId: z.string(), path: z.string(), identity: z.string() }).strict()
const history = z.object({ id: z.string(), sessionId: z.string(), seqs: z.array(z.number()), versions: z.array(z.string()), scope: z.string(), revoked: z.boolean() }).strict()
const binding = z.object({ directory: z.string(), moduleIdentity: z.string(), root: z.string(), identity: z.string(), read: z.array(z.string()), write: z.array(z.string()), revision: z.string(), generation: z.string().optional(), sources: z.array(source).optional(), projects: z.array(project).optional(), histories: z.array(history).optional() }).strict()
const definition = defineDomain({ name: 'prompt_tool_soul_knowledge', version: 1, tables: { bindings: domainTable(binding) } })
type Binding = z.infer<typeof binding>
export interface SoulKnowledgeRequest { moduleId: string; action: 'status' | 'preview' | 'confirm' | 'sources' | 'source-preview' | 'source-confirm' | 'revoke' | 'project'; root?: string; read?: string[]; write?: string[]; expectedRevision?: string; path?: string; scope?: 'general' | 'project'; projectDirectory?: string; sourceId?: string; sessionId?: string; seqs?: number[] }
export interface KnowledgeDocument { kind: 'knowledge'; moduleId: string; root: string; path: string; scope: string; sourceId: string; revision: string; content: string }
export interface SoulKnowledgeOwner {
  status(directory: string): { state: 'unbound' | 'bound' | 'unavailable'; binding?: Binding; reason?: string; entry: string }
  preview(directory: string, request: SoulKnowledgeRequest): Record<string, unknown>
  confirm(directory: string, request: SoulKnowledgeRequest, signal: AbortSignal): Promise<ReturnType<SoulKnowledgeOwner['status']>>
  sources(directory: string, sessionId: string): { state: string; documents: KnowledgeDocument[]; histories: z.infer<typeof history>[] }
  manage(directory: string, request: SoulKnowledgeRequest, sessionId: string, signal: AbortSignal): Promise<Record<string, unknown>>
  assertFile(directory: string, absolute: string, sessionId?: string, write?: boolean): void
  dispose(): Promise<void>
}
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
  const domain = await facility.open(definition), table = domain.table('bindings'), queue = createTargetQueue()
  let active = true
  const pending = new Set<Promise<unknown>>()
  const previews = new Map<string, string>()
  const key = (directory: string) => directoryKey(canonicalDirectory(directory))
  const assertActive = () => { if (!active) throw new Error('知识库持久状态已释放') }
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
      return { state: 'bound', binding: structuredClone(current), entry }
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
    if (value.state !== 'bound' || !value.binding) throw new Error('知识库未接入或授权不可用')
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
    const documents = (value.sources ?? []).filter(item => !item.revoked && (item.scope === 'general' || item.scope === project)).map(item => readSource(value, item))
    const histories = (value.histories ?? []).filter(item => !item.revoked && (item.scope === 'general' || item.scope === project))
    return { state: project ? 'ready' : 'pending-classification', documents, histories }
  }
  return {
    status,
    sources,
    assertFile(directory, absolute, sessionId, write = false) {
      assertActive()
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
        if (request.action === 'sources') return { ...sources(directory, sessionId), registrations: [...(value.sources ?? []), ...(value.histories ?? [])], pending: value.read.filter(path => !value.sources?.some(item => item.path === path)), project: value.projects?.find(item => item.sessionId === sessionId) ?? null, revision: value.revision }
        if (request.expectedRevision !== value.revision && !['source-preview'].includes(request.action)) throw new Error('知识库状态版本冲突，请重新查询')
        const next = structuredClone(value)
        if (request.action === 'project') {
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
            const session = await loadSession?.(request.sessionId)
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
        await table.put(revisionOf(key(directory)), next)
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
        const next = { directory: key(directory), moduleIdentity: identity(directory), root: realpathSync(value.root), identity: identity(value.root), read: value.read, write: value.write, revision: revisionOf(randomUUID()), generation: randomUUID() }
        signal.throwIfAborted(); assertActive()
        await table.put(revisionOf(key(directory)), next)
        previews.delete(key(directory))
        return status(directory)
      })
      pending.add(operation)
      void operation.then(() => pending.delete(operation), () => pending.delete(operation))
      return operation
    },
    async dispose() { active = false; previews.clear(); await Promise.allSettled(pending); await domain.close() },
  }
}
