/** promptConfigs 内容资产的文件载荷与 UI 草稿映射（纯逻辑）。 */
import type { PromptConfigDraft } from '../prompt-tool-types.ts'

/**
 * 内容资产条目：只有 preset.md 注入卡（prompt-injector）的 text 走生成目录文件通道。
 * AGENTS.md 已改为常驻层（$DSH_HOME/AGENTS.md 受管块）+ 动态探测提示，不再由卡片承载正文。
 */
export const isContentAsset = (config: PromptConfigDraft): boolean =>
  config.id === 'prompt-injector'

/** 剥离内容资产的 text（顶层 + params.text）：settings 载荷不承载大文本。 */
export const stripContentText = (config: PromptConfigDraft): PromptConfigDraft => {
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
