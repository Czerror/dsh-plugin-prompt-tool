/**
 * 会话预设跟随：把工作台事实跟随官方会话级预设选择。
 *
 * 官方「新建会话」旁的预设选择器走 `agentPresets/select`，只改那一个空白会话并推进
 * 会话投影 `agentPreset`；宿主默认预设（`agent-presets.default`）不变。插件的
 * `presetTemplate` 镜像的是宿主默认，因此那条路径原本看不到官方侧的选择——本模块
 * 读会话投影，把工作台切到会话真正运行的预设（用户 2026-09-22 定案：自动跟随）。
 *
 * 跟随不重复切换会话：会话已经在该预设上，再 select 只会多记一条
 * `agent-preset/selected` 事件。决策集中在这里，store 只提供事实与动作，因此每条
 * 分支都能用纯 mock 做确定性回归：一致不动作、首次加载未完成不做决策、不在插件
 * 管理目录只提示一次、有未保存草稿保持不动、写盘期间防重入。
 */

/** 一次跟随检查需要的事实与动作（由 store 注入，便于测试）。 */
export interface SessionPresetFollowSnapshot {
  /** 当前会话记录的预设（官方会话投影 agentPreset）；未知为 undefined。 */
  sessionPreset: string | undefined
  /** 工作台当前预设。 */
  currentPreset: string
  /** 已成功应用快照的预设 id；与 currentPreset 不同表示数据尚未加载完成。 */
  loadedPreset: string | undefined
  /** 该预设是否可跟随（在插件管理目录中且可渲染）。 */
  followable(presetId: string): boolean
  /** 该预设上是否有未保存草稿：有则保持当前预设，静默不动。 */
  blocked(presetId: string): boolean
  /** 把工作台切到该预设（不重复切换会话）。 */
  apply(presetId: string): Promise<void>
  /** 无法跟随的提示；同一 id 只提示一次，避免每次投影通知都重复刷屏。 */
  warn(presetId: string): void
}

export interface SessionPresetFollower {
  /** 检查一次并按需跟随；可重复调用（幂等）。 */
  check(snapshot: SessionPresetFollowSnapshot): Promise<void>
}

/** 创建跟随器：跨调用只保留「写盘进行中」与「已提示过的 id」两项状态。 */
export function createSessionPresetFollower(): SessionPresetFollower {
  let busy = false
  let warned: string | undefined
  return {
    async check(snapshot) {
      if (busy) return
      const target = snapshot.sessionPreset
      // 没有会话预设事实，或工作台已经在目标预设上：不动作。
      if (target === undefined || target === snapshot.currentPreset) return
      // 首次加载未完成（fields 还不是可写事实）或切换进行中：等下一次检查。
      if (snapshot.loadedPreset !== snapshot.currentPreset) return
      if (!snapshot.followable(target)) {
        if (warned !== target) {
          warned = target
          snapshot.warn(target)
        }
        return
      }
      warned = undefined
      // 有未保存草稿：保持当前预设，等用户处理（不弹错，草稿本身在界面上可见）。
      if (snapshot.blocked(snapshot.currentPreset)) return
      busy = true
      try {
        await snapshot.apply(target)
      } finally {
        busy = false
      }
    },
  }
}
