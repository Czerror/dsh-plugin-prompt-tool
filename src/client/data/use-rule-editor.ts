import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { bridgeCall } from './bridge-client.ts'
import { createRuleEditor, getRulesDraft, type RuleEditor, type RulesDraft } from './rule-drafts.ts'
import type { PromptToolStore } from './use-prompt-tool-store.ts'
import { usePromptToolFields } from './use-prompt-tool-fields.ts'

export function useRuleEditor(store: PromptToolStore) {
  const moduleId = usePromptToolFields(store, fields => fields.moduleId)
  useSyncExternalStore(store.subscribeDrafts, store.getDraftRevision, store.getDraftRevision)
  const draft = getRulesDraft(store.editorDrafts, moduleId)
  const editor = useMemo(() => createRuleEditor(moduleId, draft, {
    request: body => bridgeCall('rules', body, moduleId), enqueue: store.enqueueModuleTask,
    isCurrent: () => store.getFields().moduleId === moduleId, changed: store.publishDrafts,
  }), [moduleId, draft, store.enqueueModuleTask, store.getFields, store.publishDrafts])
  useEffect(() => { if (moduleId && !draft.loaded) void editor.load() }, [moduleId, editor, draft.loaded])
  return { moduleId, draft, editor }
}

export interface ModuleRuleEditor { moduleId: string; draft: RulesDraft; editor: RuleEditor }

/** 规则仍按模块共享草稿；读取集合来自启用模块的排序快照。 */
export function useModuleRuleEditors(store: PromptToolStore, moduleIds: readonly string[]): ModuleRuleEditor[] {
  useSyncExternalStore(store.subscribeDrafts, store.getDraftRevision, store.getDraftRevision)
  const identity = JSON.stringify([...new Set(moduleIds)].filter(Boolean))
  const active = useRef(moduleIds)
  active.current = moduleIds
  const editors = useMemo(() => (JSON.parse(identity) as string[]).map(moduleId => {
    const draft = getRulesDraft(store.editorDrafts, moduleId)
    return { moduleId, draft, editor: createRuleEditor(moduleId, draft, {
      request: body => bridgeCall('rules', body, moduleId),
      enqueue: (_id, task) => store.enqueueRuleTask(task),
      isCurrent: () => active.current.includes(moduleId), changed: store.publishDrafts,
    }) }
  }), [identity, store.editorDrafts, store.enqueueRuleTask, store.publishDrafts])
  useEffect(() => { for (const { editor } of editors) void editor.load(true) }, [editors])
  return editors
}
