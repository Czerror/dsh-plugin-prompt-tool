/** 工具管理（tool-pipeline 层）：自定义工具定义。 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '../../ui/Button.tsx'
import { bridgeCall } from '../../data/bridge-client.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import type { ToolsEditorDraft, WorkspaceDrafts } from '../../data/workspace-drafts.ts'
import { CustomToolCard, asRecord, type ToolDraft } from './CustomToolEditor.tsx'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './tools.module.css'

const styles = { ...sharedCss, ...featureCss }

/** 所属层按钮直接提交的创建请求；草稿由常驻页面立即建立。 */
export type ToolCreateIntent = { kind: 'blank' | 'template'; spec?: ToolDraft; moduleId?: string }

/** 工具草稿的唯一构造点：按模块的编辑区与「新建工具模板」入口共用同一份草稿。 */
export const createToolsEditorDraft = (): ToolsEditorDraft => ({
  tools: [], saved: [], expanded: new Set(), fields: new Map(), loaded: false, error: '', saving: false,
})

/**
 * 把工具模板插入该模块的工具草稿（主语＝调用方给的模块）。
 * 草稿还没读回时先按同一主语读一次（与卡内同一端点、同一载荷形状）；
 * 读回期间已有插入/编辑时只补基线，不覆盖草稿。
 */
export async function insertToolTemplateIntoDraft(drafts: WorkspaceDrafts, moduleId: string, spec: Record<string, unknown>): Promise<'inserted' | 'duplicate' | 'failed'> {
  const editor = drafts.tools.get(moduleId) ?? createToolsEditorDraft()
  drafts.tools.set(moduleId, editor)
  if (!editor.loaded) {
    const readingTools = editor.tools
    const result = await bridgeCall('customTools', { expectedModuleId: moduleId }, moduleId)
    if (!result.ok) return 'failed'
    const loaded = (result.value.customTools ?? []).map((tool) => asRecord(tool))
    if (editor.tools === readingTools) editor.tools = loaded
    editor.saved = loaded
    editor.loaded = true
    editor.error = ''
    editor.refresh?.()
  }
  if (editor.tools.some((tool) => tool.id === spec.id)) return 'duplicate'
  editor.tools = [...editor.tools, JSON.parse(JSON.stringify(spec)) as ToolDraft]
  editor.refresh?.()
  return 'inserted'
}

/**
 * 这张卡的读数请求（主语＝该模块）：**声明面明确未声明就不构造这次请求**（返回 `undefined`），
 * 卡片据此转创建模式——服务端读了也是 400 `module-not-declared`。抽成函数是为了让「不发这次读」可被请求计数断言。
 */
export const readCustomTools = (moduleId: string, undeclared: boolean) =>
  undeclared ? undefined : bridgeCall('customTools', { expectedModuleId: moduleId }, moduleId)

