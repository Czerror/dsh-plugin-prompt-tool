import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FieldDraft } from '../../data/workspace-drafts.ts'
import { FormField } from '../../ui/FormField.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { TagInput } from '../../ui/TagInput.tsx'
import type { PromptToolLocaleKey, PromptToolTranslate } from '../../locales.ts'
import { autoResizeTextarea } from './textarea-resize.ts'
import { EMPTY_BEHAVIOR_LABEL_KEYS, translateLabel } from './prompt-config-policy.ts'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './prompts.module.css'

const styles = { ...sharedCss, ...featureCss }

/** 世界书触发逻辑（selectiveLogic 0-3）的显示键。 */
const SELECTIVE_LOGIC_LABEL_KEYS: Record<string, PromptToolLocaleKey> = {
  '0': 'selectiveLogic.0',
  '1': 'selectiveLogic.1',
  '2': 'selectiveLogic.2',
  '3': 'selectiveLogic.3',
}

function selectOptions(t: PromptToolTranslate, options: readonly string[], value: string | undefined): Array<{ value: string; label: string }> {
  const current = value ?? ''
  const entries = options.map((item) => ({ value: item, label: item === '' ? t('field.default') : item }))
  if (current !== '' && !options.includes(current)) entries.push({ value: current, label: t('field.current', { value: current }) })
  return entries
}

/** 共享枚举下拉：保持未知当前值可见，避免旧配置无法编辑。 */
export function OptionField(props: { t: PromptToolTranslate; label: string; hint?: string; className?: string; value: string | undefined; options: readonly string[]; fallback: string; onChange: (value: string) => void; keepCurrent?: boolean; labelKeys?: Record<string, PromptToolLocaleKey>; disabled?: boolean }): ReactNode {
  const options = selectOptions(props.t, props.options, props.value)
  return (
    <FormField label={props.label} hint={props.hint} hintMode="tooltip" className={props.className}>
      <MenuSelect
        className={clsx(styles.configInput, styles.fieldControl)}
        ariaLabel={props.label}
        disabled={props.disabled}
        value={props.value ?? props.fallback}
        options={options.map((item) => ({ ...item, label: props.labelKeys === undefined ? item.label : translateLabel(props.t, props.labelKeys, item.value) }))}
        onChange={props.onChange}
      />
    </FormField>
  )
}
/** JSON 对象文本域：解析失败只在本地标红，不污染草稿。 */
export function JsonField(props: { t: PromptToolTranslate; label: string; value: Record<string, unknown> | undefined; onChange: (value: Record<string, unknown> | undefined) => void; fieldDrafts?: Map<string, FieldDraft>; draftKey?: string; disabled?: boolean }): ReactNode {
  // 依赖序列化结果而非对象引用：父级 patch 会让 params 产生新引用（即使内容未变），
  // 旧写法会把用户未提交的编辑重置；引用不变时 useMemo 不再重复序列化。
  const serialized = useMemo(() => JSON.stringify(props.value ?? {}, null, 2), [props.value])
  const [draft, updateDraft] = useFieldDraft(props.fieldDrafts, props.draftKey, serialized)
  const { text, error } = draft
  const commit = () => {
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        updateDraft({ ...draft, error: props.t('field.json.mustBeObject') })
        return
      }
      props.onChange(parsed as Record<string, unknown>)
      const canonical = JSON.stringify(parsed, null, 2)
      updateDraft({ source: canonical, text: canonical, error: '' })
    } catch {
      updateDraft({ ...draft, error: props.t('field.json.invalid') })
    }
  }
  return (
    <FormField className={styles.fieldFull} label={props.label} error={error}>
      <textarea
        className={clsx(styles.configTextarea, styles.configJsonInput, error && styles.configInputError)}
        aria-label={props.label}
        value={text}
        readOnly={props.disabled}
        spellCheck={false}
        onChange={(e) => { autoResizeTextarea(e); updateDraft({ ...draft, text: e.target.value, error: '' }) }}
        onBlur={commit}
      />
    </FormField>
  )
}

/** 原始输入归工作台；视图卸载不清理尚未接受的 JSON 或数字中间态。 */
function useFieldDraft(fields: Map<string, FieldDraft> | undefined, key: string | undefined, source: string): [FieldDraft, (next: FieldDraft) => void] {
  const [draft, setDraft] = useState<FieldDraft>(() => (key === undefined ? undefined : fields?.get(key)) ?? { source, text: source, error: '' })
  const update = (next: FieldDraft): void => { if (key !== undefined) fields?.set(key, next); setDraft(next) }
  useEffect(() => {
    if (draft.source !== source && draft.text === draft.source && !draft.error) update({ source, text: source, error: '' })
  }, [source])
  return [draft, update]
}

