/** 工具管理（tool-pipeline 层）：自定义工具定义。 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { bridgeCall } from '../../data/bridge-client.ts'
import { TemplatePicker } from '../../ui/TemplatePicker.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { CustomToolCard, asRecord, type ToolDraft } from './CustomToolEditor.tsx'
import { ToolSurfaceView } from './ToolSurfaceView.tsx'
import sharedCss from '../../ui/controls.module.css'

const styles = sharedCss
/** 自定义工具编辑器：命令栏 + 一工具一卡，不再增加聚合卡片。 */
export function CustomToolsCard(props: {
  onNotice: (kind: 'ok' | 'error', message: string) => void
  /** 当前主会话 session id（客户端从官方 sessions snapshot 取，不持久化）。 */
  sessionId?: string
  presetId?: string
  listAgentPresets?: () => Promise<Array<{ id: string; name?: string; description?: string; trust?: 'system' | 'user' }>>
}): ReactNode {
  const templateAnchorRef = useRef<HTMLButtonElement>(null)
  const [tools, setTools] = useState<ToolDraft[]>([])
  const [toolTemplates, setToolTemplates] = useState<Array<{ file: string; spec: ToolDraft }>>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [expandedCards, setExpandedCards] = useState<Set<number>>(new Set())
  const [hasPersistedTools, setHasPersistedTools] = useState(false)
  const [saving, setSaving] = useState(false)
  const [presetOptions, setPresetOptions] = useState<Array<{ id: string; name?: string; description?: string; trust?: 'system' | 'user' }>>([])
  const [selectedPresetId, setSelectedPresetId] = useState(props.presetId ?? '')
  useEffect(() => {
    void (async () => {
      const [customResult, templatesResult, presets] = await Promise.all([
        bridgeCall('customTools', {}),
        bridgeCall('templates'),
        props.listAgentPresets?.() ?? Promise.resolve([]),
      ])
      const loadedTools = (customResult.ok ? customResult.value?.customTools ?? [] : []).map((tool) => asRecord(tool))
      setTools(loadedTools)
      setHasPersistedTools(loadedTools.length > 0)
      setToolTemplates(templatesResult.ok ? (templatesResult.value.toolTemplates ?? []) as Array<{ file: string; spec: ToolDraft }> : [])
      setPresetOptions(presets)
      setSelectedPresetId((current) => presets.some((preset) => preset.id === current) ? current : presets[0]?.id ?? '')
    })()
  }, [props.listAgentPresets])
  useEffect(() => {
    if (props.presetId !== undefined) setSelectedPresetId(props.presetId)
  }, [props.presetId])
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
        setHasPersistedTools(cleanTools.length > 0)
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
  const customNames = tools.map((tool) => {
    const id = typeof tool.id === 'string' ? tool.id : ''
    return typeof tool.name === 'string' && tool.name.trim().length > 0 ? tool.name.trim() : id
  }).filter((name) => name.length > 0)
  return (
    <section aria-label="工具管线">
      <ToolSurfaceView sessionId={props.sessionId ?? ''} label="当前会话工具" hiddenNames={customNames} />
      <div className={styles.settingRowStack}>
        <span className={styles.settingCopy}>
          <strong>预设工具能力</strong>
          <small>官方 roster + standing composition 的只读预览；同名自定义工具以编辑卡为准。</small>
        </span>
        <div className={styles.sessionModelRow}>
          <MenuSelect
            ariaLabel="预设工具能力来源"
            value={selectedPresetId}
            disabled={presetOptions.length === 0}
            options={presetOptions.map((preset) => ({
              value: preset.id,
              label: `${preset.name ?? preset.id}${preset.trust === undefined ? '' : ` · ${preset.trust}`}`,
            }))}
            onChange={setSelectedPresetId}
          />
        </div>
        {selectedPresetId.length > 0 && <ToolSurfaceView presetId={selectedPresetId} label="预设工具能力" hiddenNames={customNames} />}
        {presetOptions.length === 0 && <p className={styles.configFieldHint}>官方预设 roster 不可用或尚未就绪。</p>}
      </div>
      <div className={styles.configActions}>
        <button ref={templateAnchorRef} type="button" className={styles.pillButton} onClick={() => setPickerOpen(true)}>从模板新建</button>
        <button type="button" className={styles.pillButton}
          onClick={() => setTools([...tools, {
            id: `tool-${tools.length + 1}`,
            name: 'my_tool',
            description: '',
            output: { schema: { type: 'object', additionalProperties: true } },
            execute: { kind: 'shell', command: '' },
          }])}>
          新建工具
        </button>
        {(tools.length > 0 || hasPersistedTools) && (
          <button type="button" className={styles.primaryPill} disabled={saving} onClick={save}>
            {saving ? '保存中…' : '保存'}
          </button>
        )}
      </div>
      {tools.length > 0 && (
        <div className={styles.configList} style={{ marginTop: 10 }}>
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
        </div>
      )}
      {pickerOpen && (
        <TemplatePicker
          anchorRef={templateAnchorRef}
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
