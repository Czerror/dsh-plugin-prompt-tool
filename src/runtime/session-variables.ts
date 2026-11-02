import type { Context } from '@deepseek-ai/cordis'
import { openSessionVariables } from '../host/session-variables.ts'
import type { SessionVariableOwner } from '../host/session-variables.ts'

/** 可选官方持久能力迟到时再接入，不阻塞原有module/global域。 */
export function installSessionVariables(ctx: Context): () => SessionVariableOwner | undefined {
  let owner: SessionVariableOwner | undefined
  ctx.inject(['storageDomain'], scope => {
    let active = true
    const opening = openSessionVariables(scope.storageDomain).then(async value => {
      if (!active) await value.dispose()
      else owner = value
    }).catch(error => { scope.logger?.warn?.(`会话变量持久化不可用：${String(error)}`) })
    scope.effect(() => async () => {
      active = false
      const current = owner; owner = undefined
      await opening
      await current?.dispose()
    })
  })
  return () => owner
}
