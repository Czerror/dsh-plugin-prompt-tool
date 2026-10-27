/** soul 账本业务 owner：身份来自宿主，历史只追加。 */
import { appendFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { ToolExecutionSuccess } from '@deepseek-ai/dsh-tools'
import { ensureDataDirectory, resolveModuleFilePath } from './module-file-path.ts'
import { MAX_DATA_FILE_BYTES, readModuleFile } from './module-files.ts'
import { withModuleLock } from './module-write.ts'

export const SOUL_LEDGER_PATH = 'data/02-soul.jsonl'
export const SOUL_LEDGER_TYPES = ['lead', 'promise', 'fact', 'shelved', 'gain', 'loss', 'persona', 'container'] as const
export interface SoulLedgerInput { type: string; text?: string; '概要'?: string; ref?: string; feel?: string }
export interface SoulLedgerEntry extends Record<string, ToolExecutionSuccess['value']> { t: string; by: string; type: string; '概要': string }

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

export function readSoulLedger(moduleDir: string, options: { limit?: number; type?: string } = {}): { entries: SoulLedgerEntry[]; total: number } {
  const limit = options.limit ?? 30
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('账本读取 limit 必须为 1–100')
  if (options.type !== undefined && !SOUL_LEDGER_TYPES.includes(options.type as typeof SOUL_LEDGER_TYPES[number])) throw new Error('未知账本类型')
  const all = rowsOf(readModuleFile(moduleDir, SOUL_LEDGER_PATH).content)
  const rows = options.type === undefined ? all : all.filter(row => row.type === options.type)
  const entries = rows.slice(-limit)
  if (Buffer.byteLength(JSON.stringify(entries)) > 64 * 1024) throw new Error('账本读取结果超过 64 KiB，请降低 limit')
  return { entries, total: rows.length }
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
    const rows = rowsOf(previous)
    if (input.type === 'promise' && rows.findLast(row => row.type === 'lead')?.by !== caller.sessionId) throw new Error('只有最后一条 lead 署名的主导会话可以写 promise')
    const entry: SoulLedgerEntry = { t: new Date().toISOString(), by: caller.sessionId!, type: input.type, '概要': summary,
      ...(input.ref === undefined ? {} : { ref: input.ref }), ...(input.feel === undefined ? {} : { feel: input.feel }) }
    const line = (previous.length > 0 && !previous.endsWith('\n') ? '\n' : '') + JSON.stringify(entry) + '\n'
    if (Buffer.byteLength(previous) + Buffer.byteLength(line) > MAX_DATA_FILE_BYTES) throw new Error('账本超过 8 MiB')
    ensureDataDirectory(moduleDir)
    const file = resolveModuleFilePath(moduleDir, SOUL_LEDGER_PATH, ['data'])
    caller.signal?.throwIfAborted()
    appendFileSync(file, line, 'utf8')
    return { entry }
  })
}
