import { Context } from '@deepseek-ai/cordis'
import { scopeChainOf, scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import { importHostCapability } from './host-package.mjs'

/** 标准预设在隔离组里提供 compaction，按会话的官方作用域定位当前实例。 */
export async function recoveryCompactionOf(agent) {
  const official = await importHostCapability('@deepseek-ai/dsh-compaction-basic').catch(() => undefined)
  const ctx = agent.ctx
  if (!official) return ctx.get('compaction')
  const key = scopeOf(ctx)
  const target = scopeTarget(agent, key)
  const owners = [...ctx.registry.get(official.BasicCompactionEngine)?.fibers ?? []]
    .filter(fiber => fiber.uid !== null && fiber.state === 2 && target[Context.filter](fiber.ctx))
  for (const scope of [...scopeChainOf(key), undefined]) {
    const matches = owners.filter(fiber => scopeOf(fiber.ctx) === scope)
    if (matches.length > 0) return matches.length === 1 ? matches[0].ctx.get('compaction') : undefined
  }
  return ctx.get('compaction')
}
