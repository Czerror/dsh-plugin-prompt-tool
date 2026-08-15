import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { PromptEditor, type PromptEditorInjected } from './PromptEditor.tsx'

export const inject = ['slots', 'connection']

export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle

  const injected = (): PromptEditorInjected => ({
    api: connection.api,
  })

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    id: 'prompt-tool',
    order: 30,
    inject: injected,
  }, PromptEditor as any))
}
