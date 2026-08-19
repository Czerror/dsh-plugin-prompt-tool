/** host 数据层的部署路径与序数常量（settings 层与运行时共用，避免 host→config 反向依赖）。 */
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

/** 包内 skills 目录（构建后与 lib/ 同级）。 */
export const SKILLS_DIR = fileURLToPath(new URL('../../skills', import.meta.url))

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
export const DEFAULT_PRESET_DIR = join(DSH_HOME, '.agent-presets', 'prompt-tool')
export const DEFAULT_SKILLS_DIR = SKILLS_DIR
export const DEFAULT_PRESET_ORDER = 5
export const DEFAULT_SKILL_RANK_BASE = 250
