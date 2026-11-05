/**
 * 指令文件编辑 owner：池、策略、卡片壳与三条写路径同处一个 module。
 *
 * 纯逻辑在 `instruction-drafts` / `instruction-policy` / `instruction-cards`；这里只拥有
 * 状态与时序（会话上下文、序号复核、逐文件结果、串行保存与 revision 乐观并发）。
 * 不引 React、不直接读全局请求通道：桥请求与当前会话都由依赖注入，测试可在同一 seam
 * 上注入桩并断言载荷。
 */
import type { PromptConfigDraft } from '../prompt-tool-types.ts'
import type { BridgeResponse } from '../../shared/bridge-contract.ts'
import type {
  InstructionPolicyFileOverride,
  InstructionPolicyPatch,
  InstructionPolicySnapshot,
  InstructionsSnapshot,
} from '../../shared/instructions.ts'
import {
  applySaveOutcomes,
  EMPTY_INSTRUCTION_POOL,
  instructionSaveRequest,
  isCurrentInstructionSeq,
  isCurrentSaveRequest,
  isInstructionConflictCode,
  markDraftSaving,
  poolFromSnapshot,
  resetDraftFromSnapshot,
  saveableInstructionDrafts,
  setDraftContent,
  switchInstructionContext,
  unsavedInstructionDrafts,
  type InstructionDraft,
  type InstructionDraftPool,
  type InstructionSaveOutcome,
} from './instruction-drafts.ts'
import { EMPTY_INSTRUCTION_POLICY_SNAPSHOT, instructionPolicyPatchForFile } from './instruction-policy.ts'
import { instructionShellsFrom, projectInstructionCards } from './instruction-cards.ts'
import { createSerialTaskQueue } from './save-queue.ts'

type BridgeCall = typeof import('./bridge-client.ts').bridgeCall

export interface InstructionEditorDependencies {
  /** 桥请求面：只用于 agentsFile / instructionsPolicy / promptConfigs 三个端点。 */
  request: BridgeCall
  /** 当前会话身份：与请求时的会话不一致即放弃在途结果。 */
  sessionId: () => string | undefined
  notify: (kind: 'ok' | 'error', message: string) => void
  /** 池、策略或壳变化后同步通知（facade 用它镜像 state 触发重渲染）。 */
  onChange: () => void
}

export interface InstructionIngestInput {
  /** /bootstrap 的指令段；缺段表示这次没有权威快照，不回填。 */
  instructions?: InstructionsSnapshot
  /** /bootstrap 的 promptConfigs 段：卡片壳的权威来源，空数组也会清掉旧壳。 */
  promptConfigs?: { promptConfigs?: unknown[] }
  /** /instructionsPolicy 的原始响应（解析与失败标记都归 owner）。 */
  policyResult: BridgeResponse<'instructionsPolicy'>
  /** 发起读取时的策略引用：期间有新的策略写入就跳过回填，不覆盖用户操作。 */
  expectPolicy: InstructionPolicySnapshot
}

export interface InstructionEditor {
  getPool: () => InstructionDraftPool
  getPolicy: () => InstructionPolicySnapshot
  /** 当前 (壳, 池, 策略) 的卡片投影；所有发布路径都从这里取。 */
  projectCards: () => PromptConfigDraft[]
  /** 视图重建时清空壳，等同一次读取的 promptConfigs 段重新填。 */
  clearShells: () => void
  /** 会话变化即建立新上下文：旧草稿保留但不可写，壳清空。 */
  switchSession: (sessionId: string | undefined) => void
  ingestSnapshot: (input: InstructionIngestInput) => { stranded: InstructionDraft[] }
  /** 只走草稿池；无实际改动返回 false，调用方据此决定是否推进草稿版本。 */
  patchText: (fileId: string, text: string) => boolean
  saveFiles: (fileIds?: readonly string[]) => Promise<boolean>
  savePolicy: (patch: InstructionPolicyPatch) => Promise<boolean>
  updatePolicy: (fileId: string, override: InstructionPolicyFileOverride | null) => Promise<boolean>
  reloadFile: (fileId: string) => Promise<void>
}

