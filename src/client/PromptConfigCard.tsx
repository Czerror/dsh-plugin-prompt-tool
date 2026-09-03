/**
 * 单条提示词配置卡片 + 编辑表单（独立文件：
 * 打破 PromptConfigsEditor ⇄ PromptConfigList 的循环 import）。
 */
import { memo, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './PromptUi.module.css'
import { autoResizeTextarea } from './textarea-resize.ts'
import { FormField } from './ui/FormField.tsx'
import { TagInput } from './ui/TagInput.tsx'

import type { EngineMeta, LayerFieldPolicy, PromptConfigDraft } from './prompt-tool-types.ts'

export type { PromptConfigDraft, LayerFieldPolicy } from './prompt-tool-types.ts'

/** sourceKind / form 是少量固定语义值，用下拉选择；引擎不设枚举，因此额外保留当前值。 */
export const SOURCE_KINDS = ['', 'plugin', 'instruction-hint', 'skill-catalog', 'env-facts'] as const
export const SOURCE_FORMS = ['notice', 'hint', ''] as const

/** audience 的 UI 中文标签：空值=公用（缺省，通用参数默认）；main=仅主会话；subagent=仅子代理。 */
export const AUDIENCE_LABELS: Record<string, string> = { '': '公用（缺省）', main: '仅主会话', subagent: '仅子代理' }

/** 从引擎 /meta 中读取某层的字段能力；未知层回退 pre-step。 */
const EMPTY_POLICY: LayerFieldPolicy = {
  position: false,
  dedupe: false,
  promotion: false,
  audience: false,
  modelScope: false,
  merge: false,
  order: false,
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

function selectValue(options: readonly string[], value: string | undefined, fallback: string): string {
  return options.includes(value ?? '') ? value ?? fallback : fallback
}

/** JSON 对象文本域：解析失败只在本地标红，不污染草稿。 */
export function JsonField(props: { label: string; value: Record<string, unknown> | undefined; onChange: (value: Record<string, unknown> | undefined) => void }): ReactNode {
  const [text, setText] = useState(JSON.stringify(props.value ?? {}, null, 2))
  const [error, setError] = useState('')
  // 依赖序列化结果而非对象引用：父级 patch 会让 params 产生新引用（即使内容未变），
  // 旧写法会把用户未提交的编辑重置；引用不变时 useMemo 不再重复序列化。
  const serialized = useMemo(() => JSON.stringify(props.value ?? {}, null, 2), [props.value])
  useEffect(() => {
    setText(serialized)
    setError('')
  }, [serialized])
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
        onChange={(e) => { autoResizeTextarea(e); setText(e.target.value) }}
        onBlur={commit}
      />
    </span>
  )
}

/** 布尔开关行（params 结构化编辑用）。 */
function ParamToggle(props: { label: string; hint?: string; checked: boolean; onChange: (checked: boolean) => void }): ReactNode {
  return (
    <label className={styles.configEnable} title={props.checked ? '点击关闭' : '点击开启'}>
      <span className={styles.configFieldLabel}>{props.label}</span>
      <input type="checkbox" aria-label={props.label} checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span className={styles.switch} aria-hidden="true"><i /></span>
      {props.hint && <span className={styles.configFieldHint}>{props.hint}</span>}
    </label>
  )
}

/** params 文本域（结构化编辑用）：失焦写入草稿 params。 */
function ParamTextarea(props: { label: string; hint?: string; value: string; onChange: (value: string) => void }): ReactNode {
  return (
    <span className={styles.configFieldStack}>
      <span className={styles.configFieldLabel}>{props.label}</span>
      <textarea
        className={styles.configTextarea}
        aria-label={props.label}
        value={props.value}
        spellCheck={false}
        onChange={(e) => { autoResizeTextarea(e); props.onChange(e.target.value) }}
      />
      {props.hint && <p className={styles.configFieldHint}>{props.hint}</p>}
    </span>
  )
}

/** params 单行文本域（结构化编辑用）。 */
function ParamInput(props: { label: string; hint?: string; value: string; onChange: (value: string) => void }): ReactNode {
  return (
    <FormField label={props.label} hint={props.hint}>
      <input className={styles.configInput} value={props.value} spellCheck={false} onChange={(e) => props.onChange(e.target.value)} />
    </FormField>
  )
}

/**
 * 按 strategy 拆解 params 为结构化编辑框（替代裸 JSON）：
 *   first-turn-anchor → near-anchor 锚点参数（开关/锚文本/任务正则/引导句）；
 *   guide-auto → router-guide 每轮引导参数（开关/文本/复杂正则/强弱引导句）；
 *   custom-fallback → prompt-injector 锚定词（params.text 为运行时注入内容，不暴露编辑）；
 *   placeholder / instruction-hint → fill 模板参数（text/envKeys/limit/fields/providers/emptyBehavior/emptyText）；
 * 无固定字段的策略回退 JSON 编辑（保留任意 params 能力）。
 */
export function StrategyParamsFields(props: { strategy: string; layer?: string; params: Record<string, unknown> | undefined; onPatch: (params: Record<string, unknown>) => void; id?: string }): ReactNode {
  const { strategy, layer, params, onPatch, id } = props
  const value = params ?? {}
  const str = (key: string): string => (typeof value[key] === 'string' ? value[key] as string : '')
  const bool = (key: string): boolean => value[key] === true
  const set = (key: string, next: unknown): void => onPatch({ ...value, [key]: next })
  if (layer === 'system-section') {
    // system-section 层参数：人设段开关（开 = sectionName=deployment:persona 官方 shadow；
    // 关 = 可选自定义段名，空则引擎回退 id 注册为普通段）、complete（独占 system prompt，
    // 预设内互斥）、suppressRuntimeContext（抑制动态快照）。
    const isPersona = str('sectionName') === 'deployment:persona' || str('sectionName') === 'persona'
    return (
      <>
        <ParamToggle label="人设段" hint="开启 = 注册为全局 persona（sectionName=deployment:persona，同名 shadow；触发人设徽标/相位先行/子代理继承）"
          checked={isPersona}
          onChange={(next) => set('sectionName', next ? 'deployment:persona' : '')} />
        {!isPersona && (
          <ParamInput label="sectionName（自定义注册段名）" hint="可选；空 = 引擎回退用 id 注册为普通段。同名段会 shadow 合并/覆盖官方段。" value={str('sectionName')} onChange={(next) => set('sectionName', next)} />
        )}
        <ParamToggle label="complete（独占 system prompt）" hint="开启后 assembly 只保留本段；预设内互斥（多个 complete 官方 fail loud）"
          checked={bool('complete')} onChange={(next) => set('complete', next)} />
        <ParamToggle label="suppressRuntimeContext（抑制动态上下文）" hint="等价官方 dsh-persona includeRuntimeContext:false"
          checked={bool('suppressRuntimeContext')} onChange={(next) => set('suppressRuntimeContext', next)} />
      </>
    )
  }
  if (strategy === 'first-turn-anchor') {
    // writePreset 按 id 把顶层 params（firstTurnCustom/firstTurnText/…）统一写入
    // 这两个模板配置的 params——这里的编辑会被重建覆盖，隐藏以避免假入口。
    const managed = id === 'near-anchor'
    return (
      <>
        {managed && (
          <p className={styles.configFieldHint}>锚定开关与文本由设置页「锚定」管理（writePreset 重建时统一写入本配置），此处编辑会被覆盖。</p>
        )}
        {!managed && (
          <>
            <ParamToggle label="useCustom（自定义锚文本）" hint="true = 固定使用 text；false = 按 buildPattern/complexPattern 自动选择引导句"
              checked={bool('useCustom')} onChange={(next) => set('useCustom', next)} />
            <ParamTextarea label="text（自定义锚文本）" hint="useCustom=true 时固定注入" value={str('text')} onChange={(next) => set('text', next)} />
            <ParamInput label="buildPattern（构建任务正则）" hint="命中即用 firstTurnBuild 引导句" value={str('buildPattern')} onChange={(next) => set('buildPattern', next)} />
            <ParamInput label="complexPattern（复杂任务正则）" hint="命中即用 firstTurnDeep 引导句" value={str('complexPattern')} onChange={(next) => set('complexPattern', next)} />
            <ParamTextarea label="firstTurnBuild（构建引导句）" value={str('firstTurnBuild')} onChange={(next) => set('firstTurnBuild', next)} />
            <ParamTextarea label="firstTurnInspect（排查引导句）" value={str('firstTurnInspect')} onChange={(next) => set('firstTurnInspect', next)} />
            <ParamTextarea label="firstTurnDeep（复杂设计引导句）" value={str('firstTurnDeep')} onChange={(next) => set('firstTurnDeep', next)} />
          </>
        )}
      </>
    )
  }
  if (strategy === 'guide-auto') {
    const managed = id === 'router-guide'
    return (
      <>
        {managed && (
          <p className={styles.configFieldHint}>引导开关与文本由设置页「引导」管理（writePreset 重建时统一写入本配置），此处编辑会被覆盖。</p>
        )}
        {!managed && (
          <>
            <ParamToggle label="useCustom（自定义每轮引导）" hint="true = 固定使用 text；false = 按任务自动选择强弱引导"
              checked={bool('useCustom')} onChange={(next) => set('useCustom', next)} />
            <ParamTextarea label="text（自定义引导文本）" hint="useCustom=true 时固定注入" value={str('text')} onChange={(next) => set('text', next)} />
            <p className={styles.configFieldHint}>复杂任务判定复用锚定卡的 complexPattern（引导 fallback 共用分类器）。</p>
            <ParamTextarea label="guideWeak（简单任务自动引导）" value={str('guideWeak')} onChange={(next) => set('guideWeak', next)} />
            <ParamTextarea label="guideDeep（复杂任务自动引导）" value={str('guideDeep')} onChange={(next) => set('guideDeep', next)} />
          </>
        )}
      </>
    )
  }
  if (strategy === 'custom-fallback') {
    return (
      <>
        <ParamInput label="firstTurnWord（锚定词）" hint="晋升后首个 reasoning 命中该词即注入；任意自定义文本"
          value={str('firstTurnWord')} onChange={(next) => set('firstTurnWord', next)} />
      </>
    )
  }
  if (strategy === 'world-book') {
    const keyId = useId()
    const list = (key: string): string => Array.isArray(value[key])
      ? (value[key] as unknown[]).map(String).join(', ') : str(key)
    const setList = (key: string, next: string): void => set(key, next.split(',').map((item) => item.trim()).filter((item) => item.length > 0))
    return (
      <>
        <ParamToggle label="constant（常驻注入）" hint="true = 不依赖关键字，每轮恒注入；false = 命中 keys 才注入"
          checked={bool('constant')} onChange={(next) => set('constant', next)} />
        <TagInput id={`${keyId}-keys`} label="keys（触发关键字）" hint="命中消息文本中的任一关键字即注入；逗号分隔" onCommit={() => {}}
          value={list('keys')} placeholder="关键字，回车添加" onChange={(next) => setList('keys', next)} />
        <TagInput id={`${keyId}-secondary-keys`} label="secondaryKeys（次级关键字）" hint="与 keys 合并匹配（任一命中即注入）；逗号分隔" onCommit={() => {}}
          value={list('secondaryKeys')} placeholder="次级关键字，回车添加" onChange={(next) => setList('secondaryKeys', next)} />
        <ParamToggle label="caseSensitive（区分大小写）" hint="true = 关键字精确大小写匹配"
          checked={bool('caseSensitive')} onChange={(next) => set('caseSensitive', next)} />
        <ParamToggle label="wholeWords（整词匹配）" hint="true = 关键字必须整词出现（词边界），false = 子串包含即命中"
          checked={bool('wholeWords')} onChange={(next) => set('wholeWords', next)} />
        <ParamToggle label="useRegex（键为正则）" hint="true = keys / secondaryKeys 按正则表达式匹配（作者负责合法性）"
          checked={bool('useRegex')} onChange={(next) => set('useRegex', next)} />
        <OptionField
          label="selectiveLogic（触发逻辑）"
          hint="ST world_info_logic：0 = 主/副键任一命中；3 = 副键全中才注入；1 = 副键全不中才注入；2 = 至少一个副键未中才注入"
          value={value['selectiveLogic'] !== undefined ? String(value['selectiveLogic']) : '0'}
          options={['0', '1', '2', '3']}
          fallback="0"
          labels={{
            '0': '0 · 任一命中（默认）',
            '1': '1 · 副键全排除',
            '2': '2 · 部分排除',
            '3': '3 · 副键全包含',
          }}
          onChange={(next) => set('selectiveLogic', Number(next))}
        />
      </>
    )
  }
  if (strategy === 'placeholder' || strategy === 'instruction-hint') {
    return (
      <>
        <ParamTextarea label="text（自定义提示文本）" hint="覆盖文件与动态探测的提示文本；留空 = 默认"
          value={str('text')} onChange={(next) => set('text', next)} />
        <ParamInput label="envKeys（env-facts 环境变量白名单）" hint="逗号分隔；留空 = 默认 DSH_HOME,DSH_WORKSPACE"
          value={str('envKeys')} onChange={(next) => set('envKeys', next)} />
        <ParamInput label="limit（skill-catalog 数量上限）" hint="正整数；留空 = 不限制"
          value={str('limit')} onChange={(next) => set('limit', next === '' ? '' : Number(next))} />
        <ParamInput label="fields（skill-catalog 字段）" hint="逗号分隔；默认 name,description"
          value={str('fields')} onChange={(next) => set('fields', next)} />
        <ParamInput label="providers（skill-catalog provider 白名单）" hint="逗号分隔；留空 = 全部"
          value={str('providers')} onChange={(next) => set('providers', next)} />
        <OptionField label="emptyBehavior（空结果行为）" hint="skip = 不注入；text = 注入 emptyText"
          value={str('emptyBehavior')} options={['skip', 'text']} fallback="skip" onChange={(next) => set('emptyBehavior', next)} />
        <ParamTextarea label="emptyText（空结果提示文本）" value={str('emptyText')} onChange={(next) => set('emptyText', next)} />
      </>
    )
  }
  // 无策略参数的配置（static 等）：预设级内容变量已展开进 variables（官方插值
  // 机制，由上方 VariablesEditor 结构化编辑），params 为空时不再渲染 JSON 框。
  if (Object.keys(value).length === 0) {
    return <p className={styles.configFieldHint}>本策略无高级参数；模板变量见上方「variables」。</p>
  }
  return <JsonField label="params（高级参数 JSON；本策略无固定字段）" value={value} onChange={(next) => { if (next !== undefined) onPatch(next) }} />
}

/** 模板变量键值对编辑器（替代 JSON）：每行 key + value，可增删。工作台「模板变量」卡片复用。 */
export function VariablesEditor(props: { value: Record<string, string> | undefined; onChange: (value: Record<string, string> | undefined) => void }): ReactNode {
  const entries = Object.entries(props.value ?? {})
  const commit = (next: Array<[string, string]>) => {
    // 保留空 key 行（「添加变量」新增的待编辑行）；空 key 由保存端（savePresetParams）
    // 统一清理，避免新增行被立即过滤导致按钮失效。
    props.onChange(next.length > 0 ? Object.fromEntries(next) : undefined)
  }
  const setEntry = (index: number, key: string, value: string) => {
    commit(entries.map((entry, at): [string, string] => at === index ? [key, value] : entry))
  }
  return (
    <span className={styles.configFieldStack}>
      <span className={styles.configFieldLabel}>{'variables（模板变量 {{key}} 插值）'}</span>
      {entries.length === 0 && <p className={styles.configFieldHint}>{'无模板变量；下方添加键值对，注入文本中的 {{key}} 会被替换。'}</p>}
      {entries.map(([key, value], index) => (
        <span key={`${key}-${index}`} className={styles.variableRow}>
          <input className={styles.configInput} aria-label="模板变量名" value={key} spellCheck={false} placeholder="变量名"
            onChange={(e) => setEntry(index, e.target.value, value)} />
          <input className={styles.configInput} aria-label="模板变量值" value={value} spellCheck={false} placeholder="变量值"
            onChange={(e) => setEntry(index, key, e.target.value)} />
          <button type="button" className={styles.pillButton} data-danger aria-label={`删除变量 ${key || index}`}
            onClick={() => commit(entries.filter((_, at) => at !== index))}>删除</button>
        </span>
      ))}
      <span>
        <button type="button" className={styles.pillButton} onClick={() => commit([...entries, ['', '']])}>添加</button>
      </span>
    </span>
  )
}

/** identity 结构化编辑（替代 JSON）：field 下拉 + value 输入；value 留空 = 使用默认（等于配置 id）。 */
function IdentityFields(props: { identity: { field: string; value: string } | undefined; onPatch: (identity: { field: string; value: string } | undefined) => void }): ReactNode {
  const field = props.identity?.field ?? 'plugin'
  const value = props.identity?.value ?? ''
  return (
    <>
      <OptionField label="identity.field（幂等身份域）" hint="plugin = 按插件 id 幂等；kind = 按注入类型"
        value={field} options={['plugin', 'kind']} fallback="plugin" onChange={(next) => props.onPatch({ field: next, value })} />
      <FormField label="identity.value（幂等身份值）" hint="留空 = 使用默认（等于配置 id）">
        <input className={styles.configInput} value={value} spellCheck={false}
          onChange={(e) => props.onPatch(e.target.value.length > 0 ? { field, value: e.target.value } : undefined)} />
      </FormField>
    </>
  )
}

/** 枚举下拉：值不在选项内时用回退值，保证表单始终可渲染。 */
function OptionField(props: { label: string; hint?: string; value: string | undefined; options: readonly string[]; fallback: string; onChange: (value: string) => void; keepCurrent?: boolean; labels?: Record<string, string> }): ReactNode {
  const options = props.keepCurrent === true ? selectOptions(props.options, props.value) : props.options.map((item) => ({ value: item, label: item }))
  return (
    <FormField label={props.label} hint={props.hint}>
      <select className={styles.configInput} value={selectValue(props.options, props.value, props.fallback)} onChange={(e) => props.onChange(e.target.value)}>
        {options.map((item) => <option key={item.value} value={item.value}>{props.labels?.[item.value] ?? item.label}</option>)}
      </select>
    </FormField>
  )
}

/** 单条提示词配置表单：按注入层级的能力矩阵过滤字段，只显示本层生效的参数。 */
export function PromptConfigForm(props: {
  meta: EngineMeta
  config: PromptConfigDraft
  onPatch: (patch: Partial<PromptConfigDraft>) => void
}): ReactNode {
  const { meta, config, onPatch } = props
  const policy = fieldPolicyFor(meta, config.layer)
  const strategy = config.strategy ?? 'static'
  const placeholder = strategy === 'placeholder' && policy.placeholder
  const fillOptions = ['', ...meta.fills]
  return (
    <div className={styles.configForm}>
      <div className={styles.configGrid}>
        <FormField label="id（唯一，必填）">
          <input className={styles.configInput} value={config.id} spellCheck={false} onChange={(e) => onPatch({ id: e.target.value })} />
        </FormField>
        <FormField label="name（显示名）">
          <input className={styles.configInput} value={config.name ?? ''} spellCheck={false} onChange={(e) => onPatch({ name: e.target.value })} />
        </FormField>
        <OptionField label="layer" hint="注入层级；切换后下方字段按新层能力矩阵重新出现" value={config.layer} options={meta.layers} fallback="pre-step" onChange={(value) => onPatch({ layer: value })} />
        <OptionField label="strategy" hint="内容策略；placeholder 需配合 fill" value={config.strategy} options={meta.strategies} fallback="static" onChange={(value) => onPatch({ strategy: value })} />
        <OptionField label="configKind" hint="ordered 按 order 升序；anchor 固定文件序排最前" value={config.configKind} options={meta.slotKinds} fallback="ordered" onChange={(value) => onPatch({ configKind: value })} />
        {policy.role && <OptionField label="role" hint="注入消息角色：user / assistant" value={config.role} options={meta.roles} fallback="user" onChange={(value) => onPatch({ role: value })} />}
        {policy.position && <OptionField label="position" hint="同层拼接位置：after-user / before-all / after-all" value={config.position} options={meta.positions} fallback="after-user" onChange={(value) => onPatch({ position: value })} />}
        {policy.merge && <OptionField label="mergeMode" hint="merged=同位置配置拼接为一条消息" value={config.mergeMode} options={meta.mergeModes} fallback="separate" onChange={(value) => onPatch({ mergeMode: value })} />}
        {policy.order && <FormField label="order" hint="本层排序：数值小者在前（与同层列表上下移动等价）"><input className={styles.configInput} type="number" step={1} value={config.order ?? 0} onChange={(e) => onPatch({ order: Number(e.target.value) })} /></FormField>}
        <FormField label="group" hint="互斥组名：同 group 且 exclusive=true 时只执行排序后的第一个 enabled 配置"><input className={styles.configInput} value={config.group ?? ''} spellCheck={false} onChange={(e) => onPatch({ group: e.target.value })} /></FormField>
        <label className={styles.configEnable} title={config.exclusive === true ? '点击关闭互斥' : '点击开启互斥'}>
          <span className={styles.configFieldLabel}>exclusive</span>
          <input type="checkbox" aria-label="exclusive" checked={config.exclusive === true} onChange={(e) => onPatch({ exclusive: e.target.checked })} />
          <span className={styles.switch} aria-hidden="true"><i /></span>
        </label>
        {policy.dedupe && <OptionField label="dedupe" hint="session=每会话一次；batch=当前批去重" value={config.dedupe} options={meta.dedupes} fallback="none" onChange={(value) => onPatch({ dedupe: value })} />}
        {policy.promotion && <OptionField label="promotion" hint="none=不要求晋升；main=主会话晋升；include-subagents=子代理跟随" value={config.promotion} options={meta.promotions} fallback="none" onChange={(value) => onPatch({ promotion: value })} />}
        {policy.audience && <OptionField label="消息受众" hint="缺省（通用）=公用，主会话与子代理都注入；main=仅主会话；subagent=仅子代理（专用才标记）" value={config.audience ?? undefined} options={['', ...meta.audienceModes]} fallback="" labels={AUDIENCE_LABELS} onChange={(value) => onPatch(value === '' ? { audience: null } : { audience: value })} />}
        {policy.modelScope && <OptionField label="modelScope" hint="all / pro / flash；flash 按模型名包含 flash 判定" value={config.modelScope} options={meta.modelScopes} fallback="all" onChange={(value) => onPatch({ modelScope: value })} />}
        {placeholder && <OptionField label="fill（placeholder 专用）" hint="instruction-hint / env-facts / skill-catalog" value={config.fill} options={fillOptions} fallback="" onChange={(value) => onPatch({ fill: value || undefined })} />}
        <OptionField label="sourceKind" hint="注入消息 source.kind；默认等于 id" value={config.sourceKind} options={SOURCE_KINDS} fallback="" keepCurrent onChange={(value) => onPatch({ sourceKind: value || undefined })} />
        <OptionField label="form" hint="source.form；默认 notice，hint 用于指令提示" value={config.form} options={SOURCE_FORMS} fallback="notice" keepCurrent onChange={(value) => onPatch({ form: value || undefined })} />
        <FormField label="summary">
          <input className={styles.configInput} value={config.summary ?? ''} spellCheck={false} onChange={(e) => onPatch({ summary: e.target.value })} />
        </FormField>
        <FormField label="templateFile">
          <input className={styles.configInput} value={config.templateFile ?? ''} spellCheck={false} onChange={(e) => onPatch({ templateFile: e.target.value })} />
        </FormField>
      </div>
      <span className={styles.configFieldStack}>
        <span className={styles.configFieldLabel}>{'内容（注入文本；空 = 不注入；变量 {{key}} 插值）'}</span>
        <textarea
          className={styles.configTextarea}
          aria-label="注入内容（空 = 不注入）"
          value={[config.text ?? '', ...(config.texts ?? [])].filter((item) => item.length > 0).join('\n')}
          spellCheck={false}
          onChange={(e) => {
            autoResizeTextarea(e)
            const next = e.target.value
            // 内容资产（prompt-injector / instruction-hint）走生成目录文件通道（text →
            // params.text）；普通配置保存统一写 texts 单段整块（对齐官方 text 单字符串
            // 语义；text 字段兼容读取，编辑后归一）。
            if (config.id === 'prompt-injector' || config.fill === 'instruction-hint') {
              onPatch({ text: next, texts: [] })
            } else {
              onPatch({ text: undefined, texts: next.trim().length > 0 ? [next] : [] })
            }
          }}
        />
      </span>
      <VariablesEditor value={config.variables} onChange={(value) => onPatch({ variables: value })} />
              <StrategyParamsFields strategy={strategy} layer={config.layer} params={config.params} id={config.id} onPatch={(value) => onPatch({ params: value })} />
      <IdentityFields identity={config.identity} onPatch={(value) => onPatch({ identity: value })} />
    </div>
  )
}

/** 列表卡片（memo 化）：props 全部为数据或稳定回调——config 引用变化才重渲染该卡，
 *  129 卡列表编辑/拖拽 hover 时不再整列表级联渲染。 */
export const PromptConfigCard = memo(function PromptConfigCard(props: {
  meta: EngineMeta
  config: PromptConfigDraft
  expanded: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  dragging?: boolean
  dropBefore?: boolean
  dropAfter?: boolean
  onToggleExpanded: (id: string) => void
  onToggleEnabled: (id: string, enabled: boolean) => void
  onPatch: (id: string, patch: Partial<PromptConfigDraft>) => void
  onMoveUp: (id: string) => void
  onMoveDown: (id: string) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onDragStart?: (id: string, event: React.DragEvent<HTMLElement>) => void
  onDragOver?: (id: string, event: React.DragEvent<HTMLElement>) => void
  onDrop?: (id: string, event: React.DragEvent<HTMLElement>) => void
  onDragEnd?: () => void
}): ReactNode {
  const { meta, config } = props
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const enabled = config.enabled !== false
  const policy = fieldPolicyFor(meta, config.layer)
  const chips = [config.layer ?? 'pre-step', config.strategy ?? 'static']
  if (config.fill) chips.push(config.fill)
  if (policy.position) chips.push(`pos=${config.position ?? 'after-user'}`)
  if (config.mergeMode === 'merged') chips.push('merged')
  if ((config.order ?? 0) !== 0) chips.push(`order=${config.order}`)
  if (config.group) chips.push(config.exclusive === true ? `exclusive:${config.group}` : `group:${config.group}`)
  return (
    <article
      className={clsx(styles.configCard, props.expanded && styles.configCardOpen)}
      data-dragging={props.dragging ? '' : undefined}
      data-drop-before={props.dropBefore ? '' : undefined}
      data-drop-after={props.dropAfter ? '' : undefined}
      onDragOver={props.onDragOver === undefined ? undefined : (event) => props.onDragOver!(config.id, event)}
      onDrop={props.onDrop === undefined ? undefined : (event) => props.onDrop!(config.id, event)}
      onDragEnd={props.onDragEnd}
    >
      <header className={styles.configHeader}>
        {props.onDragStart !== undefined && (
          <span
            className={styles.dragHandle}
            title="拖动调整顺序"
            aria-hidden="true"
            draggable
            onDragStart={(event) => props.onDragStart!(config.id, event)}
          >⠿</span>
        )}
        <button type="button" className={styles.configToggle} aria-expanded={props.expanded} onClick={() => props.onToggleExpanded(config.id)}>
          <span className={styles.configTitle}>
            <span className={styles.configTitleRow}>
              <span className={styles.configName}>{config.name && config.name !== config.id ? `${config.id} · ${config.name}` : config.id}</span>
              {config.layer === 'system-section' && config.params?.sectionName === 'deployment:persona' && (
                <span className={styles.configChip} title="deployment:persona 同名 shadow：主会话人设（子代理经 scope 链继承）">人设</span>
              )}
            </span>
            <span className={styles.configMeta}>{chips.join(' · ')}</span>
          </span>
          <IconChevronDownOutline14 className={clsx(styles.chevron, props.expanded && styles.chevronOpen)} />
        </button>
        <span className={styles.configHeaderActions}>
          <label className={styles.configEnable} title={enabled ? '点击关闭' : '点击启用'}>
            <input type="checkbox" checked={enabled} aria-label={`启用 ${config.name ?? config.id}`} onChange={(e) => props.onToggleEnabled(config.id, e.target.checked)} />
            <span className={styles.switch} aria-hidden="true"><i /></span>
          </label>
          <span className={styles.configActions}>
            <button type="button" className={styles.pillButton} disabled={!props.canMoveUp} onClick={() => props.onMoveUp(config.id)}>上移</button>
            <button type="button" className={styles.pillButton} disabled={!props.canMoveDown} onClick={() => props.onMoveDown(config.id)}>下移</button>
            <button type="button" className={styles.pillButton} onClick={() => props.onDuplicate(config.id)}>复制</button>
            {confirmingDelete ? (
              <>
                <button type="button" className={styles.pillButton} data-danger onClick={() => props.onDelete(config.id)}>确认删除</button>
                <button type="button" className={styles.pillButton} data-variant="secondary" onClick={() => setConfirmingDelete(false)}>取消</button>
              </>
            ) : (
              <button type="button" className={styles.pillButton} data-danger onClick={() => setConfirmingDelete(true)}>删除</button>
            )}
          </span>
        </span>
      </header>
      {props.expanded && <PromptConfigForm meta={meta} config={config} onPatch={(patch) => props.onPatch(config.id, patch)} />}
    </article>
  )
})
