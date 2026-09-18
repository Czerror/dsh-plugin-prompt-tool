/**
 * 指令文件（AGENTS.md / CLAUDE.md 等）跨 host/client 的最小契约。
 * 只放两端都要理解的形状：读取快照、工作区上下文与写入结果；
 * 引擎侧的位置/晋升/受众算法不在这里复制。
 */

/** 单个指令文件正文上限（与官方指令行的 maxBytes 基线对齐；读写限制一致）。 */
export const MAX_INSTRUCTION_FILE_BYTES = 64 * 1024

export const INSTRUCTION_FILE_STATUSES = ['ready', 'missing', 'unreadable', 'too-large'] as const

/**
 * 读取状态：`ready` 之外的任何状态都不代表空正文，也禁止写盘。
 * 读取成功的空文件是 `ready` + `text: ''`，与读取失败严格区分。
 */
export type InstructionFileStatus = (typeof INSTRUCTION_FILE_STATUSES)[number]

/** 单次读取形成的一致快照：正文、身份、版本来自同一次读取。 */
export interface InstructionFileSnapshot {
  /** 服务端按真实文件身份生成；不是客户端写入授权本身。 */
  fileId: string
  /** 服务端解析出的绝对路径（客户端不得据此写盘，只是展示与身份）。 */
  path: string
  /** 展示用路径（DSH_HOME 内 `~/.dsh/…`，项目内相对项目根）。 */
  displayPath: string
  scope: 'global' | 'project'
  status: InstructionFileStatus
  /** status === 'ready' 时的原始 UTF-8 正文（可为空串）；其他状态为 ''。 */
  text: string
  /** status === 'ready' 时原始文件字节的 SHA-256；其他状态为 null。 */
  revision: string | null
  /** 读取失败/超限的诊断信息；ready 时不带。 */
  message?: string
}

/**
 * 本次工作区上下文：优先由存活本地 Agent 的会话 cwd 解析；拿不到会话时回退到
 * 部署进程 cwd（与官方 agent-instructions 的 `session.header.cwd ?? process.cwd()`
 * 同口径），并如实标记来源，让 UI 能辨别两种范围。
 */
export interface InstructionContextView {
  /** 上下文 id（cwd + 文件身份集派生）；无可解析本地会话时为 null。 */
  contextId: string | null
  cwd: string | null
  /**
   * session = 由存活本地 Agent 的会话 cwd 解析；
   * deploy-cwd = 会话不可用，退回部署进程 cwd（范围提示，不构成写授权）；
   * global-only = 客户端尚无服务端解析结果时的空池标记。
   */
  source: 'session' | 'deploy-cwd' | 'global-only'
}

export interface InstructionsSnapshot {
  context: InstructionContextView
  files: InstructionFileSnapshot[]
  owner: InstructionsOwnerView
}

/**
 * 指令负责人事实：本会话实际装配里是否仍挂着官方指令加载行。
 * `true` 时独立文件来源整体不参战（同一正文只由一方注入）；`false` 表示由本插件
 * 的独立来源负责；`null` 表示本次请求还没有该会话的装配观察结果（不猜）。
 */
export interface InstructionsOwnerView {
  officialInstructions: boolean | null
}

/** /agents-file 成功返回值：写盘后的新版本，客户端据此更新基线。 */
export interface InstructionFileWriteResult {
  fileId: string
  revision: string
}

/**
 * 指令文件卡策略（独立于预设与 settings 的本插件自有状态）。
 *
 * 只承载行为开关与展示名：正文永远在用户的原文件里，策略不存正文、读取版本、
 * 会话 ID 或任意客户端路径。缺省 `enabled: false`——独立来源必须先完成负责人
 * 切换验收，再由用户显式开启。
 */
export interface InstructionPolicyValues {
  order: number
  position: string
  promotion: string
  audience: string | null
  modelScope: string
}

export interface InstructionPolicyFileOverride extends Partial<InstructionPolicyValues> {
  /** 每文件可关闭注入（默认开启）；部署级 enabled 为 false 时整体不注入。 */
  enabled?: boolean
  /** 可选显示名（只影响 UI 标题）。 */
  name?: string
}

export interface InstructionPolicy {
  /** 部署级开关：文件来源是否参与注入。 */
  enabled: boolean
  /** 未单独覆盖的文件使用这些值。 */
  defaults: InstructionPolicyValues
  /** 按 fileId 的覆盖；缺省即用 defaults，删除覆盖恢复默认。 */
  files: Record<string, InstructionPolicyFileOverride>
}

/** 局部更新：只写传入的键；files[fileId] = null 表示删除该覆盖。 */
export interface InstructionPolicyPatch {
  enabled?: boolean
  defaults?: Partial<InstructionPolicyValues>
  files?: Record<string, InstructionPolicyFileOverride | null>
}

/** /instructions-policy 读取结果（error 非空时禁止保存，不把损坏文件当空配置）。 */
export interface InstructionPolicySnapshot {
  policy: InstructionPolicy
  /** 文件内容版本（原始字节 sha256）；文件缺失为 null。 */
  revision: string | null
  exists: boolean
  error?: string
}
