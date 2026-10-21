/**
 * 指令文件卡的视图投影（纯逻辑，无 React、无网络）。
 *
 * 卡壳来自服务端快照，正文与状态来自草稿池，开关与显示名来自指令策略——
 * 三者各有一份写入口，卡片永远是投影结果，不反过来成为投影的输入。
 */
import type { PromptConfigDraft } from '../prompt-tool-types.ts'
import type { InstructionPolicySnapshot } from '../../shared/instructions.ts'
import type { InstructionDraftPool } from './instruction-drafts.ts'
import { instructionFileIdOf } from './prompt-config-content.ts'
import { resolveInstructionFilePolicy } from './instruction-policy.ts'

/** 策略值 → 卡片行为字段（文件卡的行为不来自 module.yml）。 */
export function instructionPolicyFields(
  resolved: { enabled: boolean; name?: string },
): Partial<PromptConfigDraft> {
  return {
    enabled: resolved.enabled,
    ...(resolved.name === undefined ? {} : { name: resolved.name }),
  }
}

/** 一次投影：服务端卡壳 + 草稿池 + 指令策略 → 卡片视图。 */
export function projectInstructionCards(
  shells: readonly PromptConfigDraft[],
  pool: InstructionDraftPool,
  policy: InstructionPolicySnapshot,
): PromptConfigDraft[] {
  return shells.map((config) => {
    const fileId = instructionFileIdOf(config)
    if (fileId === undefined) return config
    // 文件卡只从独立策略读取开关和名称；注入位置与生命周期归官方所有。
    const resolved = resolveInstructionFilePolicy(policy.policy, fileId)
    const draft = pool.drafts.find((entry) => entry.fileId === fileId)
    if (draft === undefined) {
      // 卡存在但没有对应快照：不把未知正文当空文件，直接禁用保存。
      return {
        ...config,
        ...instructionPolicyFields(resolved),
        text: '',
        contentStatus: 'unreadable' as const,
        contentMessage: '未读取到该文件正文，已禁用保存',
      }
    }
    const message = draft.error ?? draft.message
    return {
      ...config,
      ...instructionPolicyFields(resolved),
      text: draft.content,
      contentStatus: draft.status,
      // 视图字段显式覆盖：池里冲突/提示已清除时卡片不得留上一帧的旧标记。
      contentMessage: message,
      contentDirty: draft.content !== draft.savedContent,
      contentConflict: draft.conflict === true ? true : undefined,
      contentSaving: draft.saving === true ? true : undefined,
    }
  })
}