export function NumberField(props: { t: PromptToolTranslate; label: string; hint?: string; className?: string; value: number | string | undefined; fallback?: number | string; integer?: boolean; min?: number; disabled?: boolean; fieldDrafts?: Map<string, FieldDraft>; draftKey?: string; onChange: (value: number | string | undefined) => void }): ReactNode {
  const [draft, update] = useFieldDraft(props.fieldDrafts, props.draftKey, String(props.value ?? props.fallback ?? ''))
  const commit = (): void => {
    if (props.disabled) return
    const next = draft.text.trim() === '' ? props.fallback : Number(draft.text)
    if (typeof next === 'number' && (!Number.isFinite(next) || (props.integer && !Number.isSafeInteger(next)) || (props.min !== undefined && next < props.min))) {
      update({ ...draft, error: props.t(props.integer ? 'field.number.integer' : 'field.number.invalid') })
      return
    }
    props.onChange(next)
    const accepted = String(next ?? '')
    update({ source: accepted, text: accepted, error: '' })
  }
  return <FormField label={props.label} hint={props.hint} hintMode="tooltip" className={props.className} error={draft.error}>
    <input className={clsx(styles.configInput, styles.fieldControl, styles.configNumberInput)} inputMode={props.integer ? 'numeric' : 'decimal'}
      value={draft.text} readOnly={props.disabled} onChange={(event) => update({ ...draft, text: event.target.value, error: '' })} onBlur={commit} />
  </FormField>
}

