/** 只跟踪插件状态文件；watchFile 同时覆盖初始缺失、原子替换和删除后恢复。 */
import { unwatchFile, watchFile } from 'node:fs'

export interface SkillsWatcher {
  close: () => void
}

export function createSkillsWatcher(file: string, onRefresh: () => void): SkillsWatcher {
  let closed = false
  const listener = (): void => { if (!closed) onRefresh() }
  watchFile(file, { persistent: false, interval: 200 }, listener)
  return {
    close: () => {
      closed = true
      unwatchFile(file, listener)
    },
  }
}
