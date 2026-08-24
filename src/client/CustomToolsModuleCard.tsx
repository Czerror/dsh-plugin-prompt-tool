/** 自定义工具模块卡片体系：区块 + 工具卡片 + 参数行式编辑（模块列表管理模式）。
 *  数据源 preset.yml customTools 段（/custom-tools）+ builtinTools 段（/builtin-tools）；
 *  工具卡片表单化编辑（kind 专属字段），parameters 行式编辑替代 JSON。 */
import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgePost } from './prompt-tool-bridge.ts'
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
      if (row.key.trim().length === 0) continue
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

/** 单张工具卡片（configCard 形态）：header（name + meta chip）+ 表单（kind 专属字段）。 */
function CustomToolCard(props: {
  tool: ToolDraft
  index: number
  expanded: boolean
  onToggleExpanded: () => void
  onPatch: (patch: Partial<ToolDraft>) => void
  onRemove: () => void
}): ReactNode {
  const { tool, index } = props
  const execute = asRecord(tool.execute)
  const kind = typeof execute.kind === 'string' ? execute.kind : 'shell'
  const name = typeof tool.name === 'string' ? tool.name : ''
  const id = typeof tool.id === 'string' ? tool.id : `tool-${index + 1}`
  const description = typeof tool.description === 'string' ? tool.description : ''
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
            <span className={styles.configMeta}>{description || '（无描述）'}</span>
          </span>
          <IconChevronDownOutline14 className={clsx(styles.chevron, props.expanded && styles.chevronOpen)} />
        </button>
        <span className={styles.configHeaderActions}>
          <span className={styles.configActions}>
            <button type="button" className={styles.pillButton} data-danger onClick={props.onRemove}>删除</button>
          </span>
        </span>
      </header>
      {props.expanded && (
        <div className={styles.configForm}>
          <span className={styles.configFieldStack}>
            <span className={styles.configFieldLabel}>id / name（模型可见名 ^[a-z][a-z0-9_]*$）</span>
            <span className={styles.variableRow}>
              <input className={styles.configInput} aria-label="工具 id" value={id} spellCheck={false}
                onChange={(e) => props.onPatch({ id: e.target.value })} />
              <input className={styles.configInput} aria-label="工具名" value={name} spellCheck={false} placeholder="my_tool"
                onChange={(e) => props.onPatch({ name: e.target.value })} />
            </span>
            <textarea className={styles.configTextarea} rows={2} aria-label="工具描述" value={description} spellCheck={false}
              placeholder="描述该工具给模型看"
              onChange={(e) => props.onPatch({ description: e.target.value })} />
            <span className={styles.configFieldLabel}>execute.kind（执行器）</span>
            <select className={styles.configInput} aria-label="执行器" value={kind}
              onChange={(e) => patchExecute({ kind: e.target.value })}>
              {KIND_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </span>

          {kind === 'shell' && (
            <span className={styles.configFieldStack}>
              <span className={styles.configFieldLabel}>{'command（{{args.x}} 参数插值；env 白名单；cwd=会话工作区）'}</span>
              <textarea className={styles.configTextarea} rows={3} aria-label="shell 命令" spellCheck={false}
                value={typeof execute.command === 'string' ? execute.command : ''} placeholder="Write-Output {{args.x}}"
                onChange={(e) => patchExecute({ command: e.target.value })} />
              <span className={styles.variableRow}>
                <span className={styles.configFieldLabel}>shell</span>
                <select className={styles.configInput} aria-label="shell" value={typeof execute.shell === 'string' ? execute.shell : 'pwsh'}
                  onChange={(e) => patchExecute({ shell: e.target.value })}>
                  {SHELLS.map((shell) => <option key={shell} value={shell}>{shell}</option>)}
                </select>
              </span>
            </span>
          )}
          {kind === 'http' && (
            <span className={styles.configFieldStack}>
              <input className={styles.configInput} aria-label="请求 URL" spellCheck={false}
                value={typeof execute.url === 'string' ? execute.url : ''} placeholder="https://…/{{args.q}}"
                onChange={(e) => patchExecute({ url: e.target.value })} />
              <span className={styles.variableRow}>
                <span className={styles.configFieldLabel}>method</span>
                <select className={styles.configInput} aria-label="请求方法"
                  value={typeof execute.method === 'string' ? execute.method : 'GET'}
                  onChange={(e) => patchExecute({ method: e.target.value })}>
                  {HTTP_METHODS.map((method) => <option key={method} value={method}>{method}</option>)}
                </select>
              </span>
            </span>
          )}
          {kind === 'delegate' && (
            <span className={styles.configFieldStack}>
              <span className={styles.configFieldLabel}>tool（委托目标；内置工具：{BUILTIN_TOOL_NAMES.join(' / ')}）</span>
              <input className={styles.configInput} aria-label="委托目标工具" spellCheck={false}
                value={typeof execute.tool === 'string' ? execute.tool : ''} placeholder="world_book_upsert"
                onChange={(e) => patchExecute({ tool: e.target.value })} />
            </span>
          )}
          {kind === 'fs' && (
            <span className={styles.configFieldStack}>
              <span className={styles.variableRow}>
                <span className={styles.configFieldLabel}>action</span>
                <select className={styles.configInput} aria-label="fs 动作"
                  value={typeof execute.action === 'string' && (FS_ACTIONS as readonly string[]).includes(execute.action) ? execute.action : 'read'}
                  onChange={(e) => patchExecute({ action: e.target.value })}>
                  {FS_ACTIONS.map((action) => <option key={action} value={action}>{action}</option>)}
                </select>
                <input className={styles.configInput} aria-label="文件路径" spellCheck={false}
                  value={typeof execute.path === 'string' ? execute.path : ''} placeholder="相对工作区路径 {{args.path}}"
                  onChange={(e) => patchExecute({ path: e.target.value })} />
              </span>
            </span>
          )}
          {kind === 'ask-user' && (
            <span className={styles.configFieldStack}>
              <input className={styles.configInput} aria-label="询问问题" spellCheck={false}
                value={typeof execute.question === 'string' ? execute.question : ''} placeholder="向用户确认的问题"
                onChange={(e) => patchExecute({ question: e.target.value })} />
            </span>
          )}

          <ParameterRowsEditor
            value={asRecord(tool.parameters)}
            onChange={(next) => props.onPatch({ parameters: next })}
          />
          <span className={styles.configFieldStack}>
            <span className={styles.configFieldLabel}>output.schema（JSON；默认开放对象）</span>
            <textarea className={styles.configTextarea} rows={4} aria-label="输出 schema JSON" spellCheck={false}
              value={JSON.stringify(asRecord(tool.output), null, 2) === '{}' ? '' : JSON.stringify(asRecord(tool.output), null, 2)}
              onChange={(e) => {
                const text = e.target.value.trim()
                if (text.length === 0) { props.onPatch({ output: { schema: { type: 'object', additionalProperties: true } } }); return }
                try { patchJson('output', JSON.parse(text) as ToolDraft) } catch { /* 解析失败不落盘 */ }
              }} />
          </span>
        </div>
      )}
    </article>
  )
}