/** 布尔开关行（params 结构化编辑用）。 */
function ParamToggle(props: { label: string; hint?: string; className?: string; checked: boolean; onChange: (checked: boolean) => void }): ReactNode {
  const control = (
    <span className={styles.configEnable}><Switch label={props.label} checked={props.checked} onChange={props.onChange} /></span>
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
export function StrategyParamsFields(props: { t: PromptToolTranslate; strategy: string; layer?: string; params: Record<string, unknown> | undefined; onPatch: (params: Record<string, unknown>) => void; id?: string; fieldDrafts?: Map<string, FieldDraft>; draftScope?: string }): ReactNode {
  const { strategy, layer, params, onPatch, id } = props
  const t = props.t
  const value = params ?? {}
  const keyId = useId()
  const str = (key: string): string => (typeof value[key] === 'string' ? value[key] as string : '')
  const bool = (key: string): boolean => value[key] === true
  const set = (key: string, next: unknown): void => onPatch({ ...value, [key]: next })
  if (layer === 'system-section') {
    // system-section 层参数：段名（空则引擎回退 id 注册为普通段）与 complete（独占
    // system prompt）。人设不走本层：preset.yml 顶层 persona 段（官方
    // @deepseek-ai/dsh-persona 行同构）由「人设」卡编辑。
    return (
      <>
        <ParamInput className={styles.fieldSpan3} label={t('strategyParam.sectionName.label')} hint={t('strategyParam.sectionName.hint')} value={str('sectionName')} onChange={(next) => set('sectionName', next)} />
        <ParamToggle className={styles.fieldSpan3} label={t('strategyParam.complete.label')} hint={t('strategyParam.complete.hint')}
          checked={bool('complete')} onChange={(next) => set('complete', next)} />
        <ParamToggle className={styles.fieldSpan3} label={t('strategyParam.suppressRuntimeContext.label')} hint={t('strategyParam.suppressRuntimeContext.hint')}
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
          <p className={clsx(styles.configFieldHint, styles.fieldFull)}>{t('strategyParam.anchorManaged')}</p>
        )}
        {!managed && (
          <>
            <ParamToggle className={styles.fieldSpan4} label={t('strategyParam.custom.label')} hint={t('strategyParam.custom.hint')}
              checked={bool('useCustom')} onChange={(next) => set('useCustom', next)} />
            <ParamTextarea className={styles.fieldFull} label={t('strategyParam.anchorText.label')} hint={t('strategyParam.anchorText.hint')} value={str('text')} onChange={(next) => set('text', next)} />
            <ParamInput className={styles.fieldSpan6} label={t('strategyParam.buildPattern.label')} hint={t('strategyParam.buildPattern.hint')} value={str('buildPattern')} onChange={(next) => set('buildPattern', next)} />
            <ParamInput className={styles.fieldSpan6} label={t('strategyParam.complexPattern.label')} hint={t('strategyParam.complexPattern.hint')} value={str('complexPattern')} onChange={(next) => set('complexPattern', next)} />
            <ParamTextarea className={styles.fieldFull} label={t('strategyParam.firstTurnBuild')} value={str('firstTurnBuild')} onChange={(next) => set('firstTurnBuild', next)} />
            <ParamTextarea className={styles.fieldFull} label={t('strategyParam.firstTurnInspect')} value={str('firstTurnInspect')} onChange={(next) => set('firstTurnInspect', next)} />
            <ParamTextarea className={styles.fieldFull} label={t('strategyParam.deepGuide')} value={str('firstTurnDeep')} onChange={(next) => set('firstTurnDeep', next)} />
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
          <p className={clsx(styles.configFieldHint, styles.fieldFull)}>{t('strategyParam.guideManaged')}</p>
        )}
        {!managed && (
          <>
            <ParamToggle className={styles.fieldSpan4} label={t('strategyParam.custom.label')} hint={t('strategyParam.custom.hint')}
              checked={bool('useCustom')} onChange={(next) => set('useCustom', next)} />
            <ParamTextarea className={styles.fieldFull} label={t('strategyParam.guideText.label')} hint={t('strategyParam.guideText.hint')} value={str('text')} onChange={(next) => set('text', next)} />
            <p className={clsx(styles.configFieldHint, styles.fieldFull)}>{t('strategyParam.guideReuse')}</p>
            <ParamTextarea className={styles.fieldFull} label={t('strategyParam.guideWeak')} value={str('guideWeak')} onChange={(next) => set('guideWeak', next)} />
            <ParamTextarea className={styles.fieldFull} label={t('strategyParam.deepGuide')} value={str('guideDeep')} onChange={(next) => set('guideDeep', next)} />
          </>
        )}
      </>
    )
  }
  if (strategy === 'custom-fallback') {
    return (
      <>
        <ParamInput className={styles.fieldSpan6} label={t('strategyParam.firstTurnWord.label')} hint={t('strategyParam.firstTurnWord.hint')}
          value={str('firstTurnWord')} onChange={(next) => set('firstTurnWord', next)} />
      </>
    )
  }
  if (strategy === 'world-book') {
    const list = (key: string): string => Array.isArray(value[key])
      ? (value[key] as unknown[]).map(String).join(', ') : str(key)
    const setList = (key: string, next: string): void => set(key, next.split(',').map((item) => item.trim()).filter((item) => item.length > 0))
    return (
      <>
        <ParamToggle className={styles.fieldSpan3} label={t('strategyParam.constant.label')} hint={t('strategyParam.constant.hint')}
          checked={bool('constant')} onChange={(next) => set('constant', next)} />
        <div className={styles.fieldSpan6}><TagInput id={`${keyId}-keys`} label={t('strategyParam.keys.label')} hint={t('strategyParam.keys.hint')} hintMode="tooltip" onCommit={() => {}}
          value={list('keys')} placeholder={t('strategyParam.keys.placeholder')} onChange={(next) => setList('keys', next)} /></div>
        <div className={styles.fieldSpan6}><TagInput id={`${keyId}-secondary-keys`} label={t('strategyParam.secondaryKeys.label')} hint={t('strategyParam.secondaryKeys.hint')} hintMode="tooltip" onCommit={() => {}}
          value={list('secondaryKeys')} placeholder={t('strategyParam.secondaryKeys.placeholder')} onChange={(next) => setList('secondaryKeys', next)} /></div>
        <ParamToggle className={styles.fieldSpan3} label={t('strategyParam.caseSensitive.label')} hint={t('strategyParam.caseSensitive.hint')}
          checked={bool('caseSensitive')} onChange={(next) => set('caseSensitive', next)} />
        <ParamToggle className={styles.fieldSpan3} label={t('strategyParam.wholeWords.label')} hint={t('strategyParam.wholeWords.hint')}
          checked={bool('wholeWords')} onChange={(next) => set('wholeWords', next)} />
        <ParamToggle className={styles.fieldSpan3} label={t('strategyParam.useRegex.label')} hint={t('strategyParam.useRegex.hint')}
          checked={bool('useRegex')} onChange={(next) => set('useRegex', next)} />
        <OptionField
          t={t}
          className={styles.fieldSpan6}
          label={t('strategyParam.selectiveLogic.label')}
          hint={t('strategyParam.selectiveLogic.hint')}
          value={value['selectiveLogic'] !== undefined ? String(value['selectiveLogic']) : '0'}
          options={['0', '1', '2', '3']}
          fallback="0"
          labelKeys={SELECTIVE_LOGIC_LABEL_KEYS}
          onChange={(next) => set('selectiveLogic', Number(next))}
        />
      </>
    )
  }
  if (strategy === 'placeholder' || strategy === 'instruction-hint') {
    const emptyBehavior = str('emptyBehavior') || 'skip'
    return (
      <>
        <ParamTextarea className={styles.fieldFull} label={t('strategyParam.fillText.label')} hint={t('strategyParam.fillText.hint')}
          value={str('text')} onChange={(next) => set('text', next)} />
        <ParamInput className={styles.fieldSpan5} label={t('strategyParam.envKeys.label')} hint={t('strategyParam.envKeys.hint')}
          value={str('envKeys')} onChange={(next) => set('envKeys', next)} />
        <NumberField t={t} className={styles.fieldSpan2} label={t('strategyParam.limit.label')} hint={t('strategyParam.limit.hint')}
          value={typeof value.limit === 'number' || typeof value.limit === 'string' ? value.limit : ''} fallback=""
          fieldDrafts={props.fieldDrafts} draftKey={`${props.draftScope}:params.limit`} onChange={(next) => set('limit', next)} />
        <ParamInput className={styles.fieldSpan5} label={t('strategyParam.fields.label')} hint={t('strategyParam.fields.hint')}
          value={str('fields')} onChange={(next) => set('fields', next)} />
        <ParamInput className={styles.fieldSpan6} label={t('strategyParam.providers.label')} hint={t('strategyParam.providers.hint')}
          value={str('providers')} onChange={(next) => set('providers', next)} />
        <OptionField t={t} className={styles.fieldSpan3} label={t('strategyParam.emptyBehavior.label')} hint={t('strategyParam.emptyBehavior.hint')}
          value={emptyBehavior} options={['skip', 'text']} fallback="skip" labelKeys={EMPTY_BEHAVIOR_LABEL_KEYS} onChange={(next) => set('emptyBehavior', next)} />
        {emptyBehavior === 'text' && (
          <ParamTextarea className={styles.fieldFull} label={t('strategyParam.emptyText')} value={str('emptyText')} onChange={(next) => set('emptyText', next)} />
        )}
      </>
    )
  }
  // 无策略参数的配置（static 等）：预设级内容变量已展开进 variables（官方插值
  // 机制，由上方 VariablesEditor 结构化编辑），params 为空时不再渲染 JSON 框。
  if (Object.keys(value).length === 0) {
    return <p className={styles.configFieldHint}>{t('strategyParam.noParams')}</p>
  }
  return <JsonField t={t} label={t('field.json.advanced')} value={value} fieldDrafts={props.fieldDrafts} draftKey={`${props.draftScope}:params`} onChange={(next) => { if (next !== undefined) onPatch(next) }} />
}

