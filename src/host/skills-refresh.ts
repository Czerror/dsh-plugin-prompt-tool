/** 技能状态刷新装配：读状态文件 → 比较快照与候选指纹 → 重挂 watcher → 按需失效缓存。
 *
 *  为什么单独成模块：这里有四条必须显式锁住的规则。
 *
 *  1. **读盘失败不能回落默认状态**。`readSkillsState` 失败时仍会返回一个默认状态，直接 accept
 *     会让瞬时坏文件（手工编辑到一半、写入被中断）把内存里的状态与引用目录一起清空。
 *     失败时保留上一份有效状态，只告警一次。
 *  2. **候选来源的内容变化也要失效候选缓存**。状态快照只来自 `skills.yml`，而用户引用的技能
 *     文件夹里新增 / 删除 / 改写技能都不改变快照；官方 `SkillRegistry` 按 revision 缓存合并结果，
 *     不主动失效就永远看不到新技能（界面有、模型没有）。所以候选指纹变化与状态变化同等对待。
 *  3. **任何文件系统事件都要失效清单缓存**，否则引用目录里的增删改不会反映到清单。
 *  4. **状态文件消失不算读失败**（`exists:false`），按用户重置处理，但必须留下一条告警，
 *     不让「设置悄悄消失」。
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
  /** 文件事件已证明来源可能变化，直接失效候选缓存。 */
  invalidateCandidates: () => void
  /** 报告异常；同一故障窗口只会调用一次。 */
  warn: (message: string) => void
}

export interface SkillsReloader {
  /** watcher 回调：任何文件系统事件都走这里。 */
  reload: () => void
}

export function createSkillsReloader(deps: SkillsReloaderDeps): SkillsReloader {
  let readFailed = false
  let fileMissing = false
  return {
    reload: () => {
      const read = readSkillsState(deps.stateFile)
      let stateChanged = false
      if (read.ok === false) {
        if (!readFailed) {
          readFailed = true
          deps.warn(`${read.message}（保留上一次有效状态，修好后自动恢复）`)
        }
      } else {
        readFailed = false
        if (read.exists === false) {
          if (!fileMissing) {
            fileMissing = true
            deps.warn('技能状态文件不存在，已按空状态处理（引用目录已重置）')
          }
        } else {
          fileMissing = false
        }
        const snapshot = JSON.stringify(read.state)
        stateChanged = snapshot !== deps.currentSnapshot()
        if (stateChanged) {
          deps.accept(read.state, snapshot)
          deps.rewatch()
        }
      }
      // 事件本身即失效依据；同一时间戳粒度内的等长改写也不能复用旧候选。
      deps.invalidateList()
      deps.invalidateCandidates()
    },
  }
}
