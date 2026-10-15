import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { bridgeCall } from './bridge-client.ts'
import { createRuleEditor, getRulesDraft, type RuleEditor, type RulesDraft } from './rule-drafts.ts'
import type { DraftsPort, RuleEditingPort } from './store-ports.ts'

export interface ModuleRuleEditor { moduleId: string; draft: RulesDraft; editor: RuleEditor }

/** 规则编辑器从 store 转交出去的能力面：草稿池与规则事务。 */
export type RuleEditorStore = DraftsPort & RuleEditingPort

/** 规则按模块共享草稿；读取集合＝装配集合里各模块自己的 id（没有「当前模块」特例）。 */
export function useModuleRuleEditors(store: RuleEditorStore, moduleIds: readonly string[]): ModuleRuleEditor[] {
  useSyncExternalStore(store.subscribeDrafts, store.getDraftRevision, store.getDraftRevision)
  const identity = JSON.stringify([...new Set(moduleIds)].filter(Boolean))
  const active = useRef(moduleIds)
  active.current = moduleIds
  useEffect(() => { active.current = moduleIds; return () => { active.current = [] } }, [identity])
  const editors = useMemo(() => (JSON.parse(identity) as string[]).map(moduleId => {
    const draft = getRulesDraft(store.editorDrafts, moduleId)
    return { moduleId, draft, editor: createRuleEditor(moduleId, draft, {
      request: body => bridgeCall('rules', body, moduleId),
      enqueue: (_id, task) => store.enqueueRuleTask(task),
      isCurrent: () => active.current.includes(moduleId), changed: store.publishDrafts,
    }) }
  }), [identity, store.editorDrafts, store.enqueueRuleTask, store.publishDrafts])
  // 未加载的草稿才重读：全局加载（改总闸、导入）会把 loaded 清成 false，届时按各模块主语重取一次。
  const pending = editors.filter(({ draft }) => !draft.loaded).map(({ moduleId }) => moduleId).join(',')
  useEffect(() => {
    for (const { editor, draft } of editors) if (!draft.loaded) void editor.load()
  }, [editors, pending])
  return editors
}