/** 模板变量键值对编辑器（替代 JSON）：每行 key + value，可增删。工作台「模板变量」卡片复用。 */
export function VariablesEditor(props: { t: PromptToolTranslate; value: Record<string, string> | undefined; disabled?: boolean; onChange: (value: Record<string, string> | undefined) => void }): ReactNode {
  const t = props.t
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
          <span className={styles.configFieldLabel}>{t('variables.title')}</span>
          {entries.length === 0 && <span className={styles.configFieldHint}>{t('variables.empty')}</span>}
        </span>
        <button type="button" className={styles.pillButton} disabled={props.disabled} onClick={() => commit([...entries, ['', '']])}>{t('variables.add')}</button>
      </span>
      {entries.map(([key, value], index) => (
        <span key={`${key}-${index}`} className={styles.variableRow}>
          <input className={styles.configInput} aria-label={t('variables.nameAria')} value={key} spellCheck={false} placeholder={t('variables.namePlaceholder')} readOnly={props.disabled}
            onChange={(e) => setEntry(index, e.target.value, value)} />
          <input className={styles.configInput} aria-label={t('variables.valueAria')} value={value} spellCheck={false} placeholder={t('variables.valuePlaceholder')} readOnly={props.disabled}
            onChange={(e) => setEntry(index, key, e.target.value)} />
          <button type="button" className={styles.pillButton} data-danger aria-label={t('variables.removeAria', { name: key || index })} disabled={props.disabled}
            onClick={() => commit(entries.filter((_, at) => at !== index))}>{t('variables.delete')}</button>
        </span>
      ))}
    </span>
  )
}
