/** 状态读取失败保留最后有效配置；删除则重置。技能根变化由官方 watcher 处理。 */
import { existsSync } from 'node:fs'
import { readSkillsState } from './skills-config.ts'
import type { SkillsState } from '../shared/skills.ts'

export interface SkillsReloaderDeps {
  stateFile: string
  currentSnapshot: () => string
  accept: (state: SkillsState, snapshot: string) => void
  warn: (message: string) => void
}

export function createSkillsReloader(deps: SkillsReloaderDeps): { reload: () => void } {
  let readFailed = false
  let fileMissing = !existsSync(deps.stateFile)
  return {
    reload: () => {
      const read = readSkillsState(deps.stateFile)
      if (!read.ok) {
        if (!readFailed) deps.warn(`${read.message}（保留上一次有效状态，修好后自动恢复）`)
        readFailed = true
        return
      }
      readFailed = false
      if (!read.exists && !fileMissing) deps.warn('技能状态文件不存在，已按空状态处理（引用目录已重置）')
      fileMissing = !read.exists
      const snapshot = JSON.stringify(read.state)
      if (snapshot !== deps.currentSnapshot()) deps.accept(read.state, snapshot)
    },
  }
}
