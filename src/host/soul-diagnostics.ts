/** 只读就绪证据；文件齐全、候选渲染与实际投递分别报告。 */
import { runModuleManifest } from './module-manifest.ts'
import { readModuleFile } from './module-files.ts'
import { readSoulLedgerProjection } from './soul-ledger.ts'

export interface SoulObservation { state: string; observedAt?: string; last?: unknown }
export interface SoulDiagnosticObservations {
  index?: SoulObservation
  selfRenderedAt?: string
  selfDeliveredAt?: string
  maintenance?: SoulObservation
  context?: SoulObservation
  recovery?: SoulObservation
}
export interface SoulDiagnosticCheck { name: string; state: string; observedAt?: string; reason?: string; nextAction?: string }

export function readSoulDiagnostics(moduleDir: string, observations: SoulDiagnosticObservations = {}) {
  const observedAt = new Date().toISOString(), checks: SoulDiagnosticCheck[] = []
  const read = (name: string, action: () => Omit<SoulDiagnosticCheck, 'name' | 'observedAt'>): void => {
    try { checks.push({ name, observedAt, ...action() }) }
    catch (error) {
      const message = error instanceof Error ? error.message : ''
      const reason = /链接|越界|非法资源路径/.test(message) ? '来源路径不安全' : /JSON|UTF-8|格式|无效/.test(message) ? '来源格式无效' : /超过|超限/.test(message) ? '来源超过预算' : '来源不可读取'
      checks.push({ name, state: 'failed', observedAt, reason, nextAction: '核对模块声明与来源文件后重新检查' })
    }
  }
  read('manifest', () => {
    const checked = runModuleManifest(moduleDir, 'check'), next = runModuleManifest(moduleDir, 'next')
    if (checked.ok && next.ok) return { state: 'ready' }
    const failed = checked.entries.find(entry => !entry.ok)
    return { state: 'incomplete', reason: failed?.error ? `文件检查：${failed.error}` : '装配文件尚未齐备', nextAction: '通过正式初始化入口预览缺失项' }
  })
  read('skeleton', () => readModuleFile(moduleDir, 'data/SELF.src.md').content.trim() ? { state: 'ready' } : { state: 'missing', nextAction: '初始化或补全SELF骨架' })
  read('ledger', () => {
    const ledger = readSoulLedgerProjection(moduleDir)
    if (!ledger.initialized) return { state: 'pending-initialization', reason: '历史分界尚未初始化', nextAction: '显式初始化或通过正式账本写入口建立历史分界' }
    return ledger.pendingReview ? { state: 'pending-review', reason: `有${ledger.pendingReview}项历史记录待核对`, nextAction: '使用soul_ledger逐项核对收口' } : { state: 'ready' }
  })
  for (const [name, time] of [['self-rendered', observations.selfRenderedAt], ['self-delivered', observations.selfDeliveredAt]] as const) {
    checks.push(time ? { name, state: 'observed', observedAt: time } : { name, state: 'not-observed', nextAction: name === 'self-delivered' ? '等待实际模型投递确认' : '等待下一次真实装配' })
  }
  for (const name of ['index', 'maintenance', 'context', 'recovery'] as const) {
    const observation = observations[name]
    if (!observation) checks.push({ name, state: 'not-observed', nextAction: '核对能力启用并等待运行观测' })
    else if (name !== 'index' && observation.state === 'ready' && observation.last == null && !observation.observedAt) checks.push({ name, state: 'not-observed', reason: '仅已装配，尚无执行证据' })
    else checks.push({ name, state: observation.state, ...(observation.observedAt ? { observedAt: observation.observedAt } : {}), ...(['ready', 'success'].includes(observation.state) ? {} : { nextAction: name === 'index' ? '显式刷新授权索引或检查刷新失败' : '核对能力状态与最近执行证据' }) })
  }
  return { state: checks.every(check => ['ready', 'observed', 'success'].includes(check.state)) ? 'ready' as const : 'attention' as const, observedAt, checks }
}
