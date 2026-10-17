import { labelOf, createMask } from './shared.mjs'
import { SDK_SECTION_NAME, sdkToolNames, stripSdkDeclarations } from '../sdk-strip.mjs'

export function prepareSdkStrip(action, plugin) {
  const label = labelOf(action)
  const mask = createMask(action.mask ?? action, `${label}.mask`, plugin)
  return (_ctx, { warnOnce, on, collect, take }) => collect(on('system-prompt/assemble', async (assembly, context, next) => {
    // Downstream errors propagate untouched; only this action's own logic is guarded.
    const assembled = await next()
    try {
      if (!Array.isArray(assembled.sections)) return assembled
      let changed = false
      const sections = assembled.sections.map((section) => {
        if (section?.name !== SDK_SECTION_NAME || typeof section.text !== 'string') return section
        // 正文工具名只解析一次：白名单的裁剪目标与 requireMatch 的缺失判据同源。
        let present
        const presentNames = () => {
          present ??= new Set(sdkToolNames(section.text))
          return present
        }
        // 与 assembly 的 requireMatch 同判据、同方向（只对白名单有意义）：名单里任一工具不在
        // 本段正文 → 放弃裁剪、保留完整正文。deny 模式没有“必需名单”，与 assembly 的
        // required 一致地不触发。名单之外的现状不变：解析不出来就不裁。
        if (mask.requireMatch && mask.allow !== undefined
          && [...mask.allow].some((toolName) => !presentNames().has(toolName))) {
          warnOnce(`${plugin}: sdk-strip action ${label}: a requireMatch tool is absent — keeping the full SDK text (fail-open)`)
          return section
        }
        const names = mask.allow === undefined
          ? mask.deny
          : new Set([...presentNames()].filter((toolName) => mask.blocks(toolName)))
        if (names === undefined || names.size === 0) return section
        const stripped = stripSdkDeclarations(section.text, names)
        if (stripped === section.text) return section
        changed = true
        return { ...section, text: stripped }
      })
      return changed && take(context) ? { ...assembled, sections } : assembled
    } catch (error) {
      warnOnce(`${plugin}: sdk-strip action ${label} failed, keeping the original SDK text: ${String(error?.message ?? error)}`)
      return assembled
    }
  }))
}
