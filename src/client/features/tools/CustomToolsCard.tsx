/** 工具管理（tool-pipeline 层）：自定义工具定义。 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '../../ui/Button.tsx'
import { bridgeCall } from '../../data/bridge-client.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import type { ToolsEditorDraft, WorkspaceDrafts } from '../../data/workspace-drafts.ts'
import { createToolsEditor, createToolsEditorDraft, readCustomTools } from '../../data/tools-editor.ts'
import { CustomToolCard, type ToolDraft } from './CustomToolEditor.tsx'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './tools.module.css'

const styles = { ...sharedCss, ...featureCss }

/** 所属层按钮直接提交的创建请求；草稿由常驻页面立即建立。 */
export type ToolCreateIntent = { kind: 'blank'; moduleId?: string }

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
  const [expandedCards, renderExpanded] = useState(editor.expanded)
  const setExpandedCards = (next: Set<number>): void => { editor.expanded = next; renderExpanded(next) }
  const [hasPersistedTools, setHasPersistedTools] = useState(editor.saved.length > 0)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(!editor.loaded)
  const [loadError, setLoadError] = useState(editor.error)
  const disabled = props.disabled === true || loading || loadError.length > 0
  // 卸载标记：应答回来时已卸载就不再改状态（owner 的 `isCurrent`）。
  const active = useRef(true)
  // owner 在渲染期建，但它的 `changed` 要调渲染镜像；镜像每次渲染重建，故用 ref 取最新的那个。
  const refreshRef = useRef<() => void>(() => {})
  const owner = useMemo(() => createToolsEditor(moduleId ?? '', editor, {
    // 第三个实参 = `x-module-id`：主语＝这张卡所属的模块。服务端**没有任何回退**
    // （未声明就是没有目标，模块类端点按空目标拒绝），所以这个实参必须带，且只能带该模块的 id。
    reader: { load: () => readCustomTools(moduleId ?? '', undeclared) },
    request: (body) => bridgeCall('customTools', body, moduleId ?? ''),
    isCurrent: () => active.current,
    changed: refreshRef.current,
    onDeclared: props.onDeclared,
  }), [editor, moduleId, undeclared, props.onDeclared])
  const refresh = useCallback((): void => {
    renderTools(editor.tools)
    renderExpanded(editor.expanded)
    setHasPersistedTools(editor.saved.length > 0)
    setSaving(editor.saving)
    setLoading(!editor.loaded)
    setLoadError(editor.error)
  }, [editor])
  refreshRef.current = refresh
  useEffect(() => {
    active.current = true
    // 模板入口由 data owner 写同一份草稿；它只能通过这里回到视图的渲染镜像。
    editor.refresh = refresh
    refresh()
    const cleanup = (): void => {
      active.current = false
      if (editor.refresh === refresh) editor.refresh = undefined
    }
    // 无主语：不发模块类请求（卡片由 canEditSubject 判定为只读）。
    if (moduleId === undefined) return cleanup
    void owner.load()
    return cleanup
  }, [editor, owner, refresh, moduleId])
  /** 工具改动只在可编辑时落到草稿；owner 负责草稿与重渲染。 */
  const updateTools = (next: ToolDraft[]): void => { if (!disabled) owner.mutate(next) }
  const save = (): void => {
    if (moduleId === undefined || disabled) return
    if ([...editor.fields.values()].some((field) => field.error || field.text !== field.source)) {
      props.onNotice('error', t('customTools.invalidDraft'))
      return
    }
    void owner.save().then((customResult) => {
      if (customResult === undefined || !customResult.ok) {
        props.onNotice('error', customResult === undefined ? t('customTools.saveFailed') : ('message' in customResult ? customResult.message : undefined) ?? t('customTools.saveFailed'))
        return
      }
      props.onNotice('ok', t('customTools.saved', { count: editor.saved.length }))
    })
  }
  const patchTool = (index: number, patch: Partial<ToolDraft>): void => owner.applyPatch(index, patch)
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
      {loadError && <p role="alert">{loadError} <Button shape="pill" size="md" variant="outline" type="button" onClick={() => { void owner.load() }}>{t('customTools.retry')}</Button></p>}
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
