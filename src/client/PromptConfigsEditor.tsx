import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import { bridgePost, errorMessage, type BridgeSettingsView } from './prompt-tool-store.ts'
import { PromptConfigList } from './PromptConfigList.tsx'
import styles from './PromptUi.module.css'

import type { EngineMeta, LayerFieldPolicy, PromptConfigDraft } from './prompt-tool-types.ts'

export type { PromptConfigDraft, LayerFieldPolicy } from './prompt-tool-types.ts'

export interface PromptConfigTemplateEntry {
  file: string
  content: string
  spec: PromptConfigDraft
}

export interface ValidationErrorEntry {
  index: number
  id: string
  message: string
}

interface TemplatesResult {
  ok: boolean
  templates?: PromptConfigTemplateEntry[]
  message?: string
}

type ImportValue = BridgeSettingsView

type ImportResult = { ok: true; value: ImportValue; importedCount?: number; mergedCount?: number }
  | { ok: false; code?: string; message?: string; errors?: ValidationErrorEntry[] }

/** sourceKind / form 是少量固定语义值，用下拉选择；引擎不设枚举，因此额外保留当前值。 */
export const SOURCE_KINDS = ['', 'plugin', 'instruction-hint', 'skill-catalog', 'env-facts'] as const
export const SOURCE_FORMS = ['notice', 'hint', ''] as const

/** 从引擎 /meta 中读取某层的字段能力；未知层回退 pre-step。 */
const EMPTY_POLICY: LayerFieldPolicy = {
  position: false,
  dedupe: false,
  promotion: false,
  subagents: false,
  modelScope: false,
  merge: false,
  order: false,
  priority: false,
  role: false,
  placeholder: false,
}

export function fieldPolicyFor(meta: EngineMeta, layer: string | undefined): LayerFieldPolicy {
  return meta.layerFieldPolicies[(layer ?? 'pre-step')] ?? EMPTY_POLICY
}

function selectOptions(options: readonly string[], value: string | undefined): Array<{ value: string; label: string }> {
  const current = value ?? ''
  const entries = options.map((item) => ({ value: item, label: item === '' ? '（默认）' : item }))
  if (current !== '' && !options.includes(current)) entries.push({ value: current, label: `${current}（当前值）` })
  return entries
}

export function Field(props: { label: string; hint?: string; children: ReactNode }): ReactNode {
  return (
    <div className={styles.configField}>
      <label className={styles.configFieldLabel}>{props.label}</label>
      {props.children}
      {props.hint && <p className={styles.configFieldHint}>{props.hint}</p>}
    </div>
  )
}

function selectValue(options: readonly string[], value: string | undefined, fallback: string): string {
  return options.includes(value ?? '') ? value ?? fallback : fallback
}

/** JSON 对象文本域：解析失败只在本地标红，不污染草稿。 */
export function JsonField(props: { label: string; value: Record<string, unknown> | undefined; onChange: (value: Record<string, unknown> | undefined) => void }): ReactNode {
  const [text, setText] = useState(JSON.stringify(props.value ?? {}, null, 2))
  const [error, setError] = useState('')
  useEffect(() => {
    setText(JSON.stringify(props.value ?? {}, null, 2))
    setError('')
  }, [props.value])
  const commit = () => {
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setError('必须是 JSON 对象')
        return
      }
      props.onChange(parsed as Record<string, unknown>)
      setError('')
    } catch {
      setError('JSON 无效')
    }
  }
  return (
    <span className={styles.configFieldStack}>
      <span className={styles.configFieldLabel}>{props.label}{error && <span className={styles.configJsonError}> {error}</span>}</span>
      <textarea
        className={clsx(styles.configTextarea, styles.configJsonInput, error && styles.configInputError)}
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
      />
    </span>
  )
}

