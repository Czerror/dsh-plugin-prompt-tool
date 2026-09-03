/** 工具管理（tool-pipeline 层）：自定义工具定义与实际工具面。 */
import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgeCall } from '../../data/bridge-client.ts'
import { TemplatePicker } from '../../ui/TemplatePicker.tsx'
import { CustomToolCard, asRecord, type ToolDraft } from './CustomToolEditor.tsx'
import { ToolSurfaceView } from './ToolSurfaceView.tsx'
import styles from '../../PromptUi.module.css'
/** 工具管理区块（tool-pipeline 层可见）：标题 + 工具卡片列表。 */
export function CustomToolsCard(props: {
  expanded: boolean
  onToggleExpanded: () => void
  onNotice: (kind: 'ok' | 'error', message: string) => void
  /** 当前主会话 session id（客户端从官方 sessions snapshot 取，不持久化；缺省 = 手动输入）。 */
  sessionId?: string
}): ReactNode {
  const [tools, setTools] = useState<ToolDraft[]>([])
  const [toolTemplates, setToolTemplates] = useState<Array<{ file: string; spec: ToolDraft }>>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [expandedCards, setExpandedCards] = useState<Set<number>>(new Set())
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [surfaceSessionId, setSurfaceSessionId] = useState(props.sessionId ?? '')
  useEffect(() => { setSurfaceSessionId(props.sessionId ?? '') }, [props.sessionId])
  useEffect(() => {
    if (loaded || !props.expanded) return
    void (async () => {
      const [customResult, templatesResult] = await Promise.all([
        bridgeCall('customTools', {}),
        bridgeCall('templates'),
      ])
      setTools((customResult.ok ? customResult.value?.customTools ?? [] : []).map((tool) => asRecord(tool)))
      setToolTemplates(templatesResult.ok ? (templatesResult.value.toolTemplates ?? []) as Array<{ file: string; spec: ToolDraft }> : [])
      setLoaded(true)
    })()
  }, [props.expanded, loaded])
  const save = (): void => {
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
    void bridgeCall('customTools', { customTools: cleanTools }).then((customResult) => {
      setSaving(false)
      if (customResult.ok) {
        props.onNotice('ok', `已保存 ${tools.length} 个自定义工具（已重建）`)
      } else {
        props.onNotice('error', ('message' in customResult ? customResult.message : undefined) ?? '保存失败')
      }
    })
  }
  const insertTemplate = (spec: ToolDraft): void => {
    if (tools.some((tool) => tool.id === spec.id)) {
      props.onNotice('error', `工具 id 已存在：${String(spec.id)}`)
      return
    }
    const clone = JSON.parse(JSON.stringify(spec)) as ToolDraft
    setTools([...tools, clone])
    setExpandedCards(new Set([...expandedCards, tools.length]))
    props.onNotice('ok', `已插入工具模板 ${String(spec.id)}（保存后生效）`)
    setPickerOpen(false)
  }
  const patchTool = (index: number, patch: Partial<ToolDraft>): void => {
    setTools(tools.map((tool, at) => at === index ? { ...tool, ...patch } : tool))
  }
  const toggleCard = (index: number): void => {
    const next = new Set(expandedCards)
    if (next.has(index)) next.delete(index)
    else next.add(index)
    setExpandedCards(next)
  }
  return (
    <section aria-label="自定义工具">
      <div className={clsx(styles.sectionHeading, styles.toolHeading)}>
        <div>
          <h2>
            <button type="button" className={styles.configToggle} aria-expanded={props.expanded} onClick={props.onToggleExpanded}>
              <span className={styles.configName}>自定义工具<span className={styles.toolHeadingDot} aria-hidden="true" /></span>
              <IconChevronDownOutline14 className={clsx(styles.chevron, props.expanded && styles.chevronOpen)} />
            </button>
          </h2>
          <p>{`${tools.length} 个自定义工具 · 第三方策略见下方模块卡片`}</p>
        </div>
        <span className={styles.configActions}>
          <button type="button" className={styles.pillButton} onClick={() => setPickerOpen(true)}>从模板新建</button>
          <button type="button" className={styles.pillButton}
            onClick={() => setTools([...tools, {
              id: `tool-${tools.length + 1}`,
              name: 'my_tool',
              description: '',
              output: { schema: { type: 'object', additionalProperties: true } },
              execute: { kind: 'shell', command: '' },
            }])}>
            添加工具
          </button>
          <button type="button" className={styles.primaryPill} disabled={saving} onClick={save}>
            {saving ? '保存中…' : '保存'}
          </button>
        </span>
      </div>
      {props.expanded && (
        <div className={styles.configList} style={{ marginTop: 10 }}>
          <div className={styles.settingRowStack} style={{ border: '1px solid rgba(128,128,128,0.2)', borderRadius: 8, padding: 8 }}>
            <span className={styles.settingCopy}>
              <strong>当前主会话实际工具面（只读）</strong>
              <small>来自 /tool-surface：只返回存活本地 Agent 的 name/description；无会话显示空态。</small>
            </span>
            <ToolSurfaceView sessionId={surfaceSessionId} label="主会话" />
          </div>
          {tools.map((tool, index) => (
            <CustomToolCard
              key={`${String(tool.id ?? '')}-${index}`}
              tool={tool}
              index={index}
              expanded={expandedCards.has(index)}
              onToggleExpanded={() => toggleCard(index)}
              onPatch={(patch) => patchTool(index, patch)}
              onToggleEnabled={(enabled) => patchTool(index, { enabled })}
              onMoveUp={() => setTools(tools.map((item, at) => {
                if (at === index) return tools[index - 1]!
                if (at === index - 1) return tools[index]!
                return item
              }))}
              onMoveDown={() => setTools(tools.map((item, at) => {
                if (at === index) return tools[index + 1]!
                if (at === index + 1) return tools[index]!
                return item
              }))}
              onDuplicate={() => setTools([...tools.slice(0, index + 1), {
                ...JSON.parse(JSON.stringify(tool)) as ToolDraft,
                id: `${String(tool.id ?? 'tool')}-copy`,
              }, ...tools.slice(index + 1)])}
              onRemove={() => setTools(tools.filter((_, at) => at !== index))}
              canMoveUp={index > 0}
              canMoveDown={index < tools.length - 1}
            />
          ))}
          {tools.length === 0 && <p className={styles.configFieldHint}>{'无自定义工具；从模板新建或直接添加。'}</p>}
        </div>
      )}
      {pickerOpen && (
        <TemplatePicker
          templates={[]}
          toolTemplates={toolTemplates}
          onPick={() => {}}
          onPickTool={insertTemplate}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </section>
  )
}
