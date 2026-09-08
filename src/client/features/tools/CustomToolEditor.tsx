import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { FormField } from '../../ui/FormField.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { patchToolParameter } from './custom-tool-parameters.ts'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './tools.module.css'

const styles = { ...sharedCss, ...featureCss }
/** 内置工具名（delegate 提示）。 */
const BUILTIN_TOOL_NAMES = ['character_list', 'character_import', 'character_apply', 'character_remove', 'character_delete',
  'world_book_list', 'world_book_upsert', 'world_book_delete', 'session_var']

const KIND_OPTIONS = ['shell', 'http', 'delegate', 'fs', 'ask-user'] as const
const FS_ACTIONS = ['read', 'write', 'append', 'list', 'delete'] as const
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const
const SHELLS = ['pwsh', 'powershell', 'cmd', 'sh', 'bash'] as const
const SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'null', 'array', 'object', 'json', 'oneOf'] as const

export type ToolDraft = Record<string, unknown>

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** parameters 行式编辑：key + type 下拉 + required 开关 + description，可增删。 */
function ParameterRowsEditor(props: { value: ToolDraft | undefined; onChange: (value: ToolDraft | undefined) => void }): ReactNode {
  const params = asRecord(props.value)
  const rows = Object.entries(params)
  const commit = (next: Array<[string, unknown]>): void => {
    props.onChange(next.length > 0 ? Object.fromEntries(next) : undefined)
  }
  const setRow = (index: number, patch: Partial<{ key: string; type: string; required: boolean; description: string }>): void => {
    const { key, ...changes } = patch
    commit(rows.map(([name, spec], at) => at === index ? [key ?? name, patchToolParameter(asRecord(spec), changes)] : [name, spec]))
  }
  return (
    <span className={styles.configFieldStack}>
      <span className={styles.configFieldLabel}>parameters（模型可见参数 schema）</span>
      {rows.length === 0 && <p className={styles.configFieldHint}>{'无参数；下方添加。required=true 时模型必须提供该参数。'}</p>}
      {rows.map(([key, spec], index) => {
        const record = asRecord(spec)
        const type = typeof record.type === 'string' ? record.type : Array.isArray(record.oneOf) ? 'oneOf' : 'json'
        return <span key={index} className={styles.variableRow}>
          <input className={styles.configInput} aria-label="参数名" value={key} spellCheck={false} placeholder="参数名"
            onChange={(e) => setRow(index, { key: e.target.value })} />
          <MenuSelect className={styles.configInput} compact ariaLabel="参数类型" value={type}
            options={SCHEMA_TYPES.map((type) => ({ value: type, label: type }))}
            onChange={(type) => setRow(index, { type })} />
          <HintTooltip label="模型必须填写此参数">
            <label className={styles.configEnable}>
              <input type="checkbox" aria-label="必填" checked={record.required === true}
                onChange={(e) => setRow(index, { required: e.target.checked })} />
              <span className={styles.switch} aria-hidden="true"><i /></span>
            </label>
          </HintTooltip>
          <input className={styles.configInput} aria-label="参数描述" value={typeof record.description === 'string' ? record.description : ''} spellCheck={false} placeholder="描述"
            onChange={(e) => setRow(index, { description: e.target.value })} />
          <button type="button" className={styles.pillButton} data-danger aria-label={`删除参数 ${key || index}`}
            onClick={() => commit(rows.filter((_, at) => at !== index))}>删除</button>
        </span>
      })}
      <span>
        <button type="button" className={styles.pillButton} onClick={() => commit([...rows, ['', { type: 'string' }]])}>
          添加参数
        </button>
      </span>
    </span>
  )
}

