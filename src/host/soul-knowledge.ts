/** 本机知识库授权：只由用户命令确认，模块导出不包含官方持久域。 */
import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { createTargetQueue } from '../shared/target-queue.ts'
import { canonicalDirectory, directoryKey, revisionOf } from './module-write.ts'
import { assertModuleSnapshotSource } from './module-install.ts'

const binding = z.object({ directory: z.string(), moduleIdentity: z.string(), root: z.string(), identity: z.string(), read: z.array(z.string()), write: z.array(z.string()), revision: z.string() }).strict()
const definition = defineDomain({ name: 'prompt_tool_soul_knowledge', version: 1, tables: { bindings: domainTable(binding) } })
type Binding = z.infer<typeof binding>
export interface SoulKnowledgeRequest { moduleId: string; action: 'status' | 'preview' | 'confirm'; root?: string; read?: string[]; write?: string[]; expectedRevision?: string }
export interface SoulKnowledgeOwner {
  status(directory: string): { state: 'unbound' | 'bound' | 'unavailable'; binding?: Binding; reason?: string; entry: string }
  preview(directory: string, request: SoulKnowledgeRequest): Record<string, unknown>
  confirm(directory: string, request: SoulKnowledgeRequest, signal: AbortSignal): Promise<ReturnType<SoulKnowledgeOwner['status']>>
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
export async function openSoulKnowledge(facility: DomainFacility): Promise<SoulKnowledgeOwner> {
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
  return {
    status,
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
        const next = { directory: key(directory), moduleIdentity: identity(directory), root: realpathSync(value.root), identity: identity(value.root), read: value.read, write: value.write, revision: revisionOf(randomUUID()) }
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