/** 枚举下拉：值不在选项内时用回退值，保证表单始终可渲染。 */
function OptionField(props: { label: string; hint?: string; value: string | undefined; options: readonly string[]; fallback: string; onChange: (value: string) => void; keepCurrent?: boolean }): ReactNode {
  const options = props.keepCurrent === true ? selectOptions(props.options, props.value) : props.options.map((item) => ({ value: item, label: item }))
  return (
    <Field label={props.label} hint={props.hint}>
      <select className={styles.configInput} value={selectValue(props.options, props.value, props.fallback)} onChange={(e) => props.onChange(e.target.value)}>
        {options.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
    </Field>
  )
}

/** 单条提示词配置表单：按注入层级的能力矩阵过滤字段，只显示本层生效的参数。 */
export function PromptConfigForm(props: { meta: EngineMeta; config: PromptConfigDraft; onPatch: (patch: Partial<PromptConfigDraft>) => void }): ReactNode {
  const { meta, config, onPatch } = props
  const policy = fieldPolicyFor(meta, config.layer)
  const strategy = config.strategy ?? 'static'
  const placeholder = strategy === 'placeholder' && policy.placeholder
  const fillOptions = ['', ...meta.fills]
  return (
    <div className={styles.configForm}>
      <div className={styles.configGrid}>
        <Field label="id（唯一，必填）">
          <input className={styles.configInput} value={config.id} spellCheck={false} onChange={(e) => onPatch({ id: e.target.value })} />
        </Field>
        <Field label="name（显示名）">
          <input className={styles.configInput} value={config.name ?? ''} spellCheck={false} onChange={(e) => onPatch({ name: e.target.value })} />
        </Field>
        <Field label="enabled">
          <input type="checkbox" checked={config.enabled !== false} onChange={(e) => onPatch({ enabled: e.target.checked })} />
        </Field>
        <OptionField label="layer" hint="注入层级；切换后下方字段按新层能力矩阵重新出现" value={config.layer} options={meta.layers} fallback="pre-step" onChange={(value) => onPatch({ layer: value })} />
        <OptionField label="strategy" hint="内容策略；placeholder 需配合 fill" value={config.strategy} options={meta.strategies} fallback="static" onChange={(value) => onPatch({ strategy: value })} />
        <OptionField label="configKind" hint="ordered 按 order 升序；anchor 固定文件序排最前" value={config.configKind} options={meta.slotKinds} fallback="ordered" onChange={(value) => onPatch({ configKind: value })} />
        {policy.role && <OptionField label="role" hint="注入消息角色：user / assistant" value={config.role} options={meta.roles} fallback="user" onChange={(value) => onPatch({ role: value })} />}
        {policy.position && <OptionField label="position" hint="同层拼接位置：after-user / before-all / after-all" value={config.position} options={meta.positions} fallback="after-user" onChange={(value) => onPatch({ position: value })} />}
        {policy.merge && <OptionField label="mergeMode" hint="merged=同位置同 mergeGroup 拼接为一条消息" value={config.mergeMode} options={meta.mergeModes} fallback="separate" onChange={(value) => onPatch({ mergeMode: value })} />}
        {policy.merge && <Field label="mergeGroup" hint="拼接分组名；不填 = 同位置共享默认组"><input className={styles.configInput} value={config.mergeGroup ?? ''} spellCheck={false} onChange={(e) => onPatch({ mergeGroup: e.target.value })} /></Field>}
        {policy.order && <Field label="order" hint="本层排序：数值小者在前（与同层列表上下移动等价）"><input className={styles.configInput} type="number" step={1} value={config.order ?? 0} onChange={(e) => onPatch({ order: Number(e.target.value) })} /></Field>}
        {policy.priority && <Field label="priority" hint="同位置插入顺序与 merged 拼接顺序：数值小者更靠近锚点"><input className={styles.configInput} type="number" step={1} value={config.priority ?? 0} onChange={(e) => onPatch({ priority: Number(e.target.value) })} /></Field>}
        <Field label="group" hint="互斥组名：同 group 且 exclusive=true 时只执行排序后的第一个 enabled 配置"><input className={styles.configInput} value={config.group ?? ''} spellCheck={false} onChange={(e) => onPatch({ group: e.target.value })} /></Field>
        <Field label="exclusive" hint="同 group 互斥：只执行第一个 enabled 配置"><input type="checkbox" checked={config.exclusive === true} onChange={(e) => onPatch({ exclusive: e.target.checked })} /></Field>
        {policy.dedupe && <OptionField label="dedupe" hint="session=每会话一次；batch=当前批去重" value={config.dedupe} options={meta.dedupes} fallback="none" onChange={(value) => onPatch({ dedupe: value })} />}
        {policy.promotion && <OptionField label="promotion" hint="none=不要求晋升；main=主会话晋升；include-subagents=子代理跟随" value={config.promotion} options={meta.promotions} fallback="none" onChange={(value) => onPatch({ promotion: value })} />}
        {policy.subagents && <OptionField label="subagents" hint="none=仅主会话；inherit=都适用；only=仅子代理" value={config.subagents} options={meta.subagentModes} fallback="none" onChange={(value) => onPatch({ subagents: value })} />}
        {policy.modelScope && <OptionField label="modelScope" hint="all / pro / flash；flash 按模型名包含 flash 判定" value={config.modelScope} options={meta.modelScopes} fallback="all" onChange={(value) => onPatch({ modelScope: value })} />}
        {placeholder && <OptionField label="fill（placeholder 专用）" hint="instruction-hint / env-facts / skill-catalog" value={config.fill} options={fillOptions} fallback="" onChange={(value) => onPatch({ fill: value || undefined })} />}
        <OptionField label="sourceKind" hint="注入消息 source.kind；默认等于 id" value={config.sourceKind} options={SOURCE_KINDS} fallback="" keepCurrent onChange={(value) => onPatch({ sourceKind: value || undefined })} />
        <OptionField label="form" hint="source.form；默认 notice，hint 用于指令提示" value={config.form} options={SOURCE_FORMS} fallback="notice" keepCurrent onChange={(value) => onPatch({ form: value || undefined })} />
        <Field label="summary">
          <input className={styles.configInput} value={config.summary ?? ''} spellCheck={false} onChange={(e) => onPatch({ summary: e.target.value })} />
        </Field>
        <Field label="templateFile">
          <input className={styles.configInput} value={config.templateFile ?? ''} spellCheck={false} onChange={(e) => onPatch({ templateFile: e.target.value })} />
        </Field>
      </div>
      <span className={styles.configFieldStack}>
        <span className={styles.configFieldLabel}>text（注入文本；空 = 不注入）</span>
        <textarea className={styles.configTextarea} value={config.text ?? ''} spellCheck={false} onChange={(e) => onPatch({ text: e.target.value })} />
      </span>
      <span className={styles.configFieldStack}>
        <span className={styles.configFieldLabel}>texts（多段内容块，每行一段；text 为空时生效）</span>
        <textarea className={styles.configTextarea} value={(config.texts ?? []).join('\n')} spellCheck={false} onChange={(e) => onPatch({ texts: e.target.value.split('\n').filter((line) => line.length > 0) })} />
      </span>
      <JsonField label="variables（模板变量 JSON）" value={config.variables as Record<string, unknown> | undefined} onChange={(value) => onPatch({ variables: value as Record<string, string> | undefined })} />
      <JsonField label="params（各层专用参数 JSON）" value={config.params} onChange={(value) => onPatch({ params: value })} />
      <JsonField label="identity（幂等身份 JSON；留空使用默认）" value={config.identity as unknown as Record<string, unknown> | undefined} onChange={(value) => onPatch({ identity: value as unknown as { field: string; value: string } | undefined })} />
    </div>
  )
}

export interface PromptConfigCardActions {
  canMoveUp: boolean
  canMoveDown: boolean
  onMoveUp: () => void
  onMoveDown: () => void
  onDuplicate: () => void
  onDelete: () => void
}

/** 列表卡片：开关按钮 + 4 个操作按钮 + 可展开编辑表单。 */
export function PromptConfigCard(props: {
  meta: EngineMeta
  config: PromptConfigDraft
  expanded: boolean
  onToggleExpanded: () => void
  onToggleEnabled: (enabled: boolean) => void
  onPatch: (patch: Partial<PromptConfigDraft>) => void
  actions: PromptConfigCardActions
}): ReactNode {
  const { meta, config, actions } = props
  const enabled = config.enabled !== false
  const policy = fieldPolicyFor(meta, config.layer)
  const chips = [config.layer ?? 'pre-step', config.strategy ?? 'static']
  if (config.fill) chips.push(config.fill)
  if (policy.position) chips.push(`pos=${config.position ?? 'after-user'}`)
  if (config.mergeMode === 'merged') chips.push(`merged:${config.mergeGroup || '默认组'}`)
  if ((config.priority ?? 0) !== 0) chips.push(`priority=${config.priority}`)
  if ((config.order ?? 0) !== 0) chips.push(`order=${config.order}`)
  if (config.group) chips.push(config.exclusive === true ? `exclusive:${config.group}` : `group:${config.group}`)
  return (
    <article className={clsx(styles.configCard, props.expanded && styles.configCardOpen)}>
      <header className={styles.configHeader}>
        <button type="button" className={styles.configToggle} aria-expanded={props.expanded} onClick={props.onToggleExpanded}>
          <span className={styles.configTitle}>
            <span className={styles.configName}>{config.name && config.name !== config.id ? `${config.id} · ${config.name}` : config.id}</span>
            <span className={styles.configMeta}>{chips.join(' · ')}</span>
          </span>
          <IconChevronDownOutline14 className={clsx(styles.chevron, props.expanded && styles.chevronOpen)} />
        </button>
        <label className={styles.configEnable} title={enabled ? '点击关闭' : '点击启用'}>
          <input type="checkbox" checked={enabled} aria-label={`启用 ${config.name ?? config.id}`} onChange={(e) => props.onToggleEnabled(e.target.checked)} />
          <span className={styles.switch} aria-hidden="true"><i /></span>
        </label>
        <div className={styles.configActions}>
          <button type="button" className={styles.pillButton} disabled={!actions.canMoveUp} onClick={actions.onMoveUp}>上移</button>
          <button type="button" className={styles.pillButton} disabled={!actions.canMoveDown} onClick={actions.onMoveDown}>下移</button>
          <button type="button" className={styles.pillButton} onClick={actions.onDuplicate}>复制</button>
          <button type="button" className={styles.pillButton} data-danger onClick={actions.onDelete}>删除</button>
        </div>
      </header>
      {props.expanded && <PromptConfigForm meta={meta} config={config} onPatch={props.onPatch} />}
    </article>
  )
}

export interface PromptConfigsEditorProps {
  api: IApiClient
  meta: EngineMeta
  configs: PromptConfigDraft[]
  configsDir: string
  savedConfigs: PromptConfigDraft[]
  savedConfigsDir: string
  onPatchConfigs: (configs: PromptConfigDraft[]) => void
  onPatchConfigsDir: (dir: string) => void
  onSaveConfigs: (configs: PromptConfigDraft[]) => void
  onSaveConfigsDir: (dir: string) => void
  onReload: () => Promise<unknown>
  onNotice: (kind: 'ok' | 'error', message: string) => void
}

/** 主设置页唯一保留的区块：提示词配置（目录导入 + 模板插入 + 保存前权威校验）。 */
export function PromptConfigsEditor(props: PromptConfigsEditorProps): ReactNode {
  const [templates, setTemplates] = useState<PromptConfigTemplateEntry[]>([])
  const [templateFile, setTemplateFile] = useState('')
  const [savingDir, setSavingDir] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importErrors, setImportErrors] = useState<ValidationErrorEntry[]>([])

  const loadTemplates = async () => {
    try {
      const res = await bridgePost<TemplatesResult>('/templates', {})
      if (res.ok) {
        if (Array.isArray(res.value.templates)) {
          setTemplates(res.value.templates)
          return
        }
        props.onNotice('error', '读取模板库失败：模板列表为空')
        return
      }
      props.onNotice('error', '读取模板库失败：' + (res.message ?? ''))
    } catch (error) {
      props.onNotice('error', '读取模板库失败：' + errorMessage(error))
    }
  }

  const applyDir = () => {
    setSavingDir(true)
    props.onSaveConfigsDir(props.configsDir.trim())
    setSavingDir(false)
  }

  const importFromDirectory = async () => {
    if (importing) return
    setImporting(true)
    setImportErrors([])
    try {
      const picked = await props.api.host.pickDirectory({})
      if (!picked.result.ok) {
        props.onNotice('error', '选择目录失败：' + (picked.result.error?.message ?? 'host.pickDirectory 不可用'))
        return
      }
      const dir = picked.result.value?.path
      if (!dir) return
      const res = await bridgePost<ImportValue>('/import-directory', { dir }) as unknown as ImportResult
      if (!res.ok) {
        setImportErrors(res.errors ?? [])
        props.onNotice('error', `导入失败：${res.message ?? ''}${(res.errors?.length ?? 0) > 0 ? `（${res.errors!.length} 个错误）` : ''}`)
        return
      }
      await props.onReload()
      props.onNotice('ok', `已从目录导入 ${res.importedCount ?? 0} 条提示词配置并保存（合并后 ${res.mergedCount ?? props.configs.length} 条）`)
    } catch (error) {
      props.onNotice('error', '导入失败：' + errorMessage(error))
    } finally {
      setImporting(false)
    }
  }

  const insertTemplate = () => {
    const entry = templates.find((item) => item.file === templateFile)
    if (entry === undefined) {
      props.onNotice('error', '请先选择模板')
      return
    }
    if (props.configs.some((config) => config.id === entry.spec.id)) {
      props.onNotice('error', `id 已存在：${entry.spec.id}（请先改名或删除同 id 配置）`)
      return
    }
    const clone = JSON.parse(JSON.stringify(entry.spec)) as PromptConfigDraft
    props.onPatchConfigs([...props.configs, clone])
    props.onNotice('ok', `已插入模板 ${entry.file}（id=${clone.id}）`)
  }

  return (
    <section className={styles.page} aria-label="提示词配置">
      <header className={styles.pageHeader}>
        <h1>提示词配置</h1>
        <p>统一管理六个注入层级的提示词配置：内容、层级与位置全部自定义。保存前自动做引擎权威校验；同名 id 后写入者覆盖，新 id 追加。</p>
      </header>

      <section className={styles.section} aria-labelledby="prompt-tool-import-heading">
        <div className={styles.sectionHeading}>
          <div><h2 id="prompt-tool-import-heading">导入提示词配置</h2><p>从本地目录批量导入 *.yml / *.yaml / *.json 配置；同名 id 覆盖现有配置，新 id 追加到末尾。</p></div>
        </div>
        <div className={styles.importBar}>
          <div><strong>从目录导入</strong><small>目录内每个文件必须是单条提示词配置对象，且 id 为非空字符串。</small></div>
          <button type="button" className={styles.primaryPill} disabled={importing} onClick={() => void importFromDirectory()}>{importing ? '导入中…' : '选择目录并导入'}</button>
        </div>
        {importErrors.length > 0 && (
          <div className={styles.configErrorBox}>
            {importErrors.map((error, index) => (
              <div key={`${error.index}-${index}`} className={styles.configErrorLine}>[{error.index}] {error.id || '(缺 id)'}：{error.message}</div>
            ))}
          </div>
        )}
        <div className={styles.importBar}>
          <div><strong>内置模板</strong><small>templates/ 覆盖六层与 placeholder 数据源，插入后按需修改。</small></div>
          <select className={styles.configInput} value={templateFile} onChange={(e) => setTemplateFile(e.target.value)} onFocus={() => { if (templates.length === 0) void loadTemplates() }} aria-label="选择提示词配置模板">
            <option value="">选择模板插入…</option>
            {templates.map((template) => <option key={template.file} value={template.file}>{template.file} · {template.spec.name ?? template.spec.id}</option>)}
          </select>
          <button type="button" className={styles.pillButton} onClick={insertTemplate}>插入模板</button>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="prompt-tool-directory-heading">
        <div className={styles.sectionHeading}>
          <div><h2 id="prompt-tool-directory-heading">提示词配置目录</h2><p>运行时按此目录扫描 *.yml / *.yaml / *.json（优先级低于本页 settings 数组）。</p></div>
        </div>
        <div className={styles.settingRow}>
          <div className={styles.settingCopy}>
            <strong>目录路径</strong>
            <small>留空 = 不扫描目录；保存后引擎下次重建时生效。</small>
          </div>
          <div className={styles.directoryControl}>
            <input
              className={styles.directoryInput}
              aria-label="提示词配置目录"
              value={props.configsDir}
              placeholder="留空 = 不扫描目录"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => props.onPatchConfigsDir(e.target.value)}
            />
            <button type="button" className={styles.pillButton} disabled={savingDir} onClick={applyDir}>{savingDir ? '设置中…' : '设置目录'}</button>
          </div>
        </div>
      </section>

      <PromptConfigList
        meta={props.meta}
        configs={props.configs}
        savedConfigs={props.savedConfigs}
        onPatchConfigs={props.onPatchConfigs}
        onSaveConfigs={props.onSaveConfigs}
        onNotice={props.onNotice}
      />

      <p className={styles.settingsNote}>提示词配置写入 <code>settings.promptConfigs</code>；目录合并优先级：默认四条 &lt; promptConfigsDir &lt; settings.promptConfigs。</p>
    </section>
  )
}