/** 响应缺少策略快照（老宿主/异常载荷）不得当成「空策略」放开编辑。 */
const parsePolicy = (res: BridgeResponse<'instructionsPolicy'>): InstructionPolicySnapshot => {
  const value = res.ok ? res.value : undefined
  if (value?.policy === undefined) {
    return {
      ...EMPTY_INSTRUCTION_POLICY_SNAPSHOT,
      error: `未读取到指令策略：${res.ok ? '响应缺少策略快照' : res.message ?? 'settings bridge unavailable'}`,
    }
  }
  return {
    policy: value.policy,
    revision: value.revision ?? null,
    exists: value.exists === true,
    ...(value.error === undefined ? {} : { error: value.error }),
  }
}

export function createInstructionEditor(deps: InstructionEditorDependencies): InstructionEditor {
  let pool: InstructionDraftPool = EMPTY_INSTRUCTION_POOL
  let policy: InstructionPolicySnapshot = EMPTY_INSTRUCTION_POLICY_SNAPSHOT
  let shells: PromptConfigDraft[] = []
  let seq = 0
  let session: string | undefined
  const policyQueue = createSerialTaskQueue()

  const setPool = (next: InstructionDraftPool): void => { pool = next; deps.onChange() }
  const setPolicy = (next: InstructionPolicySnapshot): void => { policy = next; deps.onChange() }

  const editor: InstructionEditor = {
    getPool: () => pool,
    getPolicy: () => policy,
    projectCards: () => projectInstructionCards(shells, pool, policy),
    clearShells: () => { shells = []; deps.onChange() },
    switchSession: (sessionId) => {
      if (sessionId === session) return
      session = sessionId
      // 新上下文还没有卡壳：清空后由发布链重投影，旧卡不留在视图里。
      shells = []
      setPool(switchInstructionContext(pool, ++seq))
    },
    ingestSnapshot: (input) => {
      let stranded: InstructionDraft[] = []
      if (input.instructions !== undefined) {
        // 正文、身份、版本与读取状态来自同一次读取；序号推进后旧的迟到应答自然失效。
        setPool(poolFromSnapshot(input.instructions, ++seq, pool))
        // 切到别的工作区后，未保存草稿的文件可能已不在当前可见范围：保留草稿，交调用方说清楚。
        const visible = new Set(input.instructions.files.map((file) => file.fileId))
        stranded = unsavedInstructionDrafts(pool).filter((draft) => !visible.has(draft.fileId))
      }
      // 策略读取期间有新的策略写入：这次响应已过期，不覆盖用户操作。
      if (policy === input.expectPolicy) setPolicy(parsePolicy(input.policyResult))
      // 卡片壳只来自 /bootstrap 的会话段；空数组或缺段都是权威结果，会清掉旧壳。
      if (input.promptConfigs !== undefined) {
        shells = instructionShellsFrom(input.promptConfigs.promptConfigs)
        deps.onChange()
      }
      return { stranded }
    },
    patchText: (fileId, text) => {
      const draft = pool.drafts.find((entry) => entry.fileId === fileId)
      // 无改动不参与草稿版本：否则并发的静默重载会被误判成「用户在保存期间有编辑」。
      if (draft === undefined || draft.content === text) return false
      setPool(setDraftContent(pool, fileId, text))
      return true
    },
    saveFiles: async (fileIds) => {
      const snapshot = pool
      const pending = unsavedInstructionDrafts(snapshot)
        .filter((draft) => fileIds === undefined || fileIds.includes(draft.fileId))
      if (pending.length === 0) return true
      const targets = saveableInstructionDrafts(snapshot)
        .filter((draft) => fileIds === undefined || fileIds.includes(draft.fileId))
      const sessionId = deps.sessionId()
      const isCurrent = (): boolean => isCurrentInstructionSeq(pool, snapshot.latest)
        && pool.contextId === snapshot.contextId
        && sessionId === deps.sessionId() && sessionId === session
      if (!isCurrent()) return false
      const requests = new Map(targets.flatMap((draft) => {
        const request = instructionSaveRequest(pool, draft.fileId, sessionId)
        return request === undefined ? [] : [[draft.fileId, request] as const]
      }))
      for (const fileId of requests.keys()) setPool(markDraftSaving(pool, fileId, true))
      const results: InstructionSaveOutcome[] = pending.filter((draft) => !requests.has(draft.fileId)).map((draft) => ({
        fileId: draft.fileId, ok: false, message: draft.error ?? draft.message ?? '文件尚不可写、存在冲突或正在保存',
      }))
      for (const [fileId, request] of requests) {
        // 每次发送前和应答后都复核；切换工作区后不能继续提交批次中的旧文件。
        if (!isCurrent()) return false
        if (!isCurrentSaveRequest(pool, request)) {
          results.push({ fileId, ok: false, message: '文件已重新读取，本次旧草稿未继续保存' })
          continue
        }
        const res = await deps.request('agentsFile', request)
        if (!isCurrent()) return false
        if (!isCurrentSaveRequest(pool, request)) {
          results.push({ fileId, ok: false, message: '文件已重新读取，迟到保存结果未应用' })
          continue
        }
        const result: InstructionSaveOutcome = res.ok && typeof res.value.revision === 'string'
          ? { fileId, ok: true, revision: res.value.revision }
          : { fileId, ok: false, message: res.ok ? '保存响应缺少文件版本' : res.message ?? '写盘失败', conflict: !res.ok && isInstructionConflictCode(res.code) }
        results.push(result)
        // 已成功的文件立即确认；后续文件失败或切换上下文也不丢失成功基线。
        setPool(applySaveOutcomes(pool, [result], requests))
      }
      const failures = results.filter((result) => !result.ok)
      if (failures.length > 0) {
        const label = (fileId: string): string => pool.drafts.find((draft) => draft.fileId === fileId)?.displayPath ?? fileId
        deps.notify('error', `指令文件保存失败（${failures.length}/${results.length}）：${failures.map((failure) => `${label(failure.fileId)}：${failure.message ?? '未知错误'}`).join('；')}`)
        return false
      }
      deps.notify('ok', `已保存指令文件：${results.length} 个`)
      return true
    },
    savePolicy: (patch) => policyQueue.enqueue(async () => {
      const current = policy
      if (current.error !== undefined) {
        deps.notify('error', `指令策略不可写：${current.error}`)
        return false
      }
      const res = await deps.request('instructionsPolicy', { policy: patch, expectedRevision: current.revision })
      if (policy !== current) return false
      if (!res.ok || res.value.policy === undefined || res.value.error !== undefined) {
        deps.notify('error', '指令策略保存失败：' + (res.ok ? res.value.error ?? '响应缺少策略快照' : res.message ?? 'settings bridge unavailable'))
        return false
      }
      setPolicy({ policy: res.value.policy, revision: res.value.revision, exists: res.value.exists })
      deps.notify('ok', '指令策略已保存（影响后续注入，不撤回已进入会话的内容）')
      return true
    }),
    updatePolicy: (fileId, override) => editor.savePolicy(instructionPolicyPatchForFile(fileId, override)),
    reloadFile: async (fileId) => {
      const sessionId = deps.sessionId()
      const snapshot = pool
      const draft = snapshot.drafts.find((entry) => entry.fileId === fileId)
      if (snapshot.contextId === null || draft?.contextId !== snapshot.contextId || sessionId !== session) return
      const res = await deps.request('promptConfigs', sessionId === undefined ? {} : { sessionId })
      if (sessionId !== deps.sessionId() || !isCurrentInstructionSeq(pool, snapshot.latest)
        || pool.contextId !== snapshot.contextId) return
      if (pool.drafts.find((entry) => entry.fileId === fileId) !== draft) {
        deps.notify('error', '重新读取期间文件草稿已更新，本次读取未覆盖新草稿')
        return
      }
      if (!res.ok || res.value.instructions === undefined) {
        deps.notify('error', `重新读取指令文件失败：${res.ok ? '未返回指令文件快照' : res.message ?? 'settings bridge unavailable'}`)
        return
      }
      if (res.value.instructions.context.contextId !== snapshot.contextId) {
        deps.notify('error', '指令文件上下文已变化，本次读取未应用；请重新加载工作台')
        return
      }
      const file = res.value.instructions.files.find((entry) => entry.fileId === fileId)
      if (file === undefined) {
        deps.notify('error', '该指令文件不在当前工作区范围内，本地草稿已保留但不可写')
        return
      }
      setPool(resetDraftFromSnapshot(pool, file))
      deps.notify('ok', `已重新读取指令文件：${file.displayPath}`)
    },
  }
  return editor
}
