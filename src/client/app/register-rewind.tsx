import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { RewindButton } from '../features/rewind/RewindButton.tsx'
import { RewindRecoveryOwner } from '../data/rewind.ts'
import { installRewindConversation, requireRewindConversation } from '../data/rewind-conversation.ts'
import { PROMPT_TOOL_NS } from '../../shared/namespace.ts'
import type { PromptToolTranslate } from '../locales.ts'

export function registerRewindSlot(ctx: ClientContext, translate: PromptToolTranslate): () => void {
  const recovery = new RewindRecoveryOwner()
  const disposeConversation = installRewindConversation(ctx.uiConversation, id => ctx.sessions.binding(id as Parameters<typeof ctx.sessions.binding>[0]))
  const disposeSlot = ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'prompt-tool-rewind', order: 40,
    locale: PROMPT_TOOL_NS,
    inject: () => ({ translate, recovery, ensureView: (id: string) => { requireRewindConversation(ctx.uiConversation, id) } }),
  }, RewindButton))
  return () => { disposeSlot(); disposeConversation(); recovery.clear() }
}
