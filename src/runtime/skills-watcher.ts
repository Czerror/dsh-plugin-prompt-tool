/** 技能目录文件 watcher（多目录）：任一目录变化防抖 300ms 后触发 onRefresh；单目录不可 watch 时跳过。
 *  跳过的目录会经 onError 报告一次（该目录的变化将不再自动刷新），恢复后再次挂载。 */
import { existsSync, watch, type FSWatcher } from 'node:fs'

export interface SkillsWatcher {
  watch: () => void
  close: () => void
}

export function createSkillsWatcher(
  dirs: () => string[],
  onRefresh: () => void,
  onError?: (message: string) => void,
): SkillsWatcher {
  let watchers: FSWatcher[] = []
  let timer: NodeJS.Timeout | undefined
  const failed = new Set<string>()
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
        // recursive: true 监听嵌套目录（状态文件与引用技能文件夹的深层变更），
        // 与插件清单扫描的范围一致；不可递归 watch 的平台抛错时跳过该目录。
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
        failed.delete(dir)
      } catch {
        // 单个目录不可 watch 时跳过该目录，不阻断其他目录；但要报告一次，
        // 否则「覆盖不完整」这件事对调用方完全不可见。
        if (!failed.has(dir)) {
          failed.add(dir)
          onError?.(`无法监听技能目录，该目录的变化不会自动刷新：${dir}`)
        }
      }
    }
  }
  return { watch: watchDirs, close }
}

