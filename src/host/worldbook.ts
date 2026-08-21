/** 世界书 host 层：preset.yml 顶层 worldBook 段（injectMode + entries）的读写与 CRUD。
 *  模型工具（world-book-tools）与 UI 端点（settings-bridge）共用同一实现。 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'

export interface WorldBookEntry {
  id: string
  name: string
  text: string
  keys?: string[]
  secondaryKeys?: string[]
  constant?: boolean
  enabled?: boolean
  order?: number
  [key: string]: unknown
}

export interface WorldBook {
  injectMode: 'full' | 'keyword'
  entries: WorldBookEntry[]
}

export function readWorldBook(dir: string): WorldBook {
  const file = join(dir, 'preset.yml')
  const doc = parseDocument(readFileSync(file, 'utf8'), { logLevel: 'silent' })
  const current = doc.toJS() as { worldBook?: { injectMode?: string; entries?: unknown[] } }
  return {
    injectMode: current.worldBook?.injectMode === 'full' ? 'full' : 'keyword',
    entries: Array.isArray(current.worldBook?.entries)
      ? current.worldBook.entries as WorldBookEntry[] : [],
  }
}

export function writeWorldBook(dir: string, book: WorldBook): void {
  const file = join(dir, 'preset.yml')
  const doc = parseDocument(readFileSync(file, 'utf8'), { logLevel: 'silent' })
  if (book.entries.length > 0) {
    doc.setIn(['worldBook', 'injectMode'], book.injectMode)
    doc.setIn(['worldBook', 'entries'], book.entries)
  } else {
    doc.deleteIn(['worldBook'])
  }
  writeFileSync(file, doc.toString(), 'utf8')
}

export function upsertWorldBookEntry(dir: string, entry: WorldBookEntry, mode?: 'full' | 'keyword'): { id: string; count: number; mode: 'full' | 'keyword' } {
  const book = readWorldBook(dir)
  const targetId = entry.id.length > 0 ? entry.id : `lore-${Date.now().toString(36)}`
  const existing = book.entries.findIndex((item) => item.id === targetId)
  const next = { ...entry, id: targetId }
  if (existing >= 0) book.entries[existing] = next
  else book.entries.push(next)
  if (mode === 'full' || mode === 'keyword') book.injectMode = mode
  writeWorldBook(dir, book)
  return { id: targetId, count: book.entries.length, mode: book.injectMode }
}

export function deleteWorldBookEntry(dir: string, id: string): { count: number } {
  const book = readWorldBook(dir)
  const kept = book.entries.filter((entry) => entry.id !== id)
  if (kept.length === book.entries.length) throw new Error(`世界书条目 ${id} 不存在`)
  book.entries = kept
  writeWorldBook(dir, book)
  return { count: book.entries.length }
}
