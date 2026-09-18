/**
 * 指令文件草稿池（纯逻辑，无 React、无网络）。
 * 与预设卡草稿分离：文件正文只按 fileId 索引显式保存，不参与预设的 debounce 自动保存；
 * 读取失败/超限不是空正文，冲突与保存失败都不丢用户草稿。
 */
import type {
  InstructionFileSnapshot,
  InstructionFileStatus,
  InstructionsOwnerView,
  InstructionsSnapshot,
} from '../../shared/instructions.ts'

export interface InstructionDraft {
  fileId: string
  /** 读取该草稿时的工作区上下文；与 pool.contextId 不一致时禁止写盘。 */
  contextId: string | null
  path: string
  displayPath: string
  scope: 'global' | 'project'
  status: InstructionFileStatus
  message?: string
  /** 基线版本（保存请求的 expectedRevision）；不可读时为 null，此时禁止保存。 */
  revision: string | null
  /** 已读取或已保存的基线正文。 */
  savedContent: string
  /** 用户当前正文。 */
  content: string
  /** 读取后磁盘已变：不静默覆盖，先让用户重新读取或显式保存（由服务端 409 兜底）。 */
  conflict?: boolean
  /** 最近一次保存失败原因；保存成功或重新编辑后清除。 */
  error?: string
  /** 保存中：同文件请求串行，期间继续编辑仍保持 dirty。 */
  saving?: boolean
}

export interface InstructionDraftPool {
  contextId: string | null
  cwd: string | null
  /**
   * session = 由存活本地 Agent 的会话 cwd 解析；deploy-cwd = 会话不可用，
   * 退回部署进程 cwd；global-only = 客户端尚无服务端解析结果时的空池标记。
   */
  source: 'session' | 'deploy-cwd' | 'global-only'
  /** 上下文序号：迟到响应按序号丢弃，不写入新上下文。 */
  seq: number
  drafts: InstructionDraft[]
  /** 负责人事实（服务端观察）：true 时独立来源本次不注入正文，UI 只做提示。 */
  owner: InstructionsOwnerView
}

export interface InstructionSaveRequest {
  sessionId?: string
  contextId: string
  fileId: string
  expectedRevision: string | null
  content: string
}

export interface InstructionSaveOutcome {
  fileId: string
  ok: boolean
  revision?: string
  message?: string
  /** 版本冲突（409）：草稿保留，必须重新读取后才能再写。 */
  conflict?: boolean
}

export const EMPTY_INSTRUCTION_POOL: InstructionDraftPool = {
  contextId: null,
  cwd: null,
  source: 'global-only',
  seq: 0,
  drafts: [],
  owner: { officialInstructions: null },
}

/**
 * 需要「重新读取」才能继续的写盘失败码（host/agents-cards.ts 的输出）：
 * 版本冲突、目标身份变化、当前不可读——都不是可以自动重试成功的情况。
 */
export const INSTRUCTION_CONFLICT_CODES: readonly string[] = [
  'agents-file-conflict',
  'agents-file-identity-changed',
  'agents-file-unreadable',
  // 工作区/会话上下文已变（settings-bridge 的写前重解析）：同样必须先重新读取。
  'agents-file-context-stale',
]

export const isInstructionConflictCode = (code: string | undefined): boolean =>
  code !== undefined && INSTRUCTION_CONFLICT_CODES.includes(code)

const draftFromSnapshot = (file: InstructionFileSnapshot, contextId: string | null): InstructionDraft => ({
  fileId: file.fileId,
  contextId,
  path: file.path,
  displayPath: file.displayPath,
  scope: file.scope,
  status: file.status,
  ...(file.message === undefined ? {} : { message: file.message }),
  revision: file.revision,
  savedContent: file.status === 'ready' ? file.text : '',
  content: file.status === 'ready' ? file.text : '',
})

