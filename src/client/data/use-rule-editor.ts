import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { bridgeCall } from './bridge-client.ts'
import { createRuleEditor, getRulesDraft } from './rule-drafts.ts'
import type { RuleEditor, RulesDraft } from './rule-drafts.ts'
import type { PromptToolStore } from './use-prompt-tool-store.ts'
import { usePromptToolFields } from './use-prompt-tool-fields.ts'

/** 一个模块的规则草稿与编辑器。 */
export interface ModuleRuleEditor {
  moduleId: string
  draft: RulesDraft
  editor: RuleEditor
}

/** 唯一真相源：为每个模块造一份 editor，键就是模块 id。 */
function buildEditors(store: PromptToolStore, moduleIds: readonly string[], currentModuleId: string | undefined): Map<string, ModuleRuleEditor> {
  // 模块清单来自调用方（已启用模块），当前编辑模块必须在列。
  const ids = new Set(moduleIds)
  if (currentModuleId !== undefined && currentModuleId.length > 0) ids.add(currentModuleId)
  const editors = new Map<string, ModuleRuleEditor>()
  for (const moduleId of ids) {
    const draft = getRulesDraft(store.editorDrafts, moduleId)
    editors.set(moduleId, {
      moduleId,
      draft,
      editor: createRuleEditor(moduleId, draft, {
        // 带**该模块**的模块头：否则 A 模块的卡会拿当前编辑目标的身份去读写。
        request: (body) => bridgeCall('rules', body, moduleId),
        enqueue: store.enqueueModuleTask,
        // 一律 true：编辑器不该因为「不是当前激活模块」而拒绝读写，
        // 那正是把卡片做成只读的同一条错误思路。
        isCurrent: () => true,
        changed: store.publishDrafts,
      }),
    })
  }
  return editors
}

/**
 * 每个模块各一份 `{ draft, editor }`——平铺视图据此把每张卡绑到它自己的模块。
 *
 * 全部复用既有实现：`getRulesDraft`（草稿容器 `editorDrafts.rules` 本就按模块分区）
 * 与 `createRuleEditor`（实例自带模块身份）。
 *
 * `moduleIds` 必须是**稳定引用**（调用方用 useMemo 派生）：每帧新建数组会让 Map 与
 * editor 反复重建。不能从 `editorDrafts.rules` 的键派生——那只含访问过的模块。
 */
export function useModuleRuleEditors(store: PromptToolStore, moduleIds: readonly string[]): ReadonlyMap<string, ModuleRuleEditor> {
  useSyncExternalStore(store.subscribeDrafts, store.getDraftRevision, store.getDraftRevision)
  const currentModuleId = usePromptToolFields(store, (value) => value.moduleId)
  return useMemo(
    () => buildEditors(store, moduleIds, currentModuleId),
    [moduleIds, currentModuleId, store.editorDrafts, store.enqueueModuleTask, store.publishDrafts],
  )
}

/** 进页面时把还没读过的模块各读一次。 */
export function useLoadModuleRules(editors: ReadonlyMap<string, ModuleRuleEditor>): void {
  const pending = [...editors.values()].filter(({ draft }) => !draft.loaded).map(({ moduleId }) => moduleId)
  const signature = pending.join('\u0000')
  useEffect(() => {
    for (const moduleId of signature.length > 0 ? signature.split('\u0000') : []) {
      // 从最新 Map 取实例，避免用闭包捕获的旧实例。
      void editors.get(moduleId)?.editor.load()
    }
  }, [signature, editors]) // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * 当前编辑模块的草稿与编辑器——单模块路径的既有语义。
 *
 * 与 `useModuleRuleEditors` 共用同一份 `drafts.rules`：草稿是单一真相源，
 * 两条路径只是取实例的方式不同，不会出现「两份草稿」。取不到实例时（尚无 moduleId）
 * 退化成直接构造，行为与改动前一致。
 */
export function useRuleEditor(store: PromptToolStore): {
  moduleId: string | undefined
  draft: RulesDraft
  editor: RuleEditor
} {
  const moduleId = usePromptToolFields(store, (fields) => fields.moduleId)
  // 稳定引用：模块清单每帧新建会让 Map 与 editor 重建。单模块路径只需当前模块。
  const ids = useMemo(() => (moduleId === undefined ? [] : [moduleId]), [moduleId])
  const editors = useModuleRuleEditors(store, ids)
  const current = moduleId === undefined ? undefined : editors.get(moduleId)
  const draft = current?.draft ?? getRulesDraft(store.editorDrafts, moduleId ?? '')
  const fallback = useMemo(() => createRuleEditor(moduleId ?? '', draft, {
    request: (body) => bridgeCall('rules', body, moduleId),
    enqueue: store.enqueueModuleTask,
    isCurrent: () => store.getFields().moduleId === moduleId,
    changed: store.publishDrafts,
  }), [moduleId, draft, store.enqueueModuleTask, store.getFields, store.publishDrafts])
  const editor = current?.editor ?? fallback
  useEffect(() => { if (moduleId && !draft.loaded) void editor.load() }, [moduleId, editor, draft.loaded])
  return { moduleId, draft, editor }
}
