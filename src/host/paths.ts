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
/** 用户技能根：官方 `user-dsh` 技能根，也是本插件创建、复制导入、回收站与内置技能种子化的落点。
 *  内置技能按「只补缺失」补建（见 `ensureSkillSeed`）：已有目录的正文、资源与调用策略保持原样。 */
export const USER_SKILLS_DIR = join(DSH_HOME, 'skills')
/**
 * 插件自有**存储根**（DSH_HOME/.prompt-tool）。
 *
 * `modules/` 放完整定义、经校验规则切片和用户素材；角色卡导入后也是普通模块。
 * 路径在 import 时按 `DSH_HOME` 冻结，测试必须在导入前隔离环境。
 * 旧根 `.agent-presets/` 只读不删，本插件不再读写它。
 */
const STORAGE_ROOT = join(DSH_HOME, '.prompt-tool')
/**
 * 存储根下的**模块根**：一个模块一个目录（`modules/<id>/`），定义与物化产物都在其内。
 *
 * 这是 `resolveModuleDir` / `assertModuleDirectory` / `listModules` 的扫描根，
 * 也是「本插件管理的模块」身份判定的基准。模块目录必须是它的**直接子目录**
 * （`assertModuleDirectory` 的一层深度契约由此成立）。
 */
export const MODULES_DIR = join(STORAGE_ROOT, 'modules')
/**
 * 模块定义文件名：`<模块根>/<id>/module.yml`。
 *
 * 与 `rules/` 运行切片和 `memory.md` 等用户资产同目录。
 * 旧形态的 `preset.yml` **不做兼容读取**：实测真实数据（beta 形态遗留）已经是本名，
 * 且仓库从 `02754cc` 起就没有 `preset.yml` 形态的用户数据；读到旧名目录时由
 * `listModules` 给出明确诊断，而不是静默跳过。
 */
export const MODULE_DEFINITION_FILE = 'module.yml'
/** 完整模块定义的确定性运行切片；仅 module.yml 接受人工编辑。 */
export const RULES_DIR = 'rules'
export const RULES_SETTINGS_FILE = '_settings.yml'
export const RULES_VARIABLES_FILE = 'variables.yml'
/** 模块在列表里的默认排序权重。 */
export const DEFAULT_MODULE_ORDER = 5
