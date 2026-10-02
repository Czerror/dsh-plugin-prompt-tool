/** host 数据层的部署路径与序数常量（settings 层与运行时共用，避免 host→config 反向依赖）。 */
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

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
/** 用户技能根：官方 `user-dsh` 技能根，也是本插件创建、复制导入与回收站的落点。
 *  插件不再内置任何技能：包内没有 skills 目录，也不再有安装副本与内容账本。 */
export const USER_SKILLS_DIR = join(DSH_HOME, 'skills')
/**
 * 插件自有存储根（DSH_HOME/.prompt-tool）。
 * 每份定义保存模块声明与物化产物，由插件自己解析并装配（不再依赖宿主扫描此目录）。
 * 旧根 `.agent-presets/` 只读不删，本插件不再读写它。
 */
export const DEFAULT_PRESET_DIR = join(DSH_HOME, '.prompt-tool')
/** 历史共享引擎目录：阶段 2 起不再物化，保留常量仅供引用/清理判定，勿据此写盘。 */
export const SHARED_ENGINE_DIR = join(DEFAULT_PRESET_DIR, '.engine')
export const DEFAULT_PRESET_ORDER = 5
