/** SELF 派生快照：骨架与事实共享，运行身份只在模型出口加入。 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { assertNoModuleLinks, modulePathExists } from './module-install.ts'
import { ensureDataDirectory, resolveModuleFilePath } from './module-file-path.ts'
import { readModuleFile } from './module-files.ts'
import { readSoulLedger } from './soul-ledger.ts'
import { revisionOf, withModuleLock } from './module-write.ts'

export const SOUL_SELF_SOURCE = 'data/SELF.src.md'
export const SOUL_SELF_SNAPSHOT = 'data/.soul/SELF.md'
export interface SoulIndexStatus { state: string; files?: number; sessions?: number; events?: number }
export interface SoulSelfAgent { session: { id: string; header?: { delegationDepth?: number } } }

function seal(text: string): string {
  return text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[凭据已屏蔽]')
    .split('\n').map(line => /sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+\S+|(?:api[_-]?key|token|secret|password|passwd|pwd|cookie)["']?\s*[:=]/i.test(line) ? '[凭据已屏蔽]' : line).join('\n')
}

export function validateSelfBudget(value: unknown = 12288): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1024 || value > 65536) throw new Error('SELF 预算必须为 1024–65536 字节')
  return value
}

export function readSoulSelfSnapshot(moduleDir: string): { content: string; revision: string | null } {
  const file = join(moduleDir, SOUL_SELF_SNAPSHOT)
  assertNoModuleLinks(file)
  if (!modulePathExists(file)) return { content: '', revision: null }
  const content = readModuleFile(moduleDir, SOUL_SELF_SNAPSHOT).content
  return { content, revision: revisionOf(content) }
}

export function refreshSoulSelf(moduleDir: string, index: SoulIndexStatus, options: { expectedRevision: string | null; signal?: AbortSignal; budgetBytes?: number }) {
  const budget = validateSelfBudget(options.budgetBytes)
  options.signal?.throwIfAborted()
  const source = readModuleFile(moduleDir, SOUL_SELF_SOURCE).content
  if (!source.trim()) throw new Error('SELF 骨架缺失：data/SELF.src.md')
  const ledger = readSoulLedger(moduleDir, { limit: 1 })
  const lead = readSoulLedger(moduleDir, { type: 'lead', limit: 1 }).entries[0]
  const promises = readSoulLedger(moduleDir, { type: 'promise', limit: 3 })
  const shelved = readSoulLedger(moduleDir, { type: 'shelved', limit: 3 })
  const count = (key: 'files' | 'sessions' | 'events'): number => {
    const value = index[key] ?? 0
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('SELF 索引状态无效')
    return value
  }
  const content = seal([source.split('## 活体')[0]!.trim(), '', '## 活体（自动装配）',
    `- 装配时刻：${new Date().toISOString()}`,
    `- 账本：共 ${ledger.total} 条；未结 ${promises.total + shelved.total} 条`,
    ...(lead ? [`- 最后主导记录：${lead['概要']}`] : ['- 主导：尚无 lead 记录']),
    ...[...promises.entries, ...shelved.entries].sort((a, b) => a.t.localeCompare(b.t)).slice(-3).map(row => `- [${row.type}] ${row['概要']}`),
    `- 索引：${index.state}；文件 ${count('files')}；会话 ${count('sessions')}；事件 ${count('events')}`, ''].join('\n'))
  if (Buffer.byteLength(content) > budget - 512) throw new Error('SELF 超预算，需精简骨架或账本内容；旧快照保留')
  return withModuleLock(dirname(moduleDir), basename(moduleDir), () => {
    options.signal?.throwIfAborted()
    if (readSoulSelfSnapshot(moduleDir).revision !== options.expectedRevision) throw new Error('SELF 快照版本冲突')
    if (readModuleFile(moduleDir, SOUL_SELF_SOURCE).content !== source) throw new Error('SELF 骨架版本冲突')
    const data = ensureDataDirectory(moduleDir), stateDir = join(data, '.soul')
    assertNoModuleLinks(stateDir)
    mkdirSync(stateDir, { recursive: true })
    const target = resolveModuleFilePath(moduleDir, SOUL_SELF_SNAPSHOT, ['data'])
    const temp = join(stateDir, '.self-' + randomUUID() + '.tmp')
    try {
      writeFileSync(temp, content, { flag: 'wx', encoding: 'utf8' })
      options.signal?.throwIfAborted()
      if (readSoulSelfSnapshot(moduleDir).revision !== options.expectedRevision) throw new Error('SELF 快照版本冲突')
      renameSync(temp, target)
    } finally { rmSync(temp, { force: true }) }
    return { state: 'ready' as const, revision: revisionOf(content), bytes: Buffer.byteLength(content) }
  })
}

export function renderSoulSelf(moduleDir: string, agent: SoulSelfAgent, signal?: AbortSignal, budgetBytes = 12288): string {
  signal?.throwIfAborted()
  if (!agent?.session?.id) throw new Error('SELF 缺少实际 Agent 身份')
  const snapshot = readSoulSelfSnapshot(moduleDir)
  const prefix = snapshot.revision === null ? '[SELF missing：等待骨架初始化与维护]' : seal(snapshot.content)
  const text = `${prefix}\n## 当前运行身份\n- 本会话：${agent.session.id}\n- 受众：${(agent.session.header?.delegationDepth ?? 0) > 0 ? '子代理' : '主会话'}\n`
  if (Buffer.byteLength(text) > validateSelfBudget(budgetBytes)) throw new Error('SELF 动态上下文超预算')
  return seal(text)
}