/** 自定义工具区块：标题 + 从模板新建 + 工具卡片列表 + 保存（含 builtinTools JSON 编辑）。 */
export function CustomToolsModuleCard(props: {
  expanded: boolean
  onToggleExpanded: () => void
  onNotice: (kind: 'ok' | 'error', message: string) => void
}): ReactNode {
  const [tools, setTools] = useState<ToolDraft[]>([])
  const [builtinDraft, setBuiltinDraft] = useState('{}')
  const [toolTemplates, setToolTemplates] = useState<Array<{ file: string; spec: ToolDraft }>>([])
  const [showTemplates, setShowTemplates] = useState(false)
  const [expandedCards, setExpandedCards] = useState<Set<number>>(new Set())
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (loaded || !props.expanded) return
    void (async () => {
      const [customResult, builtinResult, templatesResult] = await Promise.all([
        bridgePost<{ customTools?: unknown[] }>('/custom-tools', {}),
        bridgePost<{ builtinTools?: Record<string, unknown> }>('/builtin-tools', {}),
        bridgePost<{ toolTemplates?: Array<{ file: string; spec: ToolDraft }> }>('/templates', {}),
      ])
      setTools((customResult.ok ? customResult.value?.customTools ?? [] : []).map((tool) => asRecord(tool)))
      setBuiltinDraft(JSON.stringify(builtinResult.ok ? builtinResult.value?.builtinTools ?? {} : {}, null, 2))
      setToolTemplates(templatesResult.ok ? templatesResult.value?.toolTemplates ?? [] : [])
      setLoaded(true)
    })()
  }, [props.expanded, loaded])
  const save = (): void => {
    let builtinParsed: unknown
    try {
      builtinParsed = JSON.parse(builtinDraft)
    } catch (error) {
      props.onNotice('error', `内置工具配置 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (builtinParsed === null || typeof builtinParsed !== 'object' || Array.isArray(builtinParsed)) {
      props.onNotice('error', '内置工具配置必须是对象')
      return
    }
    setSaving(true)
    void Promise.all([
      bridgePost<{ customTools?: unknown[] }>('/custom-tools', { customTools: tools }),
      bridgePost<{ builtinTools?: Record<string, unknown> }>('/builtin-tools', { builtinTools: builtinParsed }),
    ]).then(([customResult, builtinResult]) => {
      setSaving(false)
      if (customResult.ok && builtinResult.ok) {
        props.onNotice('ok', `已保存 ${tools.length} 个自定义工具 + 内置工具配置（已重建）`)
      } else {
        const failed = customResult.ok ? builtinResult : customResult
        props.onNotice('error', ('message' in failed ? failed.message : undefined) ?? '保存失败')
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
    setShowTemplates(false)
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
    <section className={styles.configList}>
      <header className={styles.configHeader}>
        <button type="button" className={styles.configToggle} aria-expanded={props.expanded} onClick={props.onToggleExpanded}>
          <span className={styles.configTitle}>
            <span className={styles.configTitleRow}>
              <span className={styles.configName}>自定义工具</span>
              <span className={styles.configMeta}>{`${tools.length} 个工具 · tool-config-engine`}</span>
            </span>
          </span>
          <IconChevronDownOutline14 className={clsx(styles.chevron, props.expanded && styles.chevronOpen)} />
        </button>
      </header>
      {props.expanded && (
        <div className={styles.configForm}>
          {tools.map((tool, index) => (
            <CustomToolCard
              key={`${String(tool.id ?? '')}-${index}`}
              tool={tool}
              index={index}
              expanded={expandedCards.has(index)}
              onToggleExpanded={() => toggleCard(index)}
              onPatch={(patch) => patchTool(index, patch)}
              onRemove={() => setTools(tools.filter((_, at) => at !== index))}
            />
          ))}
          {tools.length === 0 && <p className={styles.configFieldHint}>{'无自定义工具；从模板新建或直接添加。'}</p>}
          <span className={styles.configActions}>
            <button type="button" className={styles.pillButton} onClick={() => setShowTemplates(!showTemplates)}>
              从模板新建
            </button>
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
          {showTemplates && (
            <ul className={styles.configActions} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
              {toolTemplates.length === 0 && <li className={styles.configFieldHint}>模板库为空</li>}
              {toolTemplates.map((template) => (
                <li key={template.file}>
                  <button type="button" className={styles.pillButton} onClick={() => insertTemplate(template.spec)}>
                    {template.file.replace(/\.ya?ml$/i, '')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <span className={styles.configFieldStack}>
            <span className={styles.configFieldLabel}>builtinTools（内置工具注册配置：enabled / name 前缀 / description）</span>
            <textarea className={styles.configTextarea} rows={4} value={builtinDraft} spellCheck={false}
              aria-label="内置工具注册配置 JSON"
              onChange={(event) => setBuiltinDraft(event.target.value)} />
          </span>
        </div>
      )}
    </section>
  )
}
