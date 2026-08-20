/**
 * 单条提示词配置卡片 + 编辑表单（独立文件：
 * 打破 PromptConfigsEditor ⇄ PromptConfigList 的循环 import）。
 */
import { cloneElement, isValidElement, useEffect, useId, useState, type ReactElement, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './PromptUi.module.css'

import type { EngineMeta, LayerFieldPolicy, PromptConfigDraft } from './prompt-tool-types.ts'

export type { PromptConfigDraft, LayerFieldPolicy } from './prompt-tool-types.ts'

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
  const id = useId()
  return (
    <div className={styles.configField}>
      <label className={styles.configFieldLabel} htmlFor={id}>{props.label}</label>
      {isValidElement(props.children) ? cloneElement(props.children as ReactElement<{ id?: string }>, { id }) : props.children}
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
        aria-label={props.label}
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
        <label className={styles.configEnable} title={config.enabled !== false ? '点击关闭' : '点击启用'}>
          <span className={styles.configFieldLabel}>enabled</span>
          <input type="checkbox" aria-label="enabled" checked={config.enabled !== false} onChange={(e) => onPatch({ enabled: e.target.checked })} />
          <span className={styles.switch} aria-hidden="true"><i /></span>
        </label>
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
        <label className={styles.configEnable} title={config.exclusive === true ? '点击关闭互斥' : '点击开启互斥'}>
          <span className={styles.configFieldLabel}>exclusive</span>
          <input type="checkbox" aria-label="exclusive" checked={config.exclusive === true} onChange={(e) => onPatch({ exclusive: e.target.checked })} />
          <span className={styles.switch} aria-hidden="true"><i /></span>
        </label>
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
