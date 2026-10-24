/** 通用 manifest 驱动的模块数据装配：清单在 assets/manifest.yml，只写 data/。 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseDocument } from 'yaml'
import { ensureDataDirectory, moduleFilePath, resolveModuleFilePath } from './module-file-path.ts'
import { assertNoModuleLinks, modulePathExists } from './module-install.ts'

const MANIFEST_PATH = 'assets/manifest.yml'
const DEFAULT_MAX_BYTES = 1024 * 1024
const KINDS = new Set(['file', 'text', 'json', 'jsonl'])

export type ManifestAction = 'next' | 'check' | 'apply'

interface ManifestFile { from: string; to: string }
interface ManifestCheck { path: string; kind: string; maxBytes: number }
interface Manifest { dirs: string[]; files: ManifestFile[]; checks: ManifestCheck[] }

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

function stringList(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => !nonempty(item))) throw new Error(`assets/manifest.yml ${label} 必须是字符串数组`)
  return value as string[]
}

function parseManifest(moduleDir: string): Manifest {
  const file = resolveModuleFilePath(moduleDir, MANIFEST_PATH, ['assets'])
  if (!modulePathExists(file)) throw new Error('模块缺少 assets/manifest.yml')
  const doc = parseDocument(readFileSync(file, 'utf8'), { logLevel: 'silent' })
  if (doc.errors.length > 0) throw new Error('assets/manifest.yml 不是有效 YAML')
  const source: unknown = doc.toJS() ?? {}
  if (!record(source)) throw new Error('assets/manifest.yml 必须是对象')
  for (const key of Object.keys(source)) {
    if (!['dirs', 'files', 'checks'].includes(key)) throw new Error(`assets/manifest.yml 未知字段：${key}`)
  }
  const dirs = stringList(source.dirs, 'dirs').map((path) => { moduleFilePath(moduleDir, path, ['data']); return path })
  if (source.files !== undefined && !Array.isArray(source.files)) throw new Error('assets/manifest.yml files 必须是数组')
  const files = (source.files ?? []).map((item, index) => {
    if (!record(item)) throw new Error(`assets/manifest.yml files[${index}] 必须是对象`)
    for (const key of Object.keys(item)) {
      if (!['from', 'to'].includes(key)) throw new Error(`assets/manifest.yml files[${index}] 未知字段：${key}`)
    }
    if (!nonempty(item.from) || !nonempty(item.to)) throw new Error(`assets/manifest.yml files[${index}] 需要 from 与 to`)
    resolveModuleFilePath(moduleDir, item.from, ['assets'])
    moduleFilePath(moduleDir, item.to, ['data'])
    return { from: item.from, to: item.to }
  })
  if (source.checks !== undefined && !Array.isArray(source.checks)) throw new Error('assets/manifest.yml checks 必须是数组')
  const checks = (source.checks ?? []).map((item, index) => {
    if (!record(item)) throw new Error(`assets/manifest.yml checks[${index}] 必须是对象`)
    for (const key of Object.keys(item)) {
      if (!['path', 'kind', 'maxBytes'].includes(key)) throw new Error(`assets/manifest.yml checks[${index}] 未知字段：${key}`)
    }
    if (!nonempty(item.path)) throw new Error(`assets/manifest.yml checks[${index}] 需要 path`)
    if (typeof item.kind !== 'string' || !KINDS.has(item.kind)) {
      throw new Error(`assets/manifest.yml checks[${index}] kind 必须是 ${[...KINDS].join('、')}`)
    }
    const maxBytes = item.maxBytes ?? DEFAULT_MAX_BYTES
    if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error(`assets/manifest.yml checks[${index}] maxBytes 必须是正整数`)
    }
    moduleFilePath(moduleDir, item.path, ['data'])
    return { path: item.path, kind: item.kind, maxBytes }
  })
  return { dirs, files, checks }
}

interface CheckResult { path: string; kind: string; ok: boolean; error?: string }

function checkEntry(moduleDir: string, entry: ManifestCheck): CheckResult {
  const fail = (error: string): CheckResult => ({ path: entry.path, kind: entry.kind, ok: false, error })
  const { file } = moduleFilePath(moduleDir, entry.path, ['data'])
  if (!modulePathExists(file)) return fail('文件不存在')
  const resolved = resolveModuleFilePath(moduleDir, entry.path, ['data'])
  const stat = statSync(resolved)
  if (!stat.isFile()) return fail('不是普通文件')
  if (stat.size > entry.maxBytes) return fail(`超过 ${entry.maxBytes} 字节`)
  const bytes = readFileSync(resolved)
  if (entry.kind === 'file') return { path: entry.path, kind: entry.kind, ok: true }
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return fail('不是 UTF-8 文本') }
  if (entry.kind === 'text') return { path: entry.path, kind: entry.kind, ok: true }
  if (entry.kind === 'json') {
    try { JSON.parse(text) } catch { return fail('不是 JSON') }
    return { path: entry.path, kind: entry.kind, ok: true }
  }
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim().length === 0) continue
    try { JSON.parse(line) } catch { return fail(`第 ${index + 1} 行不是 JSON`) }
  }
  return { path: entry.path, kind: entry.kind, ok: true }
}

function nextEntry(moduleDir: string, manifest: Manifest): { kind: string; path: string } | null {
  for (const path of manifest.dirs) {
    const { file } = moduleFilePath(moduleDir, path, ['data'])
    const stat = statSync(file, { throwIfNoEntry: false })
    if (stat === undefined || !stat.isDirectory()) return { kind: 'dir', path }
  }
  for (const entry of manifest.files) {
    const { file } = moduleFilePath(moduleDir, entry.to, ['data'])
    const stat = statSync(file, { throwIfNoEntry: false })
    if (stat === undefined || !stat.isFile()) return { kind: 'file', path: entry.to }
  }
  for (const entry of manifest.checks) {
    if (!checkEntry(moduleDir, entry).ok) return { kind: 'check', path: entry.path }
  }
  return null
}

/** 只建 data/ 下声明过的目录；逐级检查链接，拒绝顺着链接落盘。 */
function ensureDirectory(moduleDir: string, path: string): void {
  const { path: dataRelative } = moduleFilePath(moduleDir, path, ['data'])
  let current = ensureDataDirectory(moduleDir)
  for (const part of dataRelative.split('/').slice(1)) {
    current = join(current, part)
    assertNoModuleLinks(current)
    if (!modulePathExists(current)) mkdirSync(current)
  }
}

