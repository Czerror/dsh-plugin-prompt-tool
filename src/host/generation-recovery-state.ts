/** 会话恢复额度的唯一持久owner，重挂不重置，先扣额再允许唤醒。 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { storageRoot } from './paths.ts'
import { assertNoModuleLinks } from './module-install.ts'
import { withModuleLock } from './module-write.ts'

interface RecoveryRecord { sessionId: string; used: number; executions: string[] }

export function createGenerationRecoveryState(root = join(storageRoot(), 'generation-recovery')) {
  const keyOf = (sessionId: string): string => {
    if (typeof sessionId !== 'string' || !sessionId.length || sessionId.length > 1024) throw new Error('恢复会话身份无效')
    return createHash('sha256').update(sessionId).digest('hex')
  }
  const read = (sessionId: string): RecoveryRecord => {
    const file = join(root, keyOf(sessionId) + '.json')
    assertNoModuleLinks(file)
    if (!existsSync(file)) return { sessionId, used: 0, executions: [] }
    if (!statSync(file).isFile() || statSync(file).size > 128 * 1024) throw new Error('恢复额度文件无效或超限')
    const data = JSON.parse(readFileSync(file, 'utf8')) as RecoveryRecord
    if (data.sessionId !== sessionId || !Number.isSafeInteger(data.used) || data.used < 0 || data.used > 1000
      || !Array.isArray(data.executions) || data.executions.length !== data.used
      || data.executions.some(value => typeof value !== 'string' || !/^\d+:\d+$/.test(value))
      || new Set(data.executions).size !== data.used) throw new Error('恢复额度文件损坏，拒绝重置')
    return data
  }
  return {
    read,
    claim(sessionId: string, execution: string, limit: number) {
      if (!/^\d+:\d+$/.test(execution) || !Number.isSafeInteger(limit) || limit < 0 || limit > 1000) throw new Error('恢复执行身份或额度无效')
      const key = keyOf(sessionId)
      assertNoModuleLinks(root)
      mkdirSync(root, { recursive: true })
      return withModuleLock(root, key, () => {
        const state = read(sessionId)
        if (state.executions.includes(execution) || state.used >= limit) return { claimed: false, used: state.used, limit }
        const file = join(root, key + '.json'), temporary = join(root, '.' + randomUUID() + '.tmp')
        try {
          writeFileSync(temporary, JSON.stringify({ sessionId, used: state.used + 1, executions: [...state.executions, execution] }), { flag: 'wx' })
          assertNoModuleLinks(file)
          renameSync(temporary, file)
        } finally { rmSync(temporary, { force: true }) }
        return { claimed: true, used: state.used + 1, limit }
      })
    },
  }
}