/** 同一文件的新快照并入既有草稿：用户改了正文就不让远端版本静默顶掉它。 */
function mergeDraft(draft: InstructionDraft, file: InstructionFileSnapshot, contextId: string | null): InstructionDraft {
  if (file.status !== 'ready') {
    // 读取失败/超限/消失：保留草稿，但状态与版本按事实更新，且不再可写。
    return {
      ...draft,
      contextId,
      path: file.path,
      displayPath: file.displayPath,
      scope: file.scope,
      status: file.status,
      message: file.message,
      saving: false,
      revision: null,
    }
  }
  const dirty = draft.content !== draft.savedContent
  const diskChanged = file.revision !== draft.revision
  if (dirty && diskChanged) {
    // 期间磁盘变了：保留草稿与旧基线（保存时由 expectedRevision 判 409），不采纳新版本。
    return {
      ...draft,
      contextId,
      path: file.path,
      displayPath: file.displayPath,
      scope: file.scope,
      status: 'ready',
      message: file.message,
      saving: false,
      conflict: true,
    }
  }
  if (dirty) return { ...draft, contextId, path: file.path, displayPath: file.displayPath, scope: file.scope, status: 'ready', message: file.message, saving: false }
  return draftFromSnapshot(file, contextId)
}

/**
 * 用一次读取快照重建草稿池。同一上下文内到达的快照不会丢用户草稿：
 * 未改动的文件采纳磁盘新版本，改过的文件保留草稿并标记冲突。
 */
export function poolFromSnapshot(
  snapshot: InstructionsSnapshot,
  seq: number,
  previous?: InstructionDraftPool,
): InstructionDraftPool {
  const base = previous ?? EMPTY_INSTRUCTION_POOL
  const contextId = snapshot.context.contextId
  const drafts = snapshot.files.map((file) => {
    const existing = base.drafts.find((draft) => draft.fileId === file.fileId)
    return existing === undefined ? draftFromSnapshot(file, contextId) : mergeDraft(existing, file, contextId)
  })
  for (const draft of base.drafts) {
    if (snapshot.files.some((file) => file.fileId === draft.fileId)) continue
    drafts.push({ ...draft, contextId: null, status: 'missing', saving: false, message: '文件不在当前工作区范围或已不存在' })
  }
  return {
    contextId,
    cwd: snapshot.context.cwd,
    source: snapshot.context.source,
    seq,
    drafts,
    // 老宿主/异常载荷缺 owner 时按「未观察到」处理，不猜成冲突。
    owner: snapshot.owner ?? { officialInstructions: null },
  }
}

/** 上下文切换：保留草稿（不丢输入），但旧上下文草稿自此不可写；负责人事实回到未观察态。 */
export function switchInstructionContext(pool: InstructionDraftPool, seq: number): InstructionDraftPool {
  return { ...pool, contextId: null, cwd: null, source: 'global-only', seq, drafts: pool.drafts.map((draft) => ({ ...draft, saving: false })), owner: { officialInstructions: null } }
}

/** 迟到响应（上下文序号已过期）不得写入当前视图。 */
export const isCurrentInstructionSeq = (pool: InstructionDraftPool, seq: number): boolean => pool.seq === seq

export function setDraftContent(pool: InstructionDraftPool, fileId: string, content: string): InstructionDraftPool {
  return {
    ...pool,
    drafts: pool.drafts.map((draft) => (
      draft.fileId === fileId ? { ...draft, content, error: undefined } : draft
    )),
  }
}

/** 显式「重新读取」：丢弃本地草稿，采纳磁盘版本（含清除冲突）。 */
export function resetDraftFromSnapshot(pool: InstructionDraftPool, file: InstructionFileSnapshot): InstructionDraftPool {
  const existing = pool.drafts.find((draft) => draft.fileId === file.fileId)
  const next = draftFromSnapshot(file, pool.contextId)
  return {
    ...pool,
    drafts: existing === undefined
      ? [...pool.drafts, next]
      : pool.drafts.map((draft) => (draft.fileId === file.fileId ? next : draft)),
  }
}