/** 工具草稿与保存由常驻页面持有；设置区只渲染同一份编辑内容。 */
export function useCustomToolsEditor(props: {
  t: PromptToolTranslate
  onNotice: (kind: 'ok' | 'error', message: string) => void
  disabled?: boolean
  /** **主语由归属方给**：`moduleId` 是这张卡所属模块＝每次请求的主语（读、写、草稿表都按它）；
   *  没有归属模块时调用方不渲染本卡，草稿与请求都不会以空主语发出。 */
  moduleId?: string
  drafts?: WorkspaceDrafts
  onChooseTemplate?: (anchor: HTMLButtonElement) => void
  /** 声明面明确未声明 `customTools`（＝本卡处于「创建第一节」模式）：照旧不发这次读（发了也是 400）。 */
  undeclared?: boolean
  /** 创建模式下首次成功写盘后回调：调用方据此重读 `/meta`，卡片随即按正常形态出现。 */
  onDeclared?: () => void
}): { createTool: (intent: ToolCreateIntent) => void; content: ReactNode } {
  const { t } = props
  const moduleId = props.moduleId
  const undeclared = props.undeclared === true
  const editor = useMemo((): ToolsEditorDraft => {
    // 无主语：不建工具草稿（空串键会与真模块混用），给一份不落表的空草稿。
    if (moduleId === undefined) return createToolsEditorDraft()
    const retained = props.drafts?.tools.get(moduleId)
    if (retained !== undefined) return retained
    const next = createToolsEditorDraft()
    props.drafts?.tools.set(moduleId, next)
    return next
  }, [props.drafts, moduleId])
  const [tools, renderTools] = useState<ToolDraft[]>(editor.tools)
  const setTools = (next: ToolDraft[]): void => { editor.tools = next; renderTools(next) }
  const [expandedCards, renderExpanded] = useState(editor.expanded)
  const setExpandedCards = (next: Set<number>): void => { editor.expanded = next; renderExpanded(next) }
  const [hasPersistedTools, setHasPersistedTools] = useState(editor.saved.length > 0)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(!editor.loaded)
  const [loadError, setLoadError] = useState(editor.error)
  const [revision, setRevision] = useState(0)
  const disabled = props.disabled === true || loading || loadError.length > 0
  const activeEditor = useRef<ToolsEditorDraft | null>(editor)
  useEffect(() => {
    let active = true
    activeEditor.current = editor
    const refresh = (): void => {
      renderTools(editor.tools)
      renderExpanded(editor.expanded)
      setHasPersistedTools(editor.saved.length > 0)
      setSaving(editor.saving)
    }
    editor.refresh = refresh
    refresh()
    const cleanup = (): void => {
      active = false
      activeEditor.current = null
      if (editor.refresh === refresh) editor.refresh = undefined
    }
    // 无主语：不发模块类请求（卡片由 canEditSubject 判定为只读）。
    if (moduleId === undefined) { setLoading(false); setLoadError(''); return cleanup }
    const dirty = JSON.stringify(editor.tools) !== JSON.stringify(editor.saved)
      || [...editor.fields.values()].some((field) => field.text !== field.source || !!field.error)
    if (editor.loaded && (dirty || editor.saving) && revision === 0) {
      setLoading(false)
      setLoadError(editor.error)
      return cleanup
    }
    // 声明面明确未声明：本卡处于创建模式——**不构造这次读**（读了也是 400），
    // 草稿从空集开始，保存即由服务端建立该节。
    const customRequest = readCustomTools(moduleId, undeclared)
    if (customRequest === undefined) {
      editor.loaded = true
      setLoading(false)
      setLoadError('')
      return cleanup
    }
    setLoading(!editor.loaded)
    setLoadError('')
    const readingTools = editor.tools
    void (async () => {
      // 第三个实参 = `x-module-id`：主语＝这张卡所属的模块。服务端**没有任何回退**
      // （未声明就是没有目标，模块类端点按空目标拒绝），所以这个实参必须带，且只能带该模块的 id。
      const customResult = await customRequest
      if (!active) return
      if (!customResult.ok) {
        editor.error = customResult.message ?? t('customTools.loadFailed')
        setLoadError(editor.error)
        setLoading(false)
        return
      }
      if (dirty || editor.tools !== readingTools || [...editor.fields.values()].some((field) => field.text !== field.source || !!field.error)) {
        editor.error = ''
        setLoadError('')
        setLoading(false)
        return
      }
      const loadedTools = (customResult.ok ? customResult.value?.customTools ?? [] : []).map((tool) => asRecord(tool))
      setTools(loadedTools)
      editor.saved = loadedTools
      editor.loaded = true
      editor.error = ''
      setHasPersistedTools(loadedTools.length > 0)
      setLoading(false)
    })()
    return cleanup
  }, [editor, moduleId, revision, undeclared])
  const updateTools = (next: ToolDraft[]): void => {
    if (!disabled) setTools(next)
  }
  const save = (): void => {
    if (moduleId === undefined || disabled || editor.saving) return
    if ([...editor.fields.values()].some((field) => field.error || field.text !== field.source)) {
      props.onNotice('error', t('customTools.invalidDraft'))
      return
    }
    // 保存前清理：工具 parameters 的空 key 待编辑行（与 moduleVariables 保存端清理对齐）。
    const cleanTools = tools.map((tool) => {
      const params = asRecord(tool.parameters)
      const clean: ToolDraft = {}
      for (const [key, value] of Object.entries(params)) {
        if (key.trim().length === 0) continue
        clean[key] = value
      }
      const next = { ...tool }
      if (Object.keys(clean).length > 0) next.parameters = clean
      else delete next.parameters
      return next
    })
    setSaving(true)
    editor.saving = true
    void bridgeCall('customTools', { customTools: cleanTools, expectedModuleId: moduleId }, moduleId).then((customResult) => {
      editor.saving = false
      if (customResult.ok) editor.saved = tools
      editor.refresh?.()
      if (activeEditor.current !== editor) return
      setSaving(false)
      if (customResult.ok) {
        setHasPersistedTools(cleanTools.length > 0)
        props.onDeclared?.()
        props.onNotice('ok', t('customTools.saved', { count: cleanTools.length }))
      } else {
        props.onNotice('error', ('message' in customResult ? customResult.message : undefined) ?? t('customTools.saveFailed'))
      }
    })
  }
  const patchTool = (index: number, patch: Partial<ToolDraft>): void => {
    const previousId = String(tools[index]?.id ?? index)
    if (patch.id !== undefined && String(patch.id) !== previousId) {
      const prefix = `${previousId}:`
      const previousFields = [...editor.fields] // 重命名会向Map写入，必须遍历快照以免再次遍历新键。
      for (const [key, field] of previousFields) if (key.startsWith(prefix)) {
        editor.fields.set(`${String(patch.id)}:${key.slice(prefix.length)}`, field)
        editor.fields.delete(key)
      }
    }
    updateTools(tools.map((tool, at) => at === index ? { ...tool, ...patch } : tool))
  }
  const toggleCard = (index: number): void => {
    const next = new Set(expandedCards)
    if (next.has(index)) next.delete(index)
    else next.add(index)
    setExpandedCards(next)
  }
  /** 创建使用草稿当前值，连续点击即使尚未重渲染也不会相互覆盖。 */
  const createTool = (intent: ToolCreateIntent): void => {
    if (intent.moduleId !== undefined && intent.moduleId !== moduleId) return
    if (disabled || !editor.loaded) {
      props.onNotice('error', t(props.disabled ? 'customTools.readonly' : editor.error ? 'customTools.loadFailed' : 'customTools.loading'))
      return
    }
    const tools = editor.tools
    if (intent.kind === 'template' && intent.spec !== undefined) {
      const spec = intent.spec
      if (tools.some((tool) => tool.id === spec.id)) {
        props.onNotice('error', t('customTools.duplicateId', { id: String(spec.id) }))
        return
      }
      const clone = JSON.parse(JSON.stringify(spec)) as ToolDraft
      updateTools([...tools, clone])
      setExpandedCards(new Set([...editor.expanded, tools.length]))
      props.onNotice('ok', t('customTools.templateInserted', { id: String(spec.id) }))
      return
    }
    let suffix = 1
    while (tools.some((tool) => tool.id === `tool-${suffix}` || (tool.name ?? tool.id) === (suffix === 1 ? 'my_tool' : `my_tool_${suffix}`))) suffix += 1
    updateTools([...tools, {
      id: `tool-${suffix}`,
      name: suffix === 1 ? 'my_tool' : `my_tool_${suffix}`,
      description: '',
      output: { schema: { type: 'object', additionalProperties: true } },
      execute: { kind: 'shell', command: '' },
    }])
    setExpandedCards(new Set([...editor.expanded, tools.length]))
  }
  return { createTool, content: (
    <section aria-label={t('customTools.aria')}>
      <p className={styles.configFieldHint}>{t('customTools.hint')}</p>
      {undeclared && <p className={styles.configFieldHint} role="status">{t('declare.createHint')}</p>}
      {props.disabled && <p className={styles.configFieldHint} role="status">{t('customTools.readonly')}</p>}
      {loading && <p className={styles.configFieldHint} role="status">{t('customTools.loading')}</p>}
      {loadError && <p role="alert">{loadError} <Button shape="pill" size="md" variant="outline" type="button" onClick={() => setRevision((value) => value + 1)}>{t('customTools.retry')}</Button></p>}
      <fieldset className={styles.customToolsFields} aria-label={t('customTools.fieldsAria')}>
        <div className={styles.configActions}>
          <Button shape="pill" size="sm" variant="outline" type="button" disabled={disabled} onClick={() => createTool({ kind: 'blank', moduleId })}>{t('main.newBlankTool')}</Button>
          {props.onChooseTemplate !== undefined && <Button shape="pill" size="sm" variant="outline" type="button" disabled={disabled}
            onClick={(event) => { if (!disabled) props.onChooseTemplate?.(event.currentTarget) }}>{t('main.addToolTemplate')}</Button>}
          {(tools.length > 0 || hasPersistedTools) && (
            <Button type="button" variant="primary" size="sm" disabled={disabled || saving} onClick={save}>
              {saving ? t('customTools.saving') : t('customTools.save')}
            </Button>
          )}
        </div>
        {tools.length > 0 && (
          <div className={`${styles.configList} ${styles.customToolList}`}>
            {tools.map((tool, index) => (
              <CustomToolCard
                t={t}
                key={`${String(tool.id ?? '')}-${index}`}
                tool={tool}
                fieldDrafts={editor.fields}
                index={index}
                disabled={disabled}
                expanded={expandedCards.has(index)}
                onToggleExpanded={() => toggleCard(index)}
                onPatch={(patch) => patchTool(index, patch)}
                onToggleEnabled={(enabled) => patchTool(index, { enabled })}
                onMoveUp={() => updateTools(tools.map((item, at) => {
                  if (at === index) return tools[index - 1]!
                  if (at === index - 1) return tools[index]!
                  return item
                }))}
                onMoveDown={() => updateTools(tools.map((item, at) => {
                  if (at === index) return tools[index + 1]!
                  if (at === index + 1) return tools[index]!
                  return item
                }))}
                onDuplicate={() => updateTools([...tools.slice(0, index + 1), {
                  ...JSON.parse(JSON.stringify(tool)) as ToolDraft,
                  id: `${String(tool.id ?? 'tool')}-copy`,
                }, ...tools.slice(index + 1)])}
                onRemove={() => {
                  const prefix = `${String(tool.id ?? index)}:`
                  for (const key of editor.fields.keys()) if (key.startsWith(prefix)) editor.fields.delete(key)
                  updateTools(tools.filter((_, at) => at !== index))
                }}
                canMoveUp={index > 0}
                canMoveDown={index < tools.length - 1}
              />
            ))}
          </div>
        )}
      </fieldset>
    </section>
  ) }
}

/** 独立使用时仍由当前组件持有草稿，工作台通过页面钩子持有。 */
export function CustomToolsCard(props: Parameters<typeof useCustomToolsEditor>[0]): ReactNode {
  return useCustomToolsEditor(props).content
}
