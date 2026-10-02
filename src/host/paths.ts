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
 * 插件自有**存储根**（DSH_HOME/.prompt-tool）。
 *
 * 根下按物分目录：`modules/` 放模块定义与物化产物，`.characters/` 放角色卡库。
 * 与模块**同级的兄弟物**从模块路径上溯一级定位（`charactersDir(presetRoot)` 就是这么做），
 * 不从这里读——模块级常量在 import 时按 `DSH_HOME` 冻结，测试内改环境变量对它无效。
 * 旧根 `.agent-presets/` 只读不删，本插件不再读写它。
 */
const STORAGE_ROOT = join(DSH_HOME, '.prompt-tool')
/**
 * 模块根：一个模块一个目录（`modules/<id>/`），定义与物化产物都在其内。
 *
 * 这是 `resolvePresetDir` / `assertPresetDirectory` / `listPresets` 的扫描根，
 * 也是「本插件管理的预设」身份判定的基准。模块目录必须是它的**直接子目录**
 * （`assertPresetDirectory` 的一层深度契约由此成立）。
 */
export const DEFAULT_PRESET_DIR = join(STORAGE_ROOT, 'modules')
export const DEFAULT_PRESET_ORDER = 5
