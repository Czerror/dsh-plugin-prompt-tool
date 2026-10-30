/** soul 账本业务 owner：身份来自宿主，历史只追加。 */
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { ToolExecutionSuccess } from '@deepseek-ai/dsh-tools'
import { ensureDataDirectory, resolveModuleFilePath } from './module-file-path.ts'
import { MAX_DATA_FILE_BYTES, readModuleFile } from './module-files.ts'
import { canonicalDirectory, withModuleLock } from './module-write.ts'

export const SOUL_LEDGER_PATH = 'data/02-soul.jsonl'
export const SOUL_LEDGER_TYPES = ['lead', 'promise', 'fact', 'shelved', 'gain', 'loss', 'persona', 'container'] as const
export interface SoulLedgerInput { type: string; text?: string; '概要'?: string; ref?: string; feel?: string }
export interface SoulLedgerEntry extends Record<string, ToolExecutionSuccess['value']> { t: string; by: string; type: string; '概要': string }
const METADATA_PATH = 'data/.soul-ledger-v2.json'
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
interface Boundary { version: 2; length: number; prefix: string; identity: string }
const ledgerIdentity = (moduleDir: string): string => hash(canonicalDirectory(moduleDir))
export interface SoulLedgerItem { id: string; entry: SoulLedgerEntry; status: 'open' | 'pending-review' }

function boundaryOf(moduleDir: string, content: string): Boundary | undefined {
  const stored = readModuleFile(moduleDir, METADATA_PATH).content
  if (!stored) return undefined
  const value = JSON.parse(stored) as Boundary
  if (value.version !== 2 || typeof value.identity !== 'string' || !/^[a-f0-9]{64}$/.test(value.identity) || !Number.isSafeInteger(value.length) || value.length < 0 || value.length > content.length
    || value.prefix !== hash(content.slice(0, value.length))) throw new Error('账本历史分界不匹配，拒绝使用被替换的来源')
  return value
}

function initializeBoundary(moduleDir: string, content: string): void {
  if (boundaryOf(moduleDir, content)) return
  ensureDataDirectory(moduleDir)
  const file = resolveModuleFilePath(moduleDir, METADATA_PATH, ['data'])
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(temporary, JSON.stringify({ version: 2, identity: ledgerIdentity(moduleDir), length: content.length, prefix: hash(content) }), { flag: 'wx' })
    renameSync(temporary, file)
  } finally { rmSync(temporary, { force: true }) }
}

export function readSoulLedgerProjection(moduleDir: string) {
  const content = readModuleFile(moduleDir, SOUL_LEDGER_PATH).content
  const parsed = rowsOf(content)
  const boundary = boundaryOf(moduleDir, content)
  // 内容链识别改写，逻辑身份随私有数据复制；inode不是持久记录身份。
  let prefix = hash(ledgerIdentity(moduleDir) + ':' + (boundary?.identity ?? ledgerIdentity(moduleDir)))
  let offset = 0
  let index = 0
  const items: SoulLedgerItem[] = []
  const closed = new Set<string>()
  let currentLead: string | undefined
  const entries = content.split('\n').flatMap(line => {
    const position = offset
    offset += line.length + 1
    prefix = hash(prefix + ':' + line)
    if (!line.trim()) return []
    const entry: SoulLedgerEntry & { id: string } = { ...parsed[index++]!, id: prefix }
    if (entry.type === 'lead') currentLead = entry.by
    if (entry.type === 'close') {
      const target = items.find(item => item.id === entry.targetId)
      if (!target || closed.has(target.id) || !['completed', 'cancelled'].includes(String(entry.outcome)) || !entry['概要'].trim()
        || (entry.by !== currentLead && (target.entry.type === 'promise' || target.entry.by !== entry.by))) throw new Error('账本收口事件无效或未获授权')
      closed.add(target.id)
    }
    if (entry.type === 'promise' || entry.type === 'shelved') items.push({ id: prefix, entry, status: !boundary || position < boundary.length ? 'pending-review' : 'open' })
    return [entry]
  })
  const pending = items.filter(item => !closed.has(item.id))
  const open = pending.filter(item => item.status === 'open').length
  return { revision: hash(content), initialized: !!boundary, total: entries.length, entries, items: pending, open, pendingReview: pending.length - open,
    pendingVersion: hash(JSON.stringify(pending.map(item => [item.id, item.status]))), lead: entries.findLast(entry => entry.type === 'lead') }
}

