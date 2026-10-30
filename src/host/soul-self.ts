/** SELF 派生快照：骨架与事实共享，运行身份只在模型出口加入。 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { assertNoModuleLinks, modulePathExists } from './module-install.ts'
import { ensureDataDirectory, resolveModuleFilePath } from './module-file-path.ts'
import { readModuleFile } from './module-files.ts'
import { readSoulLedgerProjection } from './soul-ledger.ts'
import { revisionOf, withModuleLock } from './module-write.ts'

export const SOUL_SELF_SOURCE = 'data/SELF.src.md'
export const SOUL_SELF_SNAPSHOT = 'data/.soul/SELF.md'
export interface SoulIndexStatus { state: string; files?: number; sessions?: number; events?: number; observedAt?: string; error?: string }
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

function selfInputs(moduleDir: string) {
  const source = readModuleFile(moduleDir, SOUL_SELF_SOURCE).content
  const ledger = readSoulLedgerProjection(moduleDir)
  return { source, ledger, version: revisionOf(source) + ':' + ledger.revision + ':' + ledger.pendingVersion + ':' + ledger.initialized }
}

export function deriveSoulSelf(moduleDir: string, index: SoulIndexStatus = { state: 'unbuilt（未建）' }, budgetBytes = 12288) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const input = selfInputs(moduleDir)
    const candidate = renderSelfFacts(input, index, budgetBytes)
    if (selfInputs(moduleDir).version === input.version) return candidate
  }
  throw new Error('SELF 来源持续变化，无法形成一致候选')
}

function renderSelfFacts({ source, ledger }: ReturnType<typeof selfInputs>, index: SoulIndexStatus, budgetBytes: number) {
  const budget = validateSelfBudget(budgetBytes)
  if (!source.trim()) throw new Error('SELF 骨架缺失：data/SELF.src.md')
  const count = (key: 'files' | 'sessions' | 'events'): number => {
    const value = index[key] ?? 0
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('SELF 索引状态无效')
    return value
  }
  const now = new Date().toISOString()
  const lines = [seal(source), '', '## 活体（当前权威事实）',
    `- 当前时钟：${now}；时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    `- 账本：共 ${ledger.total} 条；未结 ${ledger.open} 条；历史待核对 ${ledger.pendingReview} 条${ledger.initialized ? '' : '；历史分界待初始化'}`,
    `- 主导：${ledger.lead ? seal(ledger.lead['概要']).slice(0, 160) : '尚无 lead 记录'}`,
    `- 索引：${index.state}${index.files === undefined ? '' : `；文件 ${count('files')}；会话 ${count('sessions')}；事件 ${count('events')}`}`,
    `- 索引最近成功观测：${index.observedAt ?? '尚未观测'}；未扫描外部变化时不保证当前一致。`]
  const remaining = (shown: number) => `- 未展示事项：${ledger.items.length - shown}；用 soul_ledger list 的需处理视图分页读取。`
  const reserve = 224
  if (Buffer.byteLength([...lines, remaining(0)].join('\n')) > budget - reserve) throw new Error('SELF 超预算，需精简骨架；旧快照保留')
  let shown = 0
  for (const item of ledger.items.slice(0, 3)) {
    const summary = seal(item.entry['概要'])
    const line = `- [${item.status}] ${item.id}：${summary.slice(0, 240)}${summary.length > 240 ? '…（摘要）' : ''}`
    if (Buffer.byteLength([...lines, line, remaining(shown + 1)].join('\n')) > budget - reserve) break
    lines.push(line); shown += 1
  }
  lines.push(remaining(shown))
  return { content: lines.join('\n') + '\n', sourceRevision: revisionOf(source), ledgerRevision: ledger.revision, pendingVersion: ledger.pendingVersion, observedAt: now }
}

export function refreshSoulSelf(moduleDir: string, index: SoulIndexStatus, options: { expectedRevision: string | null; signal?: AbortSignal; budgetBytes?: number }) {
  options.signal?.throwIfAborted()
  const candidate = deriveSoulSelf(moduleDir, index, options.budgetBytes)
  const content = candidate.content.replace('## 活体（当前权威事实）', `## 诊断快照（非实时）\n- 快照时刻：${candidate.observedAt}`)
  return withModuleLock(dirname(moduleDir), basename(moduleDir), () => {
    options.signal?.throwIfAborted()
    if (readSoulSelfSnapshot(moduleDir).revision !== options.expectedRevision) throw new Error('SELF 快照版本冲突')
    const assertCurrent = () => {
      const current = selfInputs(moduleDir)
      if (revisionOf(current.source) !== candidate.sourceRevision || current.ledger.revision !== candidate.ledgerRevision
        || current.ledger.pendingVersion !== candidate.pendingVersion) throw new Error('SELF 来源版本冲突')
    }
    assertCurrent()
    const data = ensureDataDirectory(moduleDir), stateDir = join(data, '.soul')
    assertNoModuleLinks(stateDir)
    mkdirSync(stateDir, { recursive: true })
    const target = resolveModuleFilePath(moduleDir, SOUL_SELF_SNAPSHOT, ['data'])
    const temp = join(stateDir, '.self-' + randomUUID() + '.tmp')
    try {
      writeFileSync(temp, content, { flag: 'wx', encoding: 'utf8' })
      options.signal?.throwIfAborted()
      if (readSoulSelfSnapshot(moduleDir).revision !== options.expectedRevision) throw new Error('SELF 快照版本冲突')
      assertCurrent()
      renameSync(temp, target)
    } finally { rmSync(temp, { force: true }) }
    return { state: 'ready' as const, revision: revisionOf(content), bytes: Buffer.byteLength(content) }
  })
}

export function renderSoulSelf(moduleDir: string, agent: SoulSelfAgent, signal?: AbortSignal, budgetBytes = 12288, index?: SoulIndexStatus, runtimeLines: readonly string[] = []): string {
  signal?.throwIfAborted()
  if (!agent?.session?.id) throw new Error('SELF 缺少实际 Agent 身份')
  for (const path of [SOUL_SELF_SOURCE, 'data/02-soul.jsonl', 'data/02-墨.jsonl']) assertNoModuleLinks(join(moduleDir, path))
  let prefix: string
  try { prefix = deriveSoulSelf(moduleDir, index, budgetBytes).content }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM' || /链接|越界|超预算|不是普通文件/.test(String((error as Error).message))) throw error
    const reason = /持续变化/.test(String((error as Error).message)) ? '来源持续变化，无法形成一致候选' : '账本或骨架数据不可读取'
    const snapshot = readSoulSelfSnapshot(moduleDir)
    const stamp = /^- (?:快照时刻|装配时刻)：([^\n]+)/m.exec(snapshot.content)?.[1]
    const sourceTime = stamp && Number.isFinite(Date.parse(stamp)) ? stamp : 'unknown'
    prefix = snapshot.revision === null ? `[SELF unavailable：${reason}；无安全诊断快照；未结数量未知]`
      : `[SELF degraded：来源时间：${sourceTime}；原因：${reason}；以下仅为历史诊断，当前未结未知]\n${seal(snapshot.content).replaceAll('当前权威事实', '历史诊断事实').replaceAll('当前时钟', '快照时钟')}`
  }
  let text = seal(`${prefix}\n## 当前运行身份\n- 当前时钟：${new Date().toISOString()}\n- 本会话：${agent.session.id}\n- 受众：${(agent.session.header?.delegationDepth ?? 0) > 0 ? '子代理' : '主会话'}\n`)
  if (Buffer.byteLength(text) > validateSelfBudget(budgetBytes)) throw new Error('SELF 动态上下文超预算')
  for (const line of runtimeLines) {
    const available = budgetBytes - Buffer.byteLength(text) - 1
    const sealed = seal(line)
    if (Buffer.byteLength(sealed) <= available) { text += sealed + '\n'; continue }
    const suffix = '…（状态摘要）'
    let summary = ''
    for (const char of sealed) {
      if (Buffer.byteLength(summary + char + suffix) > available) break
      summary += char
    }
    if (summary) text += summary + suffix + '\n'
    break
  }
  return text
}
