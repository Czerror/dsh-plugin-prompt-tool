/** 技能目录文件 watcher（多目录）：任一目录变化防抖 300ms 后触发 onRefresh；单目录不可 watch 时跳过。 */
import { watch, type FSWatcher } from 'node:fs'

export interface SkillsWatcher {
  watch: () => void
  close: () => void
}

export function createSkillsWatcher(dirs: () => string[], onRefresh: () => void): SkillsWatcher {
  let watchers: FSWatcher[] = []
  let timer: NodeJS.Timeout | undefined
  const close = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    for (const watcher of watchers) watcher.close()
    watchers = []
  }
  const watchDirs = (): void => {
    close()
    for (const dir of dirs()) {
      try {
        const watcher = watch(dir, { persistent: false }, () => {
          if (timer !== undefined) clearTimeout(timer)
          timer = setTimeout(() => {
            timer = undefined
            onRefresh()
          }, 300)
        })
        watchers.push(watcher)
      } catch {
        // 单个目录不可 watch 时跳过该目录，不阻断其他目录。
      }
    }
  }
  return { watch: watchDirs, close }
}
