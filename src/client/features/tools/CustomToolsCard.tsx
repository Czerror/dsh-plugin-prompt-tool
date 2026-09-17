/** 工具管理（tool-pipeline 层）：自定义工具定义。 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgeCall } from '../../data/bridge-client.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import type { ToolsEditorDraft, WorkspaceDrafts } from '../../data/workspace-drafts.ts'
import { CustomToolCard, asRecord, type ToolDraft } from './CustomToolEditor.tsx'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './tools.module.css'

const styles = { ...sharedCss, ...featureCss }

/** 「添加能力 / 工具模块」菜单下发的创建意图；每次请求一个新对象，消费后由页面清空。 */
export type ToolCreateIntent = { kind: 'blank' | 'template'; spec?: ToolDraft; presetId?: string }

/** 自定义工具编辑器：命令栏 + 一工具一卡，不再增加聚合卡片。 */
export function CustomToolsCard(props: {
  t: PromptToolTranslate
  onNotice: (kind: 'ok' | 'error', message: string) => void
  disabled?: boolean
  presetId?: string
  drafts?: WorkspaceDrafts
  /** 工具栏合并菜单的新建意图：空白工具 / 模板插入。 */
  createIntent?: ToolCreateIntent
  /** 意图已消费：页面清空状态，避免预设切换重挂载后重放旧意图。 */
  onIntentConsumed?: () => void
}): ReactNode {
  const { t } = props
  const editor = useMemo((): ToolsEditorDraft => {
    const key = props.presetId ?? ''
    const retained = props.drafts?.tools.get(key)
    if (retained !== undefined) return retained
    const next: ToolsEditorDraft = { tools: [], saved: [], expanded: new Set(), fields: new Map(), loaded: false, error: '', saving: false }
    props.drafts?.tools.set(key, next)
    return next
  }, [props.drafts, props.presetId])
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
    const dirty = JSON.stringify(editor.tools) !== JSON.stringify(editor.saved)
      || [...editor.fields.values()].some((field) => field.text !== field.source || !!field.error)
    if (editor.loaded && (dirty || editor.saving) && revision === 0) {
      setLoading(false)
      setLoadError(editor.error)
      return cleanup
    }
    setLoading(!editor.loaded)
    setLoadError('')
    const readingTools = editor.tools
    void (async () => {
      const customResult = await bridgeCall('customTools', { expectedPresetId: props.presetId })
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
  }, [editor, revision])
  const updateTools = (next: ToolDraft[]): void => {
    if (!disabled) setTools(next)
  }
  const save = (): void => {
    if (disabled || editor.saving) return
    if ([...editor.fields.values()].some((field) => field.error || field.text !== field.source)) {
      props.onNotice('error', t('customTools.invalidDraft'))
      return
    }
    // 保存前清理：工具 parameters 的空 key 待编辑行（与 presetVariables 保存端清理对齐）。
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
    void bridgeCall('customTools', { customTools: cleanTools, expectedPresetId: props.presetId }).then((customResult) => {
      editor.saving = false
      if (customResult.ok) editor.saved = tools
      editor.refresh?.()
      if (activeEditor.current !== editor) return
      setSaving(false)
      if (customResult.ok) {
        setHasPersistedTools(cleanTools.length > 0)
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
  /** 菜单创建意图：同一对象只消费一次；工具草稿仍只经受保护的 updateTools 更新。 */
  const handledIntentRef = useRef<ToolCreateIntent | undefined>(undefined)
  useEffect(() => {
    const intent = props.createIntent
    if (intent === undefined || intent === handledIntentRef.current) return
    if (intent.presetId !== undefined && intent.presetId !== props.presetId) {
      handledIntentRef.current = intent
      props.onIntentConsumed?.()
      return
    }
    if (disabled) return
    handledIntentRef.current = intent
    props.onIntentConsumed?.()
    if (intent.kind === 'template' && intent.spec !== undefined) {
      const spec = intent.spec
      if (tools.some((tool) => tool.id === spec.id)) {
        props.onNotice('error', t('customTools.duplicateId', { id: String(spec.id) }))
        return
      }
      const clone = JSON.parse(JSON.stringify(spec)) as ToolDraft
      updateTools([...tools, clone])
      setExpandedCards(new Set([...expandedCards, tools.length]))
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
    setExpandedCards(new Set([...expandedCards, tools.length]))
  }, [disabled, expandedCards, props, tools])
  return (
    <section aria-label={t('customTools.aria')}>
      <p className={styles.configFieldHint}>{t('customTools.hint')}</p>
      {props.disabled && <p className={styles.configFieldHint} role="status">{t('customTools.readonly')}</p>}
      {loading && <p className={styles.configFieldHint} role="status">{t('customTools.loading')}</p>}
      {loadError && <p role="alert">{loadError} <button type="button" className={styles.pillButton} onClick={() => setRevision((value) => value + 1)}>{t('customTools.retry')}</button></p>}
      <fieldset className={styles.customToolsFields} aria-label={t('customTools.fieldsAria')}>
        <div className={styles.configActions}>
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
  )
}
