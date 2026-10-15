/** host 数据层的部署路径与序数常量（settings 层与运行时共用，避免 host→config 反向依赖）。 */
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

/**
 * 解析部署根。与官方 dsh-home-paths.resolveDshHome 语义对齐：
 * 未设置 / 空串 / 纯空白回退 OS home 下的 .dsh；支持 ~、~/、~\；
 * 相对路径按进程 cwd 解析为绝对路径，避免生成目录随运行目录漂移。
 */
export function resolveDshHome(): string {
  const ambient = process.env.DSH_HOME
  if (typeof ambient !== 'string' || ambient.trim().length === 0) return join(homedir(), '.dsh')
  const expanded = ambient === '~'
    ? homedir()
    : ambient.startsWith('~/') || ambient.startsWith('~\\')
      ? join(homedir(), ambient.slice(2))
      : ambient
  return resolve(expanded)
}

/**
 * 部署根：**每次调用按当前环境求值**，不在 import 时冻结。
 *
 * 根仍由平台层的 `DSH_HOME` 决定（与官方 `resolveDshHome` 同口径），插件不另立配置项；
 * 惰性求值换来两件事：测试可以按自己的隔离目录现算、不必「先设环境变量再动态 import」，
 * 同一进程内换根也立即生效（此前那套时序是真实事故的来源，见 scripts/run-tests.mjs 的注释）。
 */
export const dshHome = (): string => resolveDshHome()

/**
 * 插件自有**存储根**的派生（`<部署根>/.prompt-tool`）：本插件拥有的全部状态与生成目录都在
 * 它下面，其他用户或官方文件不在其中。
 *
 * 纯函数、不读环境：调用方手里已经有部署根时（测试、夹具、多根场景）用它现算。
 */
export function storageRootOf(home: string): string {
  return join(home, '.prompt-tool')
}

/**
 * 当前进程的存储根（`DSH_HOME/.prompt-tool`），每次调用按当前环境求值。
 *
 * `modules/` 放完整定义、经校验规则切片和用户素材；角色卡导入后也是普通模块。
 * 旧根 `.agent-presets/` 只读不删，本插件不再读写它。
 */
export const storageRoot = (): string => storageRootOf(dshHome())

/** 同一部署根的全局持久变量；不属于任何模块交换包。 */
export const globalVariablesFile = (): string => join(storageRoot(), 'variables.yml')

/**
 * 用户技能根：官方 `user-dsh` 技能根，也是本插件创建、复制导入、回收站与内置技能种子化的落点。
 * 内置技能按「只补缺失」补建（见 `ensureSkillSeed`）：已有目录的正文、资源与调用策略保持原样。
 */
export const userSkillsDir = (): string => join(dshHome(), 'skills')

/**
 * 存储根下的**模块根**：一个模块一个目录（`modules/<id>/`），定义与物化产物都在其内。
 *
 * 这是 `resolveModuleDir` / `assertModuleDirectory` / `listModules` 的扫描根，
 * 也是「本插件管理的模块」身份判定的基准。模块目录必须是它的**直接子目录**
 * （`assertModuleDirectory` 的一层深度契约由此成立）。
 */
export const modulesDir = (): string => join(storageRoot(), 'modules')

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
