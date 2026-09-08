/** 工具管理（tool-pipeline 层）：自定义工具定义。 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { bridgeCall } from '../../data/bridge-client.ts'
import { CustomToolCard, asRecord, type ToolDraft } from './CustomToolEditor.tsx'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './tools.module.css'

const styles = { ...sharedCss, ...featureCss }

/** 「添加能力 / 工具模块」菜单下发的创建意图；每次请求一个新对象，消费后由页面清空。 */
export type ToolCreateIntent = { kind: 'blank' | 'template'; spec?: ToolDraft }

/** 自定义工具编辑器：命令栏 + 一工具一卡，不再增加聚合卡片。 */
export function CustomToolsCard(props: {
  onNotice: (kind: 'ok' | 'error', message: string) => void
  disabled?: boolean
  presetId?: string
  /** 工具栏合并菜单的新建意图：空白工具 / 模板插入。 */
  createIntent?: ToolCreateIntent
  /** 意图已消费：页面清空状态，避免预设切换重挂载后重放旧意图。 */
  onIntentConsumed?: () => void
}): ReactNode {
  const [tools, setTools] = useState<ToolDraft[]>([])
  const [expandedCards, setExpandedCards] = useState<Set<number>>(new Set())
  const [hasPersistedTools, setHasPersistedTools] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [revision, setRevision] = useState(0)
  const disabled = props.disabled === true || loading || loadError.length > 0
  useEffect(() => {
    let active = true
    setLoading(true)
    setLoadError('')
    void (async () => {
      const customResult = await bridgeCall('customTools', { expectedPresetId: props.presetId })
      if (!active) return
      if (!customResult.ok) {
        setLoadError(customResult.message ?? '自定义工具读取失败')
        setLoading(false)
        return
      }
      const loadedTools = (customResult.ok ? customResult.value?.customTools ?? [] : []).map((tool) => asRecord(tool))
      setTools(loadedTools)
      setHasPersistedTools(loadedTools.length > 0)
      setLoading(false)
    })()
    return () => { active = false }
  }, [props.presetId, revision])
  const updateTools = (next: ToolDraft[]): void => {
    if (!disabled) setTools(next)
  }
  const save = (): void => {
    if (disabled || saving) return
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
    void bridgeCall('customTools', { customTools: cleanTools, expectedPresetId: props.presetId }).then((customResult) => {
      setSaving(false)
      if (customResult.ok) {
        setHasPersistedTools(cleanTools.length > 0)
        props.onNotice('ok', `已保存 ${tools.length} 个自定义工具（已重建）`)
      } else {
        props.onNotice('error', ('message' in customResult ? customResult.message : undefined) ?? '保存失败')
      }
    })
  }
  const patchTool = (index: number, patch: Partial<ToolDraft>): void => {
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
    if (disabled) return
    handledIntentRef.current = intent
    props.onIntentConsumed?.()
    if (intent.kind === 'template' && intent.spec !== undefined) {
      const spec = intent.spec
      if (tools.some((tool) => tool.id === spec.id)) {
        props.onNotice('error', `工具 id 已存在：${String(spec.id)}`)
        return
      }
      const clone = JSON.parse(JSON.stringify(spec)) as ToolDraft
      updateTools([...tools, clone])
      setExpandedCards(new Set([...expandedCards, tools.length]))
      props.onNotice('ok', `已插入工具模板 ${String(spec.id)}（保存后生效）`)
      return
    }
    updateTools([...tools, {
      id: `tool-${tools.length + 1}`,
      name: 'my_tool',
      description: '',
      output: { schema: { type: 'object', additionalProperties: true } },
      execute: { kind: 'shell', command: '' },
    }])
  }, [disabled, expandedCards, props, tools])
  return (
    <section aria-label="自定义工具编辑">
      <p className={styles.configFieldHint}>经顶部「添加能力 / 工具模块」新建或从模板插入工具；模型可见工具请到顶层「工具预览」查看。</p>
      {props.disabled && <p className={styles.configFieldHint} role="status">当前预设工具只读；system 预设或未启用预设写入时不能编辑或保存。</p>}
      {loading && <p className={styles.configFieldHint} role="status">正在读取自定义工具…</p>}
      {loadError && <p role="alert">{loadError} <button type="button" className={styles.pillButton} onClick={() => setRevision((value) => value + 1)}>重试读取</button></p>}
      {/* 只读切换重挂子树，释放已打开的 portal 菜单；无需给编辑器逐字段增加接口。 */}
      <fieldset key={disabled ? 'readonly' : 'editable'} className={styles.customToolsFields} disabled={disabled} aria-label="自定义工具配置">
        <div className={styles.configActions}>
          {(tools.length > 0 || hasPersistedTools) && (
            <button type="button" className={styles.primaryPill} disabled={disabled || saving} onClick={save}>
              {saving ? '保存中…' : '保存'}
            </button>
          )}
        </div>
        {tools.length > 0 && (
          <div className={`${styles.configList} ${styles.customToolList}`}>
            {tools.map((tool, index) => (
              <CustomToolCard
                key={`${String(tool.id ?? '')}-${index}`}
                tool={tool}
                index={index}
                expanded={props.disabled === true || expandedCards.has(index)}
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
                onRemove={() => updateTools(tools.filter((_, at) => at !== index))}
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
