/**
 * 指令卡策略的客户端纯逻辑（无 React、无网络）：
 * 默认值、按 fileId 解析有效行为、以及把单文件改动编成 bridge 载荷。
 */
import type {
  InstructionPolicy,
  InstructionPolicyFileOverride,
  InstructionPolicyPatch,
  InstructionPolicySnapshot,
  InstructionPolicyValues,
} from '../../shared/instructions.ts'

/** 与 host 默认值一致（host 是事实源；这里是未读到快照前的显示兜底）。 */
export const DEFAULT_INSTRUCTION_POLICY_VALUES: InstructionPolicyValues = {
  order: 30,
  position: 'after-user',
  promotion: 'none',
  audience: null,
  modelScope: 'all',
}

export const EMPTY_INSTRUCTION_POLICY_SNAPSHOT: InstructionPolicySnapshot = {
  policy: { enabled: false, defaults: { ...DEFAULT_INSTRUCTION_POLICY_VALUES }, files: {} },
  revision: null,
  exists: false,
}

/** 单个文件的有效策略：覆盖优先于 defaults；部署级 enabled 优先于每文件开关。 */
export function resolveInstructionFilePolicy(
  policy: InstructionPolicy,
  fileId: string,
): InstructionPolicyValues & { enabled: boolean; name?: string } {
  // 服务端载荷可能不完整（老宿主/异常）：缺字段按默认，不当作「无策略」或抛错。
  const override = policy.files?.[fileId] ?? {}
  return {
    ...DEFAULT_INSTRUCTION_POLICY_VALUES,
    ...policy.defaults,
    ...override,
    enabled: policy.enabled && override.enabled !== false,
  }
}

/** 单文件覆盖写请求：未列出的字段不提交，null 表示删除该文件覆盖。 */
export function instructionPolicyPatchForFile(
  fileId: string,
  override: InstructionPolicyFileOverride | null,
): InstructionPolicyPatch {
  return { files: { [fileId]: override } }
}
