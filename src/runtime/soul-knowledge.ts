import type { Context } from '@deepseek-ai/cordis'
import { openSoulKnowledge } from '../host/soul-knowledge.ts'
import type { SoulKnowledgeOwner } from '../host/soul-knowledge.ts'
import type { RetrievalSession } from '../host/module-retrieval.ts'
import type { RetrievalEvent } from '../../engine/retrieval-reference.mjs'

export async function loadKnowledgeSession(ctx: Context, id: string): Promise<RetrievalSession> {
  const live = (ctx.get('sessions') as { get(id: string): RetrievalSession | undefined } | undefined)?.get(id)
  if (live) return live
  const persistence = ctx.get('sessionPersistence') as { open(id: string, access: 'read'): Promise<{ read(offset: number, length: number): Promise<{ events: readonly RetrievalEvent[] }>; close(): Promise<void> }> } | undefined
  if (!persistence) throw new Error('历史会话持久服务不可用')
  const handle = await persistence.open(id, 'read')
  try {
    const { events } = await handle.read(0, 100001)
    if (events.length > 100000 || Buffer.byteLength(JSON.stringify(events)) > 32 * 1024 * 1024) throw new Error('授权会话超出检索预算')
    return { id, snapshotEvents: () => events }
  } finally { await handle.close() }
}

export function installSoulKnowledge(ctx: Context): () => SoulKnowledgeOwner | undefined {
  let owner: SoulKnowledgeOwner | undefined
  ctx.inject(['storageDomain'], scope => {
    let active = true
    const opening = openSoulKnowledge(scope.storageDomain, id => loadKnowledgeSession(scope, id)).then(async value => {
      if (!active) await value.dispose()
      else owner = value
    }).catch(error => { scope.logger?.warn?.(`知识库持久状态不可用：${String(error)}`) })
    scope.effect(() => async () => {
      active = false
      const current = owner; owner = undefined
      await opening
      await current?.dispose()
    })
  })
  return () => owner
}
