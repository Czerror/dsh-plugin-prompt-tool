/**
 * 自定义工具草稿的**读改写 owner**：读取守卫、在途判定与整组提交只在这一处。
 *
 * 形态照 `rule-drafts.ts` 的最小骨架——载体（`ToolsEditorDraft`）作位置参数传入、依赖显式注入、
 * 「最新优先」用 `resource-track.ts` 的原语。比 rules 少的部分是刻意的：工具没有 CAS 版本、
 * 没有冲突分类、没有增量 patch，草稿就是整组工具。
 *
 * 留在卡片里的是渲染：`useState` 镜像、展开态、提示文案与 disabled 判定。
 */
import type { ToolsEditorDraft, ToolDraft } from './workspace-drafts.ts'
import type { BridgeRequestMap, BridgeValueMap } from '../../shared/bridge-contract.ts'
import type { BridgeResult } from './bridge-client.ts'
import { beginLatest, isLatest } from './resource-track.ts'

/** 这张卡的读数入口：**声明面明确未声明就不构造这次请求**（返回 `undefined`），卡片据此转创建模式。 */
export interface ToolsReader {
  load: () => Promise<BridgeResult<BridgeValueMap['customTools']>> | undefined
}

export interface ToolsEditorDependencies {
  reader: ToolsReader
  request: (body: BridgeRequestMap['customTools']) => Promise<BridgeResult<BridgeValueMap['customTools']>>
  /** 这张卡是否仍挂在当前视图上；应答回来时已卸载即不改状态。 */
  isCurrent: () => boolean
  changed: () => void
  /** 创建模式下首次成功写盘后回调：调用方据此重读 `/meta`。 */
  onDeclared?: () => void
}

/**
 * 保存前清理：工具 `parameters` 的空 key 待编辑行（与 `saveModuleVariables` 的保存端清理对齐）。
 * 判定「有没有未保存输入」用的是 `saved`，因此这里也把清理结果写回 `saved`，否则那行空 key 会让卡片永远是脏的。
 */
function cleanTools(tools: ToolDraft[]): ToolDraft[] {
  return tools.map((tool) => {
    const params = tool.parameters !== null && typeof tool.parameters === 'object' && !Array.isArray(tool.parameters)
      ? tool.parameters as Record<string, unknown> : {}
    const clean: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(params)) if (key.trim().length > 0) clean[key] = value
    const next = { ...tool }
    if (Object.keys(clean).length > 0) next.parameters = clean
    else delete next.parameters
    return next
  })
}

/** 字段槽里有未落地的输入（键/值差异或校验错误）：读回时草稿优先，不覆盖。 */
const fieldsDiffer = (draft: ToolsEditorDraft): boolean =>
  [...draft.fields.values()].some((field) => field.text !== field.source || field.error.length > 0)

export function createToolsEditor(moduleId: string, draft: ToolsEditorDraft, deps: ToolsEditorDependencies) {
  const isCurrentStep = (sequence: number): boolean => deps.isCurrent() && isLatest(draft, sequence)
  const load = async (): Promise<boolean> => {
    if (draft.loaded) return true
    const request = deps.reader.load()
    if (request === undefined) {
      draft.loaded = true
      draft.error = ''
      deps.changed()
      return true
    }
    const sequence = beginLatest(draft)
    const reading = draft.tools
    const result = await request
    // 迟到的应答既不落地也不改状态。
    if (!isCurrentStep(sequence)) return false
    if (!result.ok) {
      draft.error = result.message ?? 'customTools.loadFailed'
      deps.changed()
      return false
    }
    // 读期间用户改过草稿（或字段有未落地的输入）时不覆盖：草稿优先。
    if (draft.tools !== reading || fieldsDiffer(draft)) {
      draft.error = ''
      draft.loaded = true
      deps.changed()
      return true
    }
    draft.tools = (result.value.customTools ?? []).map((tool) => tool as ToolDraft)
    draft.saved = draft.tools
    draft.loaded = true
    draft.error = ''
    deps.changed()
    return true
  }
  const mutate = (next: ToolDraft[]): void => {
    if (draft.saving) return
    draft.tools = next
    deps.changed()
  }
  const applyPatch = (index: number, patch: Partial<ToolDraft>): void => {
    if (draft.saving) return
    const previousId = String(draft.tools[index]?.id ?? index)
    if (patch.id !== undefined && String(patch.id) !== previousId) {
      const prefix = `${previousId}:`
      // 重命名会向 Map 写入，必须遍历快照以免再次遍历新键。
      // eslint-disable-next-line unicorn/no-useless-spread -- 这个展开是语义需要的：就地改 Map 会让迭代器错乱
      for (const [key, field] of [...draft.fields]) if (key.startsWith(prefix)) {
        draft.fields.set(`${String(patch.id)}:${key.slice(prefix.length)}`, field)
        draft.fields.delete(key)
      }
    }
    draft.tools = draft.tools.map((tool, at) => at === index ? { ...tool, ...patch } : tool)
    deps.changed()
  }
  const save = async (): Promise<BridgeResult<BridgeValueMap['customTools']> | undefined> => {
    if (draft.saving) return undefined
    const submitted = cleanTools(draft.tools)
    const sequence = beginLatest(draft)
    draft.saving = true
    deps.changed()
    try {
      const result = await deps.request({ customTools: submitted, expectedModuleId: moduleId })
      if (!isCurrentStep(sequence)) return undefined
      // 保存失败只把结果交给调用方去提示：草稿的 `error` 属读取态，不被写失败污染（与原实现一致）。
      if (result.ok) draft.saved = submitted
      deps.onDeclared?.()
      return result
    } finally {
      if (isCurrentStep(sequence)) {
        draft.saving = false
        deps.changed()
      }
    }
  }
  const insertTemplate = async (spec: Record<string, unknown>): Promise<'inserted' | 'duplicate' | 'failed'> => {
    if (!draft.loaded) {
      const request = deps.reader.load()
      // 声明面未声明（＝创建模式）：这次读构造不出来，与原实现一样判为插入失败。
      if (request === undefined) return 'failed'
      const sequence = beginLatest(draft)
      const reading = draft.tools
      const result = await request
      if (!isCurrentStep(sequence) || !result.ok) return 'failed'
      // 读回期间已有插入/编辑时只补基线，不覆盖草稿。
      if (draft.tools === reading) draft.tools = (result.value.customTools ?? []) as ToolDraft[]
      draft.saved = (result.value.customTools ?? []) as ToolDraft[]
      draft.error = ''
      draft.loaded = true
      deps.changed()
    }
    if (draft.tools.some((tool) => tool.id === spec.id)) return 'duplicate'
    draft.tools = [...draft.tools, JSON.parse(JSON.stringify(spec)) as ToolDraft]
    deps.changed()
    return 'inserted'
  }
  return { load, mutate, applyPatch, save, insertTemplate }
}

export type ToolsEditor = ReturnType<typeof createToolsEditor>
