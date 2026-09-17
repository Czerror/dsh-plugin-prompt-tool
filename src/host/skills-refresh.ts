/** 技能状态与清单缓存的刷新策略。
 *
 *  为什么单独成模块：这里有一条容易被写错的规则——**文件系统事件必须无条件失效清单缓存**。
 *  watcher 同时监听状态文件与用户引用的技能目录，只有前者会改变状态快照；如果按
 *  「快照没变就直接返回」短路，引用目录里新增或删除的技能会永远留在缓存里。
 *  策略与依赖在这里显式分开，便于用确定性回归锁住这个行为。 */
import type { SkillsState } from '../shared/skills.ts'

export interface SkillsRefreshDeps {
  /** 重新读取磁盘状态，并给出用于比较的快照字符串。 */
  read: () => { state: SkillsState; snapshot: string }
  /** 当前内存里的状态快照。 */
  currentSnapshot: () => string
  /** 接受新状态与其快照。 */
  accept: (state: SkillsState, snapshot: string) => void
  /** 引用目录集合可能变化时重挂 watcher。 */
  rewatch: () => void
  /** 失效清单缓存与注册表缓存。 */
  invalidate: () => void
}

/** 返回 watcher 的刷新回调：状态变化才重挂 watcher，但任何事件都失效清单缓存。 */
export function createSkillsRefresh(deps: SkillsRefreshDeps): () => void {
  return () => {
    const next = deps.read()
    if (next.snapshot !== deps.currentSnapshot()) {
      deps.accept(next.state, next.snapshot)
      deps.rewatch()
    }
    deps.invalidate()
  }
}
