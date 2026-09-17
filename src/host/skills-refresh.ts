/** 技能状态刷新装配：读状态文件 → 比较快照 → 重挂 watcher → 失效缓存。
 *
 *  为什么单独成模块：这里有两条必须显式锁住的规则。
 *
 *  1. **读盘失败不能回落默认状态**。`readSkillsState` 失败时仍会返回一个默认状态，直接 accept
 *     会让瞬时坏文件（手工编辑到一半、写入被中断）把内存里的屏蔽表与引用目录一起清空，
 *     用户看到的是「设置全没了」。失败时保留上一份有效状态，只告警一次。
 *  2. **任何文件系统事件都要失效清单缓存**。watcher 同时监听状态文件与用户引用的技能目录，
 *     只有前者会改变状态快照；若按「快照没变就直接返回」短路，引用目录里新增或删除的技能
 *     会永远留在缓存里。
 *
 *  依赖在这里显式传入，便于用真实状态文件与真实 watcher 做行为回归。 */
import { readSkillsState } from './skills-config.ts'
import type { SkillsState } from '../shared/skills.ts'

export interface SkillsReloaderDeps {
  /** 技能状态文件绝对路径。 */
  stateFile: string
  /** 当前内存里的状态快照。 */
  currentSnapshot: () => string
  /** 接受新状态与其快照。 */
  accept: (state: SkillsState, snapshot: string) => void
  /** 引用目录集合可能变化时重挂 watcher。 */
  rewatch: () => void
  /** 失效清单缓存；任何文件系统事件都要调用。 */
  invalidateList: () => void
  /** 屏蔽表或引用集合变化时额外失效候选缓存；只有状态确实变化时才调用。 */
  invalidateCandidates: () => void
  /** 报告读取失败；同一故障窗口只会调用一次。 */
  warn: (message: string) => void
}

export interface SkillsReloader {
  /** watcher 回调：任何文件系统事件都走这里。 */
  reload: () => void
  /** 当前是否处于「读失败、沿用上一次有效状态」的降级状态。 */
  degraded: () => boolean
}

export function createSkillsReloader(deps: SkillsReloaderDeps): SkillsReloader {
  let degraded = false
  return {
    reload: () => {
      const read = readSkillsState(deps.stateFile)
      if (read.ok === false) {
        if (!degraded) {
          degraded = true
          deps.warn(`${read.message}（保留上一次有效状态，修好后自动恢复）`)
        }
        // 读失败也说明文件系统动过：清单缓存必须失效，否则引用目录里的新技能永远不出现。
        deps.invalidateList()
        return
      }
      degraded = false
      const snapshot = JSON.stringify(read.state)
      if (snapshot !== deps.currentSnapshot()) {
        deps.accept(read.state, snapshot)
        deps.rewatch()
        deps.invalidateList()
        deps.invalidateCandidates()
        return
      }
      // 状态没变（例如只是引用目录里的普通文件变了）：候选集合不变，只需失效清单缓存，
      // 不让官方 skill 提供者跟着做一次全量重扫。
      deps.invalidateList()
    },
    degraded: () => degraded,
  }
}