export function closeSoulLedger(moduleDir: string, input: { targetId: string; outcome: string; reason: string; ref?: string }, caller: { sessionId: string | undefined; signal?: AbortSignal }): { entry: SoulLedgerEntry } {
  if (!caller.sessionId?.trim()) throw new Error('账本写入需要真实会话身份')
  if (Object.keys(input).some(key => !['targetId', 'outcome', 'reason', 'ref'].includes(key))) throw new Error('收口包含未知字段')
  if (typeof input.targetId !== 'string' || !/^[a-f0-9]{64}$/.test(input.targetId)) throw new Error('账本引用无效')
  if (!['completed', 'cancelled'].includes(input.outcome)) throw new Error('收口结果必须为 completed 或 cancelled')
  if (typeof input.reason !== 'string' || !input.reason.trim() || Buffer.byteLength(input.reason) > 8192) throw new Error('收口依据必须为非空且不超过 8 KiB')
  if (input.ref !== undefined && (typeof input.ref !== 'string' || Buffer.byteLength(input.ref) > 8192)) throw new Error('收口 ref 超过 8 KiB')
  return withModuleLock(dirname(moduleDir), basename(moduleDir), () => {
    caller.signal?.throwIfAborted()
    const projection = readSoulLedgerProjection(moduleDir)
    const target = projection.entries.find(entry => entry.id === input.targetId)
    if (!target || !['promise', 'shelved'].includes(target.type)) throw new Error('账本引用不存在或不是可收口事项')
    if (projection.lead?.by !== caller.sessionId && (target.type === 'promise' || target.by !== caller.sessionId)) throw new Error('只有当前主导可收口 promise；shelved 允许原作者或当前主导')
    const existing = projection.entries.find(entry => entry.type === 'close' && entry.targetId === input.targetId)
    if (existing) {
      if (existing.outcome !== input.outcome) throw new Error('事项已收口，不能更改结果')
      const { id: _id, ...entry } = existing
      return { entry: entry as SoulLedgerEntry }
    }
    const previous = readModuleFile(moduleDir, SOUL_LEDGER_PATH).content
    const entry: SoulLedgerEntry = { t: new Date().toISOString(), by: caller.sessionId!, type: 'close', '概要': input.reason, targetId: input.targetId, outcome: input.outcome, ...(input.ref === undefined ? {} : { ref: input.ref }) }
    persistEntry(moduleDir, previous, entry, caller.signal)
    return { entry }
  })
}

function persistEntry(moduleDir: string, previous: string, entry: SoulLedgerEntry, signal?: AbortSignal): void {
  const line = (previous.length > 0 && !previous.endsWith('\n') ? '\n' : '') + JSON.stringify(entry) + '\n'
  if (Buffer.byteLength(previous) + Buffer.byteLength(line) > MAX_DATA_FILE_BYTES) throw new Error('账本超过 8 MiB')
  initializeBoundary(moduleDir, previous)
  const file = resolveModuleFilePath(moduleDir, SOUL_LEDGER_PATH, ['data'])
  signal?.throwIfAborted()
  appendFileSync(file, line, 'utf8')
}

function rowsOf(content: string): SoulLedgerEntry[] {
  return content.split('\n').filter(line => line.trim()).map((line, index) => {
    const row: unknown = JSON.parse(line)
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`账本第 ${index + 1} 行不是对象`)
    const value = row as Record<string, unknown>
    const summary = value['概要'] ?? value.text
    if (typeof value.by !== 'string' || typeof value.type !== 'string' || typeof value.t !== 'string' || typeof summary !== 'string') throw new Error(`账本第 ${index + 1} 行缺少有效身份或概要`)
    return { ...value, '概要': summary } as SoulLedgerEntry
  })
}

