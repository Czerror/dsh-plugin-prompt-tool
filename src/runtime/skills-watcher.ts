/** 技能目录文件 watcher：目录变化防抖 300ms 后触发 onRefresh；目录不可 watch 时静默降级。 */
import { watch, type FSWatcher } from 'node:fs'

export interface SkillsWatcher {
  watch: () => void
  close: () => void
}

export function createSkillsWatcher(dir: () => string, onRefresh: () => void): SkillsWatcher {
  let skillsWatcher: FSWatcher | undefined
  let timer: NodeJS.Timeout | undefined
  const close = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    skillsWatcher?.close()
    skillsWatcher = undefined
  }
  const watchDir = (): void => {
    close()
    try {
      skillsWatcher = watch(dir(), { persistent: false }, () => {
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = undefined
          onRefresh()
        }, 300)
      })
    } catch {
      // 目录不可 watch 时降级为目录切换时重扫，不阻断启动。
    }
  }
  return { watch: watchDir, close }
}