/** 正文相对基线有改动（含冲突中、保存中的文件）：用于「未保存草稿」提示。 */
export const unsavedInstructionDrafts = (pool: InstructionDraftPool): InstructionDraft[] =>
  pool.drafts.filter((draft) => draft.content !== draft.savedContent)

/** 可提交的文件：读取就绪、有基线版本、无未解决冲突、上下文仍是当前的。 */
export const canSaveDraft = (pool: InstructionDraftPool, draft: InstructionDraft): boolean =>
  draft.status === 'ready'
  && draft.contextId !== null
  && draft.contextId === pool.contextId
  && draft.revision !== null
  && draft.conflict !== true
  && draft.saving !== true
  && draft.content !== draft.savedContent

export const saveableInstructionDrafts = (pool: InstructionDraftPool): InstructionDraft[] =>
  pool.drafts.filter((draft) => canSaveDraft(pool, draft))

/** 单文件保存请求（契约形状）；不可提交时返回 undefined，不发送注定失败的请求。 */
export function instructionSaveRequest(
  pool: InstructionDraftPool,
  fileId: string,
  sessionId?: string,
): InstructionSaveRequest | undefined {
  const draft = pool.drafts.find((entry) => entry.fileId === fileId)
  if (draft === undefined || pool.contextId === null || !canSaveDraft(pool, draft)) return undefined
  return {
    ...(sessionId === undefined || sessionId.length === 0 ? {} : { sessionId }),
    contextId: pool.contextId,
    fileId: draft.fileId,
    expectedRevision: draft.revision,
    content: draft.content,
  }
}

export function markDraftSaving(pool: InstructionDraftPool, fileId: string, saving: boolean): InstructionDraftPool {
  return {
    ...pool,
    drafts: pool.drafts.map((draft) => (
      draft.fileId === fileId ? { ...draft, saving, ...(saving ? { error: undefined } : {}) } : draft
    )),
  }
}

/** 保存成功：只把「请求时快照」记为基线；期间的新输入仍是 dirty。 */
export function applySaveSuccess(
  pool: InstructionDraftPool,
  fileId: string,
  request: InstructionSaveRequest,
  revision: string,
): InstructionDraftPool {
  return {
    ...pool,
    drafts: pool.drafts.map((draft) => (
      draft.fileId === fileId
        ? { ...draft, savedContent: request.content, revision, saving: false, error: undefined, conflict: undefined }
        : draft
    )),
  }
}

/** 保存失败：保留草稿与旧基线；冲突时要求重新读取，不自动重载覆盖用户输入。 */
export function applySaveFailure(
  pool: InstructionDraftPool,
  fileId: string,
  message: string,
  options: { conflict?: boolean } = {},
): InstructionDraftPool {
  return {
    ...pool,
    drafts: pool.drafts.map((draft) => (
      draft.fileId === fileId
        ? { ...draft, saving: false, error: message, ...(options.conflict === true ? { conflict: true } : {}) }
        : draft
    )),
  }
}

/** 保存全部：逐文件结果，成功项更新基线、失败项保留草稿，不宣称跨文件原子提交。 */
export function applySaveOutcomes(
  pool: InstructionDraftPool,
  results: readonly InstructionSaveOutcome[],
  requests: ReadonlyMap<string, InstructionSaveRequest>,
): InstructionDraftPool {
  let next = pool
  for (const result of results) {
    if (result.ok && result.revision !== undefined) {
      const request = requests.get(result.fileId)
      if (request !== undefined) next = applySaveSuccess(next, result.fileId, request, result.revision)
      else next = markDraftSaving(next, result.fileId, false)
    } else {
      next = applySaveFailure(next, result.fileId, result.message ?? '保存失败', { conflict: result.conflict === true })
    }
  }
  return next
}
