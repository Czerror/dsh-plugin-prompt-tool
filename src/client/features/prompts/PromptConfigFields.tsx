import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { FormField } from '../../ui/FormField.tsx'
import { TagInput } from '../../ui/TagInput.tsx'
import { autoResizeTextarea } from './textarea-resize.ts'
import styles from '../../PromptUi.module.css'

function selectOptions(options: readonly string[], value: string | undefined): Array<{ value: string; label: string }> {
  const current = value ?? ''
  const entries = options.map((item) => ({ value: item, label: item === '' ? '（默认）' : item }))
  if (current !== '' && !options.includes(current)) entries.push({ value: current, label: `${current}（当前值）` })
  return entries
}

function selectValue(options: readonly string[], value: string | undefined, fallback: string): string {
  return options.includes(value ?? '') ? value ?? fallback : fallback
}

/** 共享枚举下拉：保持未知当前值可见，避免旧配置无法编辑。 */
export function OptionField(props: { label: string; hint?: string; value: string | undefined; options: readonly string[]; fallback: string; onChange: (value: string) => void; keepCurrent?: boolean; labels?: Record<string, string> }): ReactNode {
  const options = props.keepCurrent === true ? selectOptions(props.options, props.value) : props.options.map((item) => ({ value: item, label: item }))
  return (
    <FormField label={props.label} hint={props.hint}>
      <select className={styles.configInput} value={selectValue(props.options, props.value, props.fallback)} onChange={(event) => props.onChange(event.target.value)}>
        {options.map((item) => <option key={item.value} value={item.value}>{props.labels?.[item.value] ?? item.label}</option>)}
      </select>
    </FormField>
  )
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
