/** Soul宿主接线：历史只读句柄、检索授权与SELF/维护共享owner。 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ModuleToolHost } from '../host/module-tool-target.ts'
import { assertModuleDirectory } from '../host/module-install.ts'
import { renderSoulSelf } from '../host/soul-self.ts'
import { createModuleRetrievalProvider } from './module-retrieval-tools.ts'
import type { RetrievalEvent } from '../../engine/retrieval-reference.mjs'
import { createSoulMaintenanceProvider } from './soul-maintenance.ts'
import { SOUL_MAINTENANCE_SERVICE, SOUL_SELF_SERVICE, toolServiceName } from '../../engine/service-names.mjs'

export function installSoulRuntime(ctx: Context, host: ModuleToolHost, moduleIds: (id: string) => readonly string[]): void {
  const retrieval = createModuleRetrievalProvider(host, async id => {
    const sessions = ctx.get('sessions') as { get(id: string): { id: string; snapshotEvents(): readonly RetrievalEvent[] } | undefined } | undefined
    const live = sessions?.get(id)
    if (live) return live
    const persistence = ctx.get('sessionPersistence') as {
      open(id: string, access: 'read'): Promise<{ read(offset: number, length: number): Promise<{ events: readonly RetrievalEvent[] }>; close(): Promise<void> }>
    } | undefined
    if (!persistence) throw new Error('历史会话持久服务不可用')
    const handle = await persistence.open(id, 'read')
    try {
      const { events } = await handle.read(0, 100001)
      if (events.length > 100000 || Buffer.byteLength(JSON.stringify(events)) > 32 * 1024 * 1024) throw new Error('授权会话超出检索预算')
      return { id, snapshotEvents: () => events }
    } finally { await handle.close() }
  })
  const maintenance = createSoulMaintenanceProvider({ refreshRetrieval: (agent, id, signal) => retrieval.refresh(agent, id, signal) })
  ctx.provide(toolServiceName('retrieval'), retrieval)
  ctx.provide(SOUL_MAINTENANCE_SERVICE, maintenance)
  ctx.provide(SOUL_SELF_SERVICE, {
    render: (id: string, agent: Agent, signal?: AbortSignal): string => {
      signal?.throwIfAborted()
      if (!moduleIds(agent.id).includes(id)) throw new Error('SELF来源模块未参与本Agent装配')
      return renderSoulSelf(assertModuleDirectory(host.root, id), agent, signal)
    },
  })
  ctx.effect(() => () => maintenance.dispose())
}
