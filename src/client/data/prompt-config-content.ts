/** promptConfigs 内容资产的文件载荷与 UI 草稿映射（纯逻辑）。 */
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

/** 指令文件卡：正文与卡片定义都不写进 preset.yml，正文只能经 /agents-file 显式写盘。 */
export const isAgentsFileCard = (config: PromptConfigDraft): boolean => instructionFileIdOf(config) !== undefined

/** 模块卡（不含指令文件来源）。 */
export const isModuleCard = (config: PromptConfigDraft): boolean => !isAgentsFileCard(config)

/** 旧正文注入规则转为自身的可编辑正文，不再按固定ID走独立文件保存。 */
export const liftContentText = (config: PromptConfigDraft): PromptConfigDraft => {
  if (config.strategy !== 'custom-fallback' || config.text !== undefined) return config
  const text = typeof config.params?.text === 'string' ? config.params.text : ''
  if (text.length === 0) return config
  const { text: _text, ...params } = config.params ?? {}
  return { ...config, text, params }
}
