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
        const names = mask.allow === undefined
          ? mask.deny
          : new Set([...sdkToolNames(section.text)].filter((toolName) => mask.blocks(toolName)))
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
