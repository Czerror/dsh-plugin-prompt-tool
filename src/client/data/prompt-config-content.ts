/** promptConfigs 内容资产的文件载荷与 UI 草稿映射（纯逻辑）。 */
import type { PromptConfigDraft } from '../prompt-tool-types.ts'

/**
 * 内容资产条目：只有 preset.md 注入卡（prompt-injector）的 text 走生成目录文件通道。
 * 指令文件正文不在这里：它按 fileId 走独立的文件草稿与 /agents-file 单文件写通道。
 */
export const isContentAsset = (config: PromptConfigDraft): boolean =>
  config.id === 'prompt-injector'

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

/** 预设卡（不含指令文件来源）。 */
export const isPresetCard = (config: PromptConfigDraft): boolean => !isAgentsFileCard(config)

/**
 * 剥离内容资产的 text（顶层 + params.text）：settings 载荷不承载大文本。
 * 只对内容资产生效——普通卡的 text/texts/params.text 是自身合法字段，剥离会静默丢正文。
 */
export const stripContentText = (config: PromptConfigDraft): PromptConfigDraft => {
  if (!isContentAsset(config)) return config
  const next: PromptConfigDraft = { ...config }
  delete next.text
  if (next.params !== undefined) {
    const params = { ...next.params }
    delete params.text
    next.params = params
  }
  return next
}

/** 渲染产物 → 编辑草稿：params.text 提升到 text 编辑框。 */
export const liftContentText = (config: PromptConfigDraft): PromptConfigDraft => {
  if (!isContentAsset(config) || (config.text ?? '') !== '') return config
  const text = typeof config.params?.text === 'string' ? config.params.text : ''
  return text.length > 0 ? { ...config, text } : config
}
