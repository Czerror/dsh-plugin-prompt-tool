/** 工具管理（tool-pipeline 层）：自定义工具定义 + 第三方策略入口。
 *  数据源 preset.yml customTools 段（/custom-tools）；工具卡片表单化编辑
 *  （kind 专属字段），parameters 行式编辑。内置工具由对应 modules 按预设装配，
 *  自定义面走 delegate 模板包装（无需开关/描述配置）。 */
import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgeCall } from './data/bridge-client.ts'
import { Field } from './PromptConfigCard.tsx'
import { TemplatePicker } from './TemplatePicker.tsx'
import { ToolSurfaceView } from './ToolSurfaceView.tsx'
import styles from './PromptUi.module.css'

/** 内置工具名（delegate 提示）。 */
const BUILTIN_TOOL_NAMES = ['character_list', 'character_import', 'character_apply', 'character_remove', 'character_delete',
  'world_book_list', 'world_book_upsert', 'world_book_delete', 'session_var']

const KIND_OPTIONS = ['shell', 'http', 'delegate', 'fs', 'ask-user'] as const
const FS_ACTIONS = ['read', 'write', 'append', 'list', 'delete'] as const
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const
const SHELLS = ['pwsh', 'powershell', 'cmd', 'sh', 'bash'] as const
const SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'json'] as const