/** 本 feature 内的 JSON 草稿：非法中间态不回弹，失焦后只提交对象。 */
function ToolJsonField(props: { label: string; value: ToolDraft; onChange: (value: ToolDraft) => void }): ReactNode {
  const serialized = JSON.stringify(props.value, null, 2)
  const [text, setText] = useState(serialized)
  const [error, setError] = useState('')
  useEffect(() => { setText(serialized); setError('') }, [serialized])
  return <FormField label={props.label} hint="失焦提交合法 JSON；嵌套属性、items、oneOf、enum 等在此编辑。">
    <textarea className={styles.configTextarea} rows={5} aria-label={props.label} aria-invalid={error.length > 0}
      value={text} spellCheck={false} onChange={(event) => { setText(event.target.value); setError('') }}
      onBlur={() => {
        try {
          const value: unknown = JSON.parse(text.trim() || '{}')
          if (value === null || typeof value !== 'object' || Array.isArray(value)) { setError('必须是 JSON 对象'); return }
          props.onChange(value as ToolDraft)
          setError('')
        } catch { setError('JSON 无效；修正后再保存工具') }
      }} />
    {error && <small role="alert">{error}</small>}
  </FormField>
}

/** 单张工具卡片（对齐模块列表卡片形态）：header（enabled 开关 + chips + 上移/下移/复制/两段式删除）+ Field 表单。 */
export function CustomToolCard(props: {
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
  const [timeoutDraft, setTimeoutDraft] = useState<string | undefined>()
  const [timeoutError, setTimeoutError] = useState('')
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
  return (
    <article className={clsx(styles.configCard, styles.toolCard, props.expanded && styles.configCardOpen)} data-tool-card="true">
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
          <HintTooltip label={enabled ? '点击停用；停用后不注册工具' : '点击启用'}>
            <label className={styles.configEnable}>
              <input type="checkbox" aria-label={`启用工具 ${id}`} checked={enabled}
                onChange={(e) => props.onToggleEnabled(e.target.checked)} />
              <span className={styles.switch} aria-hidden="true"><i /></span>
            </label>
          </HintTooltip>
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
            <FormField label="id（文件标识）">
              <input className={styles.configInput} aria-label="工具 id" value={id} spellCheck={false}
                onChange={(e) => props.onPatch({ id: e.target.value })} />
            </FormField>
            <FormField label="name（模型可见名）">
              <input className={styles.configInput} aria-label="工具名" value={name} spellCheck={false} placeholder="my_tool"
                onChange={(e) => props.onPatch({ name: e.target.value })} />
            </FormField>
          </span>
          <FormField label="description（模型可见描述）">
            <textarea className={styles.configTextarea} rows={2} aria-label="工具描述" value={description} spellCheck={false}
              placeholder="描述该工具给模型看"
              onChange={(e) => props.onPatch({ description: e.target.value })} />
          </FormField>
          <FormField label="execute.kind（执行器）" hint="shell=命令；http=请求；delegate=委托内置/已注册工具；fs=工作区文件；ask-user=询问用户">
            <MenuSelect className={styles.configInput} compact ariaLabel="执行器" value={kind}
              options={KIND_OPTIONS.map((option) => ({ value: option, label: option }))}
              onChange={(value) => patchExecute({ kind: value, ...(value === 'fs' && execute.action === undefined ? { action: 'read' } : {}) })} />
          </FormField>
          {kind === 'shell' && (
            <>
              <FormField label="command" hint={'{{args.x}} 参数插值；env 白名单；cwd=会话工作区'}>
                <textarea className={styles.configTextarea} rows={3} aria-label="shell 命令" spellCheck={false}
                  value={typeof execute.command === 'string' ? execute.command : ''} placeholder="Write-Output {{args.x}}"
                  onChange={(e) => patchExecute({ command: e.target.value })} />
              </FormField>
              <FormField label="shell" hint="pwsh 强制 UTF-8 输出（中文不乱码）">
                <MenuSelect className={styles.configInput} compact ariaLabel="shell"
                  value={typeof execute.shell === 'string' ? execute.shell : 'pwsh'}
                  options={SHELLS.map((shell) => ({ value: shell, label: shell }))}
                  onChange={(value) => patchExecute({ shell: value })} />
              </FormField>
            </>
          )}
          {kind === 'http' && (
            <>
              <FormField label="url" hint={'{{args.x}} 参数插值'}>
                <input className={styles.configInput} aria-label="请求 URL" spellCheck={false}
                  value={typeof execute.url === 'string' ? execute.url : ''} placeholder="https://…/{{args.q}}"
                  onChange={(e) => patchExecute({ url: e.target.value })} />
              </FormField>
              <FormField label="method">
                <MenuSelect className={styles.configInput} compact ariaLabel="请求方法"
                  value={typeof execute.method === 'string' ? execute.method : 'GET'}
                  options={HTTP_METHODS.map((method) => ({ value: method, label: method }))}
                  onChange={(value) => patchExecute({ method: value })} />
              </FormField>
            </>
          )}
          {kind === 'delegate' && (
            <FormField label="tool（委托目标）" hint={`内置工具：${BUILTIN_TOOL_NAMES.join(' / ')}`}>
              <input className={styles.configInput} aria-label="委托目标工具" spellCheck={false}
                value={typeof execute.tool === 'string' ? execute.tool : ''} placeholder="world_book_upsert"
                onChange={(e) => patchExecute({ tool: e.target.value })} />
            </FormField>
          )}
          {kind === 'fs' && (
            <>
              <FormField label="action">
                <MenuSelect className={styles.configInput} compact ariaLabel="fs 动作"
                  value={typeof execute.action === 'string' && (FS_ACTIONS as readonly string[]).includes(execute.action) ? execute.action : 'read'}
                  options={FS_ACTIONS.map((action) => ({ value: action, label: action }))}
                  onChange={(value) => patchExecute({ action: value })} />
              </FormField>
              <FormField label="path" hint="相对工作区路径；越界拒绝">
                <input className={styles.configInput} aria-label="文件路径" spellCheck={false}
                  value={typeof execute.path === 'string' ? execute.path : ''} placeholder="data/{{args.name}}.json"
                  onChange={(e) => patchExecute({ path: e.target.value })} />
              </FormField>
              {(execute.action === 'write' || execute.action === 'append' || String(execute.action).includes('{{args.')) && (
                <FormField label="content" hint={'写入或追加的文本；支持 {{args.x}}，空文本会写入空内容'}>
                  <textarea className={styles.configTextarea} rows={4} aria-label="文件内容" spellCheck={false}
                    value={typeof execute.content === 'string' ? execute.content : ''}
                    onChange={(event) => patchExecute({ content: event.target.value })} />
                </FormField>
              )}
            </>
          )}
          {kind === 'ask-user' && (
            <FormField label="question（向用户确认的问题）">
              <input className={styles.configInput} aria-label="询问问题" spellCheck={false}
                value={typeof execute.question === 'string' ? execute.question : ''} placeholder="是否继续执行该操作？"
                onChange={(e) => patchExecute({ question: e.target.value })} />
            </FormField>
          )}
          <ParameterRowsEditor
            value={asRecord(tool.parameters)}
            onChange={(next) => props.onPatch({ parameters: next })}
          />
          <ToolJsonField label="高级参数 JSON" value={asRecord(tool.parameters)} onChange={(parameters) => props.onPatch({ parameters })} />
          <ToolJsonField label="输出 schema JSON" value={asRecord(tool.output)} onChange={(output) => props.onPatch({
            output: Object.keys(output).length > 0 ? output : { schema: { type: 'object', additionalProperties: true } },
          })} />
          <FormField label="timeoutMs" hint="正整数毫秒，留空使用执行器默认；最大 2147483647。">
            <input className={styles.configInput} type="number" min={1} max={2_147_483_647} step={1} aria-label="工具超时毫秒"
              aria-invalid={timeoutError.length > 0} value={timeoutDraft ?? String(tool.timeoutMs ?? '')}
              onChange={(event) => { setTimeoutDraft(event.target.value); setTimeoutError('') }}
              onBlur={() => {
                if (timeoutDraft === undefined) return
                const timeoutMs = timeoutDraft.trim() === '' ? undefined : Number(timeoutDraft)
                if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)) {
                  setTimeoutError('超时必须是 1–2147483647 的整数'); return
                }
                props.onPatch({ timeoutMs })
                setTimeoutDraft(undefined)
              }} />
            {timeoutError && <small role="alert">{timeoutError}</small>}
          </FormField>
        </div>
      )}
    </article>
  )
}
