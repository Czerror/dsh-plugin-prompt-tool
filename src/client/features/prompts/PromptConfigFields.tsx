import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { FormField } from '../../ui/FormField.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { TagInput } from '../../ui/TagInput.tsx'
import { autoResizeTextarea } from './textarea-resize.ts'
import { EMPTY_BEHAVIOR_LABELS } from './prompt-config-policy.ts'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './prompts.module.css'

const styles = { ...sharedCss, ...featureCss }

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
export function OptionField(props: { label: string; hint?: string; className?: string; value: string | undefined; options: readonly string[]; fallback: string; onChange: (value: string) => void; keepCurrent?: boolean; labels?: Record<string, string> }): ReactNode {
  const options = props.keepCurrent === true ? selectOptions(props.options, props.value) : props.options.map((item) => ({ value: item, label: item }))
  return (
    <FormField label={props.label} hint={props.hint} hintMode="tooltip" className={props.className}>
      <MenuSelect
        className={clsx(styles.configInput, styles.fieldControl)}
        ariaLabel={props.label}
        value={props.keepCurrent === true
          ? (props.value ?? props.fallback)
          : selectValue(props.options, props.value, props.fallback)}
        options={options.map((item) => ({ ...item, label: props.labels?.[item.value] ?? item.label }))}
        onChange={props.onChange}
      />
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
function ParamToggle(props: { label: string; hint?: string; className?: string; checked: boolean; onChange: (checked: boolean) => void }): ReactNode {
  const control = (
    <label className={styles.configEnable}>
      <input type="checkbox" aria-label={props.label} checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span className={styles.switch} aria-hidden="true"><i /></span>
    </label>
  )
  return (
    <div className={clsx(styles.configToggleField, props.className)}>
      <span className={styles.configFieldLabel}>{props.label}</span>
      {props.hint === undefined ? control : <HintTooltip label={props.hint}>{control}</HintTooltip>}
    </div>
  )
}

/** params 文本域（结构化编辑用）：失焦写入草稿 params。 */
function ParamTextarea(props: { label: string; hint?: string; className?: string; value: string; onChange: (value: string) => void }): ReactNode {
  return (
    <FormField label={props.label} hint={props.hint} hintMode="tooltip" className={props.className}>
      <textarea
        className={styles.configTextarea}
        aria-label={props.label}
        value={props.value}
        spellCheck={false}
        onChange={(e) => { autoResizeTextarea(e); props.onChange(e.target.value) }}
      />
    </FormField>
  )
}

/** params 单行文本域（结构化编辑用）。 */
function ParamInput(props: { label: string; hint?: string; className?: string; value: string; onChange: (value: string) => void }): ReactNode {
  return (
    <FormField label={props.label} hint={props.hint} hintMode="tooltip" className={props.className}>
      <input className={clsx(styles.configInput, styles.fieldControl)} value={props.value} spellCheck={false} onChange={(e) => props.onChange(e.target.value)} />
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
    // system-section 层参数：段名（空则引擎回退 id 注册为普通段）与 complete（独占
    // system prompt）。人设不走本层：preset.yml 顶层 persona 段（官方
    // @deepseek-ai/dsh-persona 行同构）由「人设」卡编辑。
    return (
      <>
        <ParamInput className={styles.fieldSpan3} label="段名" hint="留空时使用配置标识；同名段会覆盖已有段" value={str('sectionName')} onChange={(next) => set('sectionName', next)} />
        <ParamToggle className={styles.fieldSpan3} label="独占" hint="开启后系统提示只保留本段；同一预设只能启用一个"
          checked={bool('complete')} onChange={(next) => set('complete', next)} />
        <ParamToggle className={styles.fieldSpan3} label="动态抑制" hint="开启后不附加运行时上下文"
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
          <p className={clsx(styles.configFieldHint, styles.fieldFull)}>锚定开关与文本由设置页「锚定」管理；重建预设会覆盖此处。</p>
        )}
        {!managed && (
          <>
            <ParamToggle className={styles.fieldSpan4} label="自定义" hint="开启后固定使用自定义锚文本；关闭后按任务自动选择"
              checked={bool('useCustom')} onChange={(next) => set('useCustom', next)} />
            <ParamTextarea className={styles.fieldFull} label="自定义锚文本" hint="启用自定义时固定注入此文本" value={str('text')} onChange={(next) => set('text', next)} />
            <ParamInput className={styles.fieldSpan6} label="构建任务规则" hint="命中后使用构建引导" value={str('buildPattern')} onChange={(next) => set('buildPattern', next)} />
            <ParamInput className={styles.fieldSpan6} label="复杂任务规则" hint="命中后使用深度引导" value={str('complexPattern')} onChange={(next) => set('complexPattern', next)} />
            <ParamTextarea className={styles.fieldFull} label="构建引导" value={str('firstTurnBuild')} onChange={(next) => set('firstTurnBuild', next)} />
            <ParamTextarea className={styles.fieldFull} label="排查引导" value={str('firstTurnInspect')} onChange={(next) => set('firstTurnInspect', next)} />
            <ParamTextarea className={styles.fieldFull} label="深度引导" value={str('firstTurnDeep')} onChange={(next) => set('firstTurnDeep', next)} />
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
          <p className={clsx(styles.configFieldHint, styles.fieldFull)}>引导开关与文本由设置页「引导」管理；重建预设会覆盖此处。</p>
        )}
        {!managed && (
          <>
            <ParamToggle className={styles.fieldSpan4} label="自定义" hint="开启后固定使用自定义引导；关闭后按任务自动选择"
              checked={bool('useCustom')} onChange={(next) => set('useCustom', next)} />
            <ParamTextarea className={styles.fieldFull} label="自定义引导" hint="启用自定义时固定注入此文本" value={str('text')} onChange={(next) => set('text', next)} />
            <p className={clsx(styles.configFieldHint, styles.fieldFull)}>复杂任务沿用锚定模块的复杂任务规则。</p>
            <ParamTextarea className={styles.fieldFull} label="简短引导" value={str('guideWeak')} onChange={(next) => set('guideWeak', next)} />
            <ParamTextarea className={styles.fieldFull} label="深度引导" value={str('guideDeep')} onChange={(next) => set('guideDeep', next)} />
          </>
        )}
      </>
    )
  }
  if (strategy === 'custom-fallback') {
    return (
      <>
        <ParamInput className={styles.fieldSpan6} label="触发词" hint="晋升后的首个推理内容命中此词时注入"
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
        <ParamToggle className={styles.fieldSpan3} label="常驻" hint="开启后每轮注入；关闭后仅关键词命中时注入"
          checked={bool('constant')} onChange={(next) => set('constant', next)} />
        <div className={styles.fieldSpan6}><TagInput id={`${keyId}-keys`} label="主关键词" hint="消息命中任一关键词时注入" hintMode="tooltip" onCommit={() => {}}
          value={list('keys')} placeholder="关键字，回车添加" onChange={(next) => setList('keys', next)} /></div>
        <div className={styles.fieldSpan6}><TagInput id={`${keyId}-secondary-keys`} label="次关键词" hint="与主关键词共同参与触发判断" hintMode="tooltip" onCommit={() => {}}
          value={list('secondaryKeys')} placeholder="次级关键字，回车添加" onChange={(next) => setList('secondaryKeys', next)} /></div>
        <ParamToggle className={styles.fieldSpan3} label="区分大小写" hint="开启后关键词必须匹配大小写"
          checked={bool('caseSensitive')} onChange={(next) => set('caseSensitive', next)} />
        <ParamToggle className={styles.fieldSpan3} label="整词匹配" hint="开启后关键词必须作为完整词出现"
          checked={bool('wholeWords')} onChange={(next) => set('wholeWords', next)} />
        <ParamToggle className={styles.fieldSpan3} label="正则匹配" hint="开启后主次关键词按正则表达式匹配"
          checked={bool('useRegex')} onChange={(next) => set('useRegex', next)} />
        <OptionField
          className={styles.fieldSpan6}
          label="触发逻辑"
          hint="控制主关键词与次关键词的组合判断方式"
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
    const emptyBehavior = str('emptyBehavior') || 'skip'
    return (
      <>
        <ParamTextarea className={styles.fieldFull} label="自定义提示" hint="覆盖文件和动态探测内容；留空时使用默认值"
          value={str('text')} onChange={(next) => set('text', next)} />
        <ParamInput className={styles.fieldSpan5} label="环境变量" hint="允许读取的环境变量；逗号分隔，留空时使用默认值"
          value={str('envKeys')} onChange={(next) => set('envKeys', next)} />
        <ParamInput className={styles.fieldSpan2} label="数量上限" hint="填写正整数；留空时不限制"
          value={str('limit')} onChange={(next) => set('limit', next === '' ? '' : Number(next))} />
        <ParamInput className={styles.fieldSpan5} label="返回字段" hint="技能目录返回的字段；逗号分隔"
          value={str('fields')} onChange={(next) => set('fields', next)} />
        <ParamInput className={styles.fieldSpan6} label="来源白名单" hint="允许使用的技能来源；逗号分隔，留空时允许全部"
          value={str('providers')} onChange={(next) => set('providers', next)} />
        <OptionField className={styles.fieldSpan3} label="空结果处理" hint="无内容时选择跳过或注入提示文本"
          value={emptyBehavior} options={['skip', 'text']} fallback="skip" labels={EMPTY_BEHAVIOR_LABELS} onChange={(next) => set('emptyBehavior', next)} />
        {emptyBehavior === 'text' && (
          <ParamTextarea className={styles.fieldFull} label="空结果提示" value={str('emptyText')} onChange={(next) => set('emptyText', next)} />
        )}
      </>
    )
  }
  // 无策略参数的配置（static 等）：预设级内容变量已展开进 variables（官方插值
  // 机制，由上方 VariablesEditor 结构化编辑），params 为空时不再渲染 JSON 框。
  if (Object.keys(value).length === 0) {
    return <p className={styles.configFieldHint}>本策略无额外参数；模板变量可在上方编辑。</p>
  }
  return <JsonField label="高级参数（JSON）" value={value} onChange={(next) => { if (next !== undefined) onPatch(next) }} />
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
      <span className={styles.variableHeader}>
        <span className={styles.variableHeaderCopy}>
          <span className={styles.configFieldLabel}>模板变量</span>
          {entries.length === 0 && <span className={styles.configFieldHint}>{'暂无变量；可使用 {{key}} 引用。'}</span>}
        </span>
        <button type="button" className={styles.pillButton} onClick={() => commit([...entries, ['', '']])}>添加</button>
      </span>
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
    </span>
  )
}