type ToolDraft = Record<string, unknown>

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** parameters 行式编辑：key + type 下拉 + required 开关 + description，可增删。 */
function ParameterRowsEditor(props: { value: ToolDraft | undefined; onChange: (value: ToolDraft | undefined) => void }): ReactNode {
  const params = asRecord(props.value)
  const rows = Object.entries(params).map(([key, spec]) => {
    const record = asRecord(spec)
    return {
      key,
      type: typeof record.type === 'string' ? record.type : 'string',
      required: record.required === true,
      description: typeof record.description === 'string' ? record.description : '',
    }
  })
  const commit = (next: Array<{ key: string; type: string; required: boolean; description: string }>): void => {
    const out: ToolDraft = {}
    for (const row of next) {
      // 保留空 key 行（「添加参数」新增的待编辑行）；空 key 由保存端（save）统一清理，
      // 与 VariablesEditor 同语义——否则添加/清空 key 瞬间行被过滤，按钮失效。
      out[row.key] = {
        type: row.type,
        ...(row.required ? { required: true } : {}),
        ...(row.description.trim().length > 0 ? { description: row.description } : {}),
      }
    }
    props.onChange(Object.keys(out).length > 0 ? out : undefined)
  }
  const setRow = (index: number, patch: Partial<{ key: string; type: string; required: boolean; description: string }>): void => {
    commit(rows.map((row, at) => at === index ? { ...row, ...patch } : row))
  }
  return (
    <span className={styles.configFieldStack}>
      <span className={styles.configFieldLabel}>parameters（模型可见参数 schema）</span>
      {rows.length === 0 && <p className={styles.configFieldHint}>{'无参数；下方添加。required=true 时模型必须提供该参数。'}</p>}
      {rows.map((row, index) => (
        <span key={`${row.key}-${index}`} className={styles.variableRow}>
          <input className={styles.configInput} aria-label="参数名" value={row.key} spellCheck={false} placeholder="参数名"
            onChange={(e) => setRow(index, { key: e.target.value })} />
          <select className={styles.configInput} aria-label="参数类型" value={row.type}
            onChange={(e) => setRow(index, { type: e.target.value })}>
            {SCHEMA_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
          <label className={styles.configEnable} title="required">
            <input type="checkbox" aria-label="必填" checked={row.required}
              onChange={(e) => setRow(index, { required: e.target.checked })} />
            <span className={styles.switch} aria-hidden="true"><i /></span>
          </label>
          <input className={styles.configInput} aria-label="参数描述" value={row.description} spellCheck={false} placeholder="描述"
            onChange={(e) => setRow(index, { description: e.target.value })} />
          <button type="button" className={styles.pillButton} data-danger aria-label={`删除参数 ${row.key || index}`}
            onClick={() => commit(rows.filter((_, at) => at !== index))}>删除</button>
        </span>
      ))}
      <span>
        <button type="button" className={styles.pillButton} onClick={() => commit([...rows, { key: '', type: 'string', required: false, description: '' }])}>
          添加参数
        </button>
      </span>
    </span>
  )
}

/** 单张工具卡片（对齐模块列表卡片形态）：header（enabled 开关 + chips + 上移/下移/复制/两段式删除）+ Field 表单。 */
function CustomToolCard(props: {
  tool: ToolDraft
  index: number
  expanded: boolean
  onToggleExpanded: () => void
  onPatch: (patch: Partial<ToolDraft>) => void
  onToggleEnabled: (enabled: boolean) => void
  onMoveUp: () => void
  onMoveDown: () => void
  onDuplicate: () => void
  onRemove: () => void
  canMoveUp: boolean
  canMoveDown: boolean
}): ReactNode {
  const { tool, index } = props
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const execute = asRecord(tool.execute)
  const kind = typeof execute.kind === 'string' ? execute.kind : 'shell'
  const name = typeof tool.name === 'string' ? tool.name : ''
  const id = typeof tool.id === 'string' ? tool.id : `tool-${index + 1}`
  const description = typeof tool.description === 'string' ? tool.description : ''
  const enabled = tool.enabled !== false
  const paramCount = Object.keys(asRecord(tool.parameters)).length
  const chips = [kind]
  if (paramCount > 0) chips.push(`${paramCount} 参数`)
  if (Number.isSafeInteger(tool.timeoutMs) && (tool.timeoutMs as number) > 0) chips.push(`timeout=${tool.timeoutMs}`)
  const patchExecute = (patch: Record<string, unknown>): void => {
    props.onPatch({ execute: { ...execute, ...patch } })
  }
  const patchJson = (field: string, value: ToolDraft | undefined): void => {
    props.onPatch({ [field]: value ?? {} })
  }
  return (
    <article className={clsx(styles.configCard, props.expanded && styles.configCardOpen)}>
      <header className={styles.configHeader}>
        <button type="button" className={styles.configToggle} aria-expanded={props.expanded} onClick={props.onToggleExpanded}>
          <span className={styles.configTitle}>
            <span className={styles.configTitleRow}>
              <span className={styles.configName}>{name.length > 0 ? `${id} · ${name}` : id}</span>
              <span className={styles.configChip}>{kind}</span>
            </span>
            <span className={styles.configMeta}>{description || '（无描述）'}{chips.length > 1 && ` · ${chips.slice(1).join(' · ')}`}</span>
          </span>
          <IconChevronDownOutline14 className={clsx(styles.chevron, props.expanded && styles.chevronOpen)} />
        </button>
        <span className={styles.configHeaderActions}>
          <label className={styles.configEnable} title={enabled ? '点击停用（enabled=false 不注册）' : '点击启用'}>
            <input type="checkbox" aria-label={`启用工具 ${id}`} checked={enabled}
              onChange={(e) => props.onToggleEnabled(e.target.checked)} />
            <span className={styles.switch} aria-hidden="true"><i /></span>
          </label>
          <span className={styles.configActions}>
            <button type="button" className={styles.pillButton} disabled={!props.canMoveUp} onClick={props.onMoveUp}>上移</button>
            <button type="button" className={styles.pillButton} disabled={!props.canMoveDown} onClick={props.onMoveDown}>下移</button>
            <button type="button" className={styles.pillButton} onClick={props.onDuplicate}>复制</button>
            {confirmingDelete ? (
              <>
                <button type="button" className={styles.pillButton} data-danger onClick={props.onRemove}>确认删除</button>
                <button type="button" className={styles.pillButton} data-variant="secondary" onClick={() => setConfirmingDelete(false)}>取消</button>
              </>
            ) : (
              <button type="button" className={styles.pillButton} data-danger onClick={() => setConfirmingDelete(true)}>删除</button>
            )}
          </span>
        </span>
      </header>
      {props.expanded && (
        <div className={styles.configForm}>
          <span className={styles.variableRow}>
            <Field label="id（文件标识）">
              <input className={styles.configInput} aria-label="工具 id" value={id} spellCheck={false}
                onChange={(e) => props.onPatch({ id: e.target.value })} />
            </Field>
            <Field label="name（模型可见名）">
              <input className={styles.configInput} aria-label="工具名" value={name} spellCheck={false} placeholder="my_tool"
                onChange={(e) => props.onPatch({ name: e.target.value })} />
            </Field>
          </span>
          <Field label="description（模型可见描述）">
            <textarea className={styles.configTextarea} rows={2} aria-label="工具描述" value={description} spellCheck={false}
              placeholder="描述该工具给模型看"
              onChange={(e) => props.onPatch({ description: e.target.value })} />
          </Field>
          <Field label="execute.kind（执行器）" hint="shell=命令；http=请求；delegate=委托内置/已注册工具；fs=工作区文件；ask-user=询问用户">
            <select className={styles.configInput} aria-label="执行器" value={kind}
              onChange={(e) => patchExecute({ kind: e.target.value })}>
              {KIND_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </Field>
          {kind === 'shell' && (
            <>
              <Field label="command" hint={'{{args.x}} 参数插值；env 白名单；cwd=会话工作区'}>
                <textarea className={styles.configTextarea} rows={3} aria-label="shell 命令" spellCheck={false}
                  value={typeof execute.command === 'string' ? execute.command : ''} placeholder="Write-Output {{args.x}}"
                  onChange={(e) => patchExecute({ command: e.target.value })} />
              </Field>
              <Field label="shell" hint="pwsh 强制 UTF-8 输出（中文不乱码）">
                <select className={styles.configInput} aria-label="shell"
                  value={typeof execute.shell === 'string' ? execute.shell : 'pwsh'}
                  onChange={(e) => patchExecute({ shell: e.target.value })}>
                  {SHELLS.map((shell) => <option key={shell} value={shell}>{shell}</option>)}
                </select>
              </Field>
            </>
          )}
          {kind === 'http' && (
            <>
              <Field label="url" hint={'{{args.x}} 参数插值'}>
                <input className={styles.configInput} aria-label="请求 URL" spellCheck={false}
                  value={typeof execute.url === 'string' ? execute.url : ''} placeholder="https://…/{{args.q}}"
                  onChange={(e) => patchExecute({ url: e.target.value })} />
              </Field>
              <Field label="method">
                <select className={styles.configInput} aria-label="请求方法"
                  value={typeof execute.method === 'string' ? execute.method : 'GET'}
                  onChange={(e) => patchExecute({ method: e.target.value })}>
                  {HTTP_METHODS.map((method) => <option key={method} value={method}>{method}</option>)}
                </select>
              </Field>
            </>
          )}
          {kind === 'delegate' && (
            <Field label="tool（委托目标）" hint={`内置工具：${BUILTIN_TOOL_NAMES.join(' / ')}`}>
              <input className={styles.configInput} aria-label="委托目标工具" spellCheck={false}
                value={typeof execute.tool === 'string' ? execute.tool : ''} placeholder="world_book_upsert"
                onChange={(e) => patchExecute({ tool: e.target.value })} />
            </Field>
          )}
          {kind === 'fs' && (
            <>
              <Field label="action">
                <select className={styles.configInput} aria-label="fs 动作"
                  value={typeof execute.action === 'string' && (FS_ACTIONS as readonly string[]).includes(execute.action) ? execute.action : 'read'}
                  onChange={(e) => patchExecute({ action: e.target.value })}>
                  {FS_ACTIONS.map((action) => <option key={action} value={action}>{action}</option>)}
                </select>
              </Field>
              <Field label="path" hint="相对工作区路径；越界拒绝">
                <input className={styles.configInput} aria-label="文件路径" spellCheck={false}
                  value={typeof execute.path === 'string' ? execute.path : ''} placeholder="data/{{args.name}}.json"
                  onChange={(e) => patchExecute({ path: e.target.value })} />
              </Field>
            </>
          )}
          {kind === 'ask-user' && (
            <Field label="question（向用户确认的问题）">
              <input className={styles.configInput} aria-label="询问问题" spellCheck={false}
                value={typeof execute.question === 'string' ? execute.question : ''} placeholder="是否继续执行该操作？"
                onChange={(e) => patchExecute({ question: e.target.value })} />
            </Field>
          )}
          <ParameterRowsEditor
            value={asRecord(tool.parameters)}
            onChange={(next) => props.onPatch({ parameters: next })}
          />
          <Field label="output.schema（JSON；默认开放对象）">
            <textarea className={styles.configTextarea} rows={4} aria-label="输出 schema JSON" spellCheck={false}
              value={JSON.stringify(asRecord(tool.output), null, 2) === '{}' ? '' : JSON.stringify(asRecord(tool.output), null, 2)}
              onChange={(e) => {
                const text = e.target.value.trim()
                if (text.length === 0) { props.onPatch({ output: { schema: { type: 'object', additionalProperties: true } } }); return }
                try { patchJson('output', JSON.parse(text) as ToolDraft) } catch { /* 解析失败不落盘 */ }
              }} />
          </Field>
        </div>
      )}
    </article>
  )
}
/** 工具管理区块（tool-pipeline 层可见）：标题 + 工具卡片列表。 */
export function CustomToolsModuleCard(props: {
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