export interface ManifestEntry {
  kind: string
  path: string
  ok?: boolean
  error?: string
  skipped?: boolean
}

export interface ManifestResult {
  action: ManifestAction
  ok: boolean
  entries: ManifestEntry[]
}

/**
 * next：按 dirs → files → checks 顺序返回第一条缺失（ok=是否已完成）；
 * check：返回全部检查结果（ok=是否全部通过）；apply：建目录 + 只落缺失文件（ok=执行完成）。
 * shortcut: 装配无锁且逐文件写入，并发调用可能留下部分结果；等需要回滚或并发保证时升级成事务。
 */
export function runModuleManifest(moduleDir: string, action: ManifestAction): ManifestResult {
  const manifest = parseManifest(moduleDir)
  if (action === 'next') {
    const entry = nextEntry(moduleDir, manifest)
    return { action, ok: entry === null, entries: entry === null ? [] : [{ kind: entry.kind, path: entry.path }] }
  }
  if (action === 'check') {
    const entries = manifest.checks.map(entry => checkEntry(moduleDir, entry))
    return { action, ok: entries.every(entry => entry.ok), entries }
  }
  const entries: ManifestEntry[] = []
  for (const path of manifest.dirs) {
    const { file } = moduleFilePath(moduleDir, path, ['data'])
    if (modulePathExists(file)) {
      // 已存在的目录也要过链接与真实路径检查：跳过不等于放行。
      if (!statSync(resolveModuleFilePath(moduleDir, path, ['data'])).isDirectory()) {
        throw new Error(`清单目录不是普通目录：${path}`)
      }
      entries.push({ kind: 'dir', path, skipped: true })
      continue
    }
    ensureDirectory(moduleDir, path)
    entries.push({ kind: 'dir', path, skipped: false })
  }
  for (const entry of manifest.files) {
    const { file: target } = moduleFilePath(moduleDir, entry.to, ['data'])
    if (modulePathExists(target)) {
      resolveModuleFilePath(moduleDir, entry.to, ['data'])
      entries.push({ kind: 'file', path: entry.to, skipped: true })
      continue
    }
    const source = resolveModuleFilePath(moduleDir, entry.from, ['assets'])
    const stat = statSync(source)
    if (!stat.isFile()) throw new Error(`清单来源不是普通文件：${entry.from}`)
    if (stat.size > DEFAULT_MAX_BYTES) throw new Error(`清单来源超过 1 MiB：${entry.from}`)
    ensureDirectory(moduleDir, dirname(entry.to))
    const resolved = resolveModuleFilePath(moduleDir, entry.to, ['data'])
    // wx：即使检查与写入之间出现同名文件也不覆盖。
    writeFileSync(resolved, readFileSync(source), { flag: 'wx' })
    entries.push({ kind: 'file', path: entry.to, skipped: false })
  }
  return { action, ok: true, entries }
}
