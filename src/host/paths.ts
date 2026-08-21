/** host 数据层的部署路径与序数常量（settings 层与运行时共用，避免 host→config 反向依赖）。 */
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 包内 skills 目录。
 * 源码位于 src/host/（../../skills = 包根/skills），构建后内联进 lib/（层级变浅）。
 * 统一向上查找最近包含 skills/manifest.json 的包根，两种形态都正确。
 */
export const SKILLS_DIR = (() => {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(dir, 'skills', 'manifest.json'))) return join(dir, 'skills')
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return join(dir, 'skills')
})()

/**
 * 部署路径默认值；凡是不同部署可能需要不同值的参数都通过 Config 暴露，
 * cordis.yml 可以覆盖，无需改代码。
 * 与官方 dsh-home-paths.resolveDshHome 语义对齐：
 * 未设置 / 空串 / 纯空白回退 OS home 下的 .dsh；支持 ~、~/、~\；
 * 相对路径按进程 cwd 解析为绝对路径，避免生成目录随运行目录漂移。
 */
function resolveDshHome(): string {
  const ambient = process.env.DSH_HOME
  if (typeof ambient !== 'string' || ambient.trim().length === 0) return join(homedir(), '.dsh')
  const expanded = ambient === '~'
    ? homedir()
    : ambient.startsWith('~/') || ambient.startsWith('~\\')
      ? join(homedir(), ambient.slice(2))
      : ambient
  return resolve(expanded)
}

export const DSH_HOME = resolveDshHome()
export const DEFAULT_RESIDENT_AGENTS_PATH = join(DSH_HOME, 'AGENTS.md')
/**
 * 预设根：官方 USER_PRESET_DIR（DSH_HOME/.agent-presets）。
 * 每个预设一个官方预设目录（agent.cordis.yml 组合本体 + preset.yml 参数），
 * 宿主 agent-presets 直接可挂载；共享引擎在 .engine（点前缀 → discovery 跳过）。
 */
export const DEFAULT_PRESET_DIR = join(DSH_HOME, '.agent-presets')
/** 共享引擎目录（点前缀：官方 PRESET_ID 校验跳过，不占预设槽）。 */
export const SHARED_ENGINE_DIR = join(DEFAULT_PRESET_DIR, '.engine')
/** 旧版用户预设目录（~/.dsh/presets；迁移后归档为 presets.bak-*）。 */
export const LEGACY_USER_PRESETS_DIR = join(DSH_HOME, 'presets')
/** 旧版容器根（.agent-presets/prompt-tool；迁移后归档为 prompt-tool.bak-*）。 */
export const LEGACY_CONTAINER_DIR = join(DEFAULT_PRESET_DIR, 'prompt-tool')
export const DEFAULT_SKILLS_DIR = SKILLS_DIR
export const DEFAULT_PRESET_ORDER = 5
export const DEFAULT_SKILL_RANK_BASE = 250
