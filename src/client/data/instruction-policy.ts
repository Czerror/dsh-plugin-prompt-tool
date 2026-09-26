/**
 * 指令卡策略的客户端纯逻辑（无 React、无网络）：
 * 默认值、按 fileId 解析有效行为、以及把单文件改动编成 bridge 载荷。
 */
import type {
  InstructionPolicy,
  InstructionPolicyFileOverride,
  InstructionPolicyPatch,
  InstructionPolicySnapshot,
} from '../../shared/instructions.ts'

export const EMPTY_INSTRUCTION_POLICY_SNAPSHOT: InstructionPolicySnapshot = {
  policy: { files: {} },
  revision: null,
  exists: false,
}

/** 单文件缺省放行官方注入。 */
export function resolveInstructionFilePolicy(
  policy: InstructionPolicy,
  fileId: string,
): { enabled: boolean; name?: string } {
  // 服务端载荷可能不完整（老宿主/异常）：缺字段按默认，不当作「无策略」或抛错。
  const override = policy.files?.[fileId] ?? {}
  return {
    ...(override.name === undefined ? {} : { name: override.name }),
    enabled: override.enabled !== false,
  }
}

/** 单文件覆盖写请求：未列出的字段不提交，null 表示删除该文件覆盖。 */
export function instructionPolicyPatchForFile(
  fileId: string,
  override: InstructionPolicyFileOverride | null,
): InstructionPolicyPatch {
  return { files: { [fileId]: override } }
}
