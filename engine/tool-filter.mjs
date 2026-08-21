/**
 * Main-session tool filter — apply a persistent allow/deny mask to the
 * assembled tool catalog, covering EVERY registered tool (including tools
 * contributed by arbitrary third-party plugins).
 *
 * Unlike `tool-bootstrap` (phase-1 bootstrap narrowing that restores the full
 * catalog after promotion), this filter is CONSTANT: it runs on every
 * `system-prompt/assemble` and keeps the mask applied before and after
 * promotion, so main-session tool restrictions never disappear.
 *
 * Config:
 *   - `allow`: non-empty keep-set. When present, ONLY tools whose name is in
 *     this list survive (white-list); `deny` is then subtracted from it.
 *   - `deny`: non-empty remove-set. Tools whose name is in this list are
 *     dropped regardless of `allow`.
 *   - `includeSubagents`: true = the same mask applies to delegated
 *     sub-agents; false (default) = main session only, sub-agents keep the
 *     assembled catalog (they already have their own toolFilter{allow,deny}
 *     in the tool-subagent row).
 *
 * Both lists empty = no filtering (official default), zero overhead.
 * Failure degrades to the full catalog — a filter bug must never brick a
 * session (same discipline as tool-bootstrap).
 */

import { booleanOption, createWarnOnce, validateConfig } from './shared.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'anchored-tool-filter'

export const inject = []

/** Every config key this plugin accepts — anything else is a typo. */
const ALLOWED_KEYS = new Set(['allow', 'deny', 'includeSubagents', 'enabled'])

/** Non-empty string list validator (returns a Set). */
function nameSet(value, field) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be an array of non-empty strings`)
  }
  return new Set(value)
}

/** Apply the mask to one assembled catalog. */
function applyMask(assembled, allow, deny) {
  if (allow === undefined && deny === undefined) return assembled
  const tools = (Array.isArray(assembled.tools) ? assembled.tools : [])
    .filter((tool) => {
      const toolName = typeof tool?.name === 'string' ? tool.name : ''
      if (toolName.length === 0) return true
      if (deny !== undefined && deny.has(toolName)) return false
      if (allow !== undefined && !allow.has(toolName)) return false
      return true
    })
  return { ...assembled, tools }
}

/** Register the per-assembly main-session tool mask. */
export function apply(ctx, config) {
  const source = validateConfig(name, config, ALLOWED_KEYS)
  if (source.enabled === false) return
  const allow = nameSet(source.allow, 'allow')
  const deny = nameSet(source.deny, 'deny')
  const includeSubagents = booleanOption(name, source.includeSubagents, 'includeSubagents', false)
  const warnOnce = createWarnOnce(ctx, name)

  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const assembled = await next()
    try {
      const agent = context?.agent
      const depth = agent?.session?.header?.delegationDepth ?? 0
      if (depth > 0 && !includeSubagents) return assembled
      return applyMask(assembled, allow, deny)
    } catch (error) {
      warnOnce(`${name}: filter failed, exposing the full catalog: ${String((error && error.message) || error)}`)
      return assembled
    }
  })
}
