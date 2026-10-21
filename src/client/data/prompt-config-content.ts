/** 指令文件卡的 fileId 解析（纯逻辑）：origin 优先，params.fileId 回退。 */
import type { PromptConfigDraft } from '../prompt-tool-types.ts'

/**
 * 指令文件卡绑定的 fileId：origin 优先（服务端生成的来源），回退卡自带的 params.fileId。
 * 只有能解析出 fileId 的卡才是指令文件卡——按卡 id 前缀或 params.file 猜所有者会造成误路由。
 */
export const instructionFileIdOf = (config: PromptConfigDraft): string | undefined => {
  const origin = config.origin
  if (origin !== undefined && origin.kind === 'instruction-file') return origin.fileId
  const fileId = config.params?.fileId
  return config.sourceKind === 'instruction-file' && typeof fileId === 'string' && fileId.length > 0
    ? fileId
    : undefined
}