export function readSoulLedger(moduleDir: string, options: { limit?: number; type?: string; view?: string; cursor?: string } = {}): { entries: SoulLedgerEntry[]; total: number; nextCursor?: string; initialized: boolean; revision: string } {
  const limit = options.limit ?? 30
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('账本读取 limit 必须为 1–100')
  if (options.type !== undefined && ![...SOUL_LEDGER_TYPES, 'close'].includes(options.type)) throw new Error('未知账本类型')
  const view = options.view ?? 'history'
  if (!['history', 'pending', 'open', 'pending-review'].includes(view)) throw new Error('未知账本视图')
  const projection = readSoulLedgerProjection(moduleDir)
  const all = view === 'history' ? projection.entries : projection.items.filter(item => view === 'pending' || item.status === view).map(item => item.entry)
  const rows = options.type === undefined ? all : all.filter(row => row.type === options.type)
  const filter = JSON.stringify([view, options.type ?? null, limit])
  let offset = view === 'history' && options.cursor === undefined ? Math.max(0, rows.length - limit) : 0
  if (options.cursor !== undefined) {
    if (typeof options.cursor !== 'string' || options.cursor.length > 2048) throw new Error('账本游标无效')
    let cursor: { revision: string; filter: string; offset: number }
    try { cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')) } catch { throw new Error('账本游标无效') }
    if (!cursor || Object.keys(cursor).sort().join(',') !== 'filter,offset,revision' || cursor.revision !== projection.revision || cursor.filter !== filter
      || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset >= rows.length) throw new Error('账本游标已失效或不匹配')
    offset = cursor.offset
  }
  const entries = rows.slice(offset, offset + limit)
  if (Buffer.byteLength(JSON.stringify(entries)) > 64 * 1024) throw new Error('账本读取结果超过 64 KiB，请降低 limit')
  const nextCursor = offset + limit < rows.length ? Buffer.from(JSON.stringify({ revision: projection.revision, filter, offset: offset + limit })).toString('base64url') : undefined
  return { entries, total: rows.length, initialized: projection.initialized, revision: projection.revision, ...(nextCursor ? { nextCursor } : {}) }
}

export function appendSoulLedger(moduleDir: string, input: SoulLedgerInput, caller: { sessionId: string | undefined; signal?: AbortSignal }): { entry: SoulLedgerEntry } {
  if (!caller.sessionId?.trim()) throw new Error('账本写入需要真实会话身份')
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['type', 'text', '概要', 'ref', 'feel'].includes(key))) throw new Error('账本写入包含未知字段，作者和时间由宿主提供')
  if (!SOUL_LEDGER_TYPES.includes(input.type as typeof SOUL_LEDGER_TYPES[number])) throw new Error('未知账本类型')
  if ((input.text !== undefined) === (input['概要'] !== undefined)) throw new Error('账本写入需要 text 或 概要 之一')
  const summary = input['概要'] ?? input.text
  if (typeof summary !== 'string' || !summary.trim() || Buffer.byteLength(summary) > 8192) throw new Error('账本概要必须为非空且不超过 8 KiB 的字符串')
  for (const key of ['ref', 'feel'] as const) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || Buffer.byteLength(input[key]) > 8192)) throw new Error(`账本 ${key} 必须为不超过 8 KiB 的字符串`)
  }
  return withModuleLock(dirname(moduleDir), basename(moduleDir), () => {
    caller.signal?.throwIfAborted()
    const previous = readModuleFile(moduleDir, SOUL_LEDGER_PATH).content
    const rows = readSoulLedgerProjection(moduleDir).entries
    if (input.type === 'promise' && rows.findLast(row => row.type === 'lead')?.by !== caller.sessionId) throw new Error('只有最后一条 lead 署名的主导会话可以写 promise')
    const entry: SoulLedgerEntry = { t: new Date().toISOString(), by: caller.sessionId!, type: input.type, '概要': summary,
      ...(input.ref === undefined ? {} : { ref: input.ref }), ...(input.feel === undefined ? {} : { feel: input.feel }) }
    persistEntry(moduleDir, previous, entry, caller.signal)
    return { entry }
  })
}
