/** 技能目录文件 watcher（多目录）：任一目录变化防抖 300ms 后触发 onRefresh；单目录不可 watch 时跳过。 */
import { existsSync, watch, type FSWatcher } from 'node:fs'

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
        // recursive: true 监听嵌套技能目录（skills/<skill>/SKILL.md 等深层变更），
        // 与 skills-provider 的扫描结果一致；不可递归 watch 的平台抛错时跳过该目录。
        const watcher = watch(dir, { persistent: false, recursive: true }, () => {
          // 目录被删除/改名后 Windows 会持续上报事件（实测每秒十万级）：句柄已无
          // 意义，继续防抖只会空转 CPU 并让刷新计时器永久存活，直接关闭该目录。
          if (!existsSync(dir)) {
            watcher.close()
            return
          }
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

