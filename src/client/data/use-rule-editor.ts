import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { bridgeCall } from './bridge-client.ts'
import { createRuleEditor, getRulesDraft } from './rule-drafts.ts'
import type { PromptToolStore } from './use-prompt-tool-store.ts'
import { usePromptToolFields } from './use-prompt-tool-fields.ts'

export function useRuleEditor(store: PromptToolStore) {
  const moduleId = usePromptToolFields(store, fields => fields.presetTemplate)
  useSyncExternalStore(store.subscribeDrafts, store.getDraftRevision, store.getDraftRevision)
  const draft = getRulesDraft(store.editorDrafts, moduleId)
  const editor = useMemo(() => createRuleEditor(moduleId, draft, {
    request: body => bridgeCall('rules', body), enqueue: store.enqueuePresetTask,
    isCurrent: () => store.getFields().presetTemplate === moduleId, changed: store.publishDrafts,
  }), [moduleId, draft, store.enqueuePresetTask, store.getFields, store.publishDrafts])
  useEffect(() => { if (moduleId && !draft.loaded) void editor.load() }, [moduleId, editor, draft.loaded])
  return { moduleId, draft, editor }
}
