import type { Context } from '@deepseek-ai/cordis'
import { openSoulKnowledge } from '../host/soul-knowledge.ts'
import type { SoulKnowledgeOwner } from '../host/soul-knowledge.ts'

export function installSoulKnowledge(ctx: Context): () => SoulKnowledgeOwner | undefined {
  let owner: SoulKnowledgeOwner | undefined
  ctx.inject(['storageDomain'], scope => {
    let active = true
    const opening = openSoulKnowledge(scope.storageDomain).then(async value => {
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
