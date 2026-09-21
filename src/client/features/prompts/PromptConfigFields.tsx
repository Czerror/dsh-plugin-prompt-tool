import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FieldDraft } from '../../data/workspace-drafts.ts'
import { FormField } from '../../ui/FormField.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { TagInput } from '../../ui/TagInput.tsx'
import type { PromptToolLocaleKey, PromptToolTranslate } from '../../locales.ts'
import type { PromptConfigMatch } from '../../prompt-tool-types.ts'
import { managedConfigSpec, managedFieldValue, type ConfigFieldSources, type ManagedConfigSpec } from '../../../shared/managed-config-fields.ts'
import { autoResizeTextarea } from './textarea-resize.ts'
import { EMPTY_BEHAVIOR_LABEL_KEYS, MATCH_LOGIC_LABEL_KEYS, MATCH_LOGICS, MATCH_REGEX_MODE_LABEL_KEYS, MATCH_REGEX_MODES, normalizeMatch, translateLabel } from './prompt-config-policy.ts'
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

/**
 * 层专属实例字段的键清单（与 engine/layers.mjs 的真实消费一一对应）：
 * 末尾的 JSON 兜底按此剔除已结构化的键，同一取值不会同时出现两份输入。
 * turn-stop（续跑上限是引擎常量）与 subagent-end（只观察、无注入通道）没有可写
 * 实例字段，故不在此表——它们只拿到只读说明。
 */
const LAYER_PARAM_KEYS: Record<string, readonly string[]> = {
  'runtime-context': ['contextName'],
  'agent-request': ['patch', 'replace'],
  'llm-stream': ['mode'],
  'tool-pipeline': ['toolNames', 'preDecision', 'denyReason', 'postAction'],
}

/** 只读层的说明键：没有可写参数是设计事实，用一句说明代替空白的策略区。 */
const LAYER_READ_ONLY_NOTES: Record<string, PromptToolLocaleKey> = {
  'turn-stop': 'strategyParam.turnStopNote',
  'subagent-end': 'strategyParam.subagentEndNote',
}

/** 引擎枚举 → 显示键：未知旧值仍由 OptionField 自己保留，避免旧配置无法编辑。 */
const LLM_STREAM_MODE_LABEL_KEYS: Record<string, PromptToolLocaleKey> = {
  pass: 'strategyParam.mode.pass',
  replace: 'strategyParam.mode.replace',
}
const PRE_DECISION_LABEL_KEYS: Record<string, PromptToolLocaleKey> = {
  allow: 'strategyParam.preDecision.allow',
  deny: 'strategyParam.preDecision.deny',
  ask: 'strategyParam.preDecision.ask',
}
const POST_ACTION_LABEL_KEYS: Record<string, PromptToolLocaleKey> = {
  accept: 'strategyParam.postAction.accept',
  replace: 'strategyParam.postAction.replace',
  block: 'strategyParam.postAction.block',
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

/** 布尔开关行（params 结构化编辑与条件判定开关共用）；disabled 只用于条件判定区（策略区整体在 fieldset 内）。 */
function ParamToggle(props: { label: string; hint?: string; className?: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }): ReactNode {
  const control = (
    <span className={styles.configEnable}><Switch label={props.label} checked={props.checked} disabled={props.disabled} onChange={props.onChange} /></span>
  )
  return (
    <div className={clsx(styles.configToggleField, props.className)}>
      <span className={styles.configFieldLabel}>{props.label}</span>
      {props.hint === undefined ? control : <HintTooltip label={props.hint}>{control}</HintTooltip>}
    </div>
  )
}

/**
 * 条件判定的 match 编辑器（网格片段，由表单的注入规则区承载）：
 * 主键 / 副键集合 + 组合逻辑 + 三个匹配开关。键按字面文本匹配，`/pattern/flags`
 * 形态或「正则匹配」开关才走正则；每次编辑都经 {@link normalizeMatch} 归一，
 * 无有效键时整段 match 被清空（引擎要求至少一个非空键）。
 */
export function MatchFields(props: { t: PromptToolTranslate; value: PromptConfigMatch | undefined; disabled?: boolean; onChange: (value: PromptConfigMatch | undefined) => void }): ReactNode {
  const t = props.t
  const value = props.value
  const keyId = useId()
  const listOf = (key: 'keys' | 'secondaryKeys'): string => (value?.[key] ?? []).join(', ')
  const setKeys = (key: 'keys' | 'secondaryKeys', next: string): void => {
    // TagInput 以逗号分隔字符串承载键集合（与世界书参数编辑器同形态）。
    props.onChange(normalizeMatch({ ...value, [key]: next.split(',').map((item) => item.trim()).filter((item) => item.length > 0) }))
  }
  const setFlag = (key: 'caseSensitive' | 'wholeWords', next: boolean): void => {
    props.onChange(normalizeMatch({ ...value, [key]: next }))
  }
  const regexMode = value?.useRegex === undefined ? 'auto' : (value.useRegex === true ? 'force' : 'literal')
  return (
    <>
      <p className={clsx(styles.configFieldHint, styles.fieldFull)}>{t('form.match.hint')}</p>
      <div className={styles.fieldSpan6}><TagInput id={`${keyId}-match-keys`} label={t('form.match.keys.label')} hint={t('form.match.keys.hint')} hintMode="tooltip" disabled={props.disabled} onCommit={() => {}}
        value={listOf('keys')} placeholder={t('form.match.keys.placeholder')} onChange={(next) => setKeys('keys', next)} /></div>
      <div className={styles.fieldSpan6}><TagInput id={`${keyId}-match-secondary-keys`} label={t('form.match.secondaryKeys.label')} hint={t('form.match.secondaryKeys.hint')} hintMode="tooltip" disabled={props.disabled} onCommit={() => {}}
        value={listOf('secondaryKeys')} placeholder={t('form.match.secondaryKeys.placeholder')} onChange={(next) => setKeys('secondaryKeys', next)} /></div>
      <OptionField t={t} className={styles.fieldSpan3} label={t('form.match.logic.label')} hint={t('form.match.logic.hint')}
        value={value?.logic} options={MATCH_LOGICS} fallback="any" labelKeys={MATCH_LOGIC_LABEL_KEYS} disabled={props.disabled}
        onChange={(next) => props.onChange(normalizeMatch({ ...value, logic: next as PromptConfigMatch['logic'] }))} />
      <ParamToggle className={styles.fieldSpan3} label={t('form.match.caseSensitive.label')} hint={t('form.match.caseSensitive.hint')} disabled={props.disabled}
        checked={value?.caseSensitive === true} onChange={(next) => setFlag('caseSensitive', next)} />
      <ParamToggle className={styles.fieldSpan3} label={t('form.match.wholeWords.label')} hint={t('form.match.wholeWords.hint')} disabled={props.disabled}
        checked={value?.wholeWords === true} onChange={(next) => setFlag('wholeWords', next)} />
      <OptionField t={t} className={styles.fieldSpan3} label={t('form.match.useRegex.label')} hint={t('form.match.useRegex.hint')}
        value={regexMode} options={MATCH_REGEX_MODES} fallback="auto" labelKeys={MATCH_REGEX_MODE_LABEL_KEYS} disabled={props.disabled}
        onChange={(next) => props.onChange(normalizeMatch({
          ...value,
          useRegex: next === 'auto' ? undefined : next === 'force',
        }))} />
    </>
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

/** 仅展示 host 确认来自参数投影的字段；白名单提供来源参数标签。 */
function ManagedFieldsPanel(props: {
  t: PromptToolTranslate
  spec: ManagedConfigSpec
  config: { enabled?: boolean; modelScope?: string; params?: Record<string, unknown> }
}): ReactNode {
  const { t, spec } = props
  return (
    <div className={clsx(styles.configFieldHint, styles.fieldFull)} data-managed-config={spec.configId}>
      <p>{t(spec.configId === 'near-anchor' ? 'strategyParam.anchorManaged' : 'strategyParam.guideManaged')}</p>
      <ul>
        {spec.fields.map((field) => {
          const value = managedFieldValue(field, props.config)
          const shown = value === undefined || value === null || value === ''
            ? t('strategyParam.managed.empty')
            : typeof value === 'boolean' ? t(value ? 'param.on' : 'param.off') : String(value)
          const note = field.derived === true
            ? t('strategyParam.managed.derived')
            : field.fallbackNote === 'followsAnchor'
              ? t('strategyParam.managed.followsAnchor')
              : field.fallbackNote === 'followsCustom' ? t('strategyParam.managed.followsCustom') : undefined
          return (
            <li key={field.path} data-managed-path={field.path} data-managed-source={field.sourceParam}>
              {t(`param.${field.sourceParam}`)} · {t('strategyParam.managed.source', { param: field.sourceParam })} · {shown}
              {note === undefined ? undefined : <> · {note}</>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * 按 layer / strategy 拆解 params 为结构化编辑框（替代裸 JSON）：
 *   层专属 → system-section（段名/独占/动态抑制）、runtime-context（注册名）、
 *   agent-request（patch/replace）、llm-stream（mode）、tool-pipeline（toolNames/裁决）；
 *   first-turn-anchor → near-anchor 锚点参数（开关/锚文本/任务正则/引导句）；
 *   guide-auto → router-guide 每轮引导参数（开关/文本/复杂正则/强弱引导句）；
 *   custom-fallback → prompt-injector 锚定词（params.text 为运行时注入内容，不暴露编辑）；
 *   placeholder / instruction-hint → fill 模板参数（text/envKeys/limit/fields/providers/emptyBehavior/emptyText）；
 * 无固定字段的策略回退 JSON 编辑（保留任意 params 能力）。
 */
export function StrategyParamsFields(props: { t: PromptToolTranslate; strategy: string; layer?: string; params: Record<string, unknown> | undefined; onPatch: (params: Record<string, unknown>) => void; id?: string; fieldSources?: ConfigFieldSources; enabled?: boolean; modelScope?: string; fieldDrafts?: Map<string, FieldDraft>; draftScope?: string }): ReactNode {
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
    // 未结构化的键仍走高级 JSON：手写/导入的其它 params（例如 stMacros）不被吞掉，
    // 提交时把结构化值并回，避免保存一次丢掉段名与 complete。
    const sectionKeys = ['sectionName', 'complete', 'suppressRuntimeContext']
    const sectionRest = Object.fromEntries(Object.entries(value).filter(([key]) => !sectionKeys.includes(key)))
    const sectionCovered = Object.fromEntries(Object.entries(value).filter(([key]) => sectionKeys.includes(key)))
    return (
      <>
        <ParamInput className={styles.fieldSpan3} label={t('strategyParam.sectionName.label')} hint={t('strategyParam.sectionName.hint')} value={str('sectionName')} onChange={(next) => set('sectionName', next)} />
        <ParamToggle className={styles.fieldSpan3} label={t('strategyParam.complete.label')} hint={t('strategyParam.complete.hint')}
          checked={bool('complete')} onChange={(next) => set('complete', next)} />
        <ParamToggle className={styles.fieldSpan3} label={t('strategyParam.suppressRuntimeContext.label')} hint={t('strategyParam.suppressRuntimeContext.hint')}
          checked={bool('suppressRuntimeContext')} onChange={(next) => set('suppressRuntimeContext', next)} />
        {Object.keys(sectionRest).length > 0 && (
          <JsonField t={t} label={t('field.json.advanced')} value={sectionRest} fieldDrafts={props.fieldDrafts}
            draftKey={`${props.draftScope}:params`} onChange={(next) => { if (next !== undefined) onPatch({ ...sectionCovered, ...next }) }} />
        )}
      </>
    )
  }
  const objectOf = (key: string): Record<string, unknown> | undefined => {
    const raw = value[key]
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined
  }
  /**
   * 层专属实例字段：只暴露 engine/layers.mjs 真实消费的 params（留空即引擎缺省），
   * 让此前只能写高级 JSON 的四层有可发现入口。层字段与 strategy 字段正交
   * （runtime-context 的 placeholder 是唯一交集），故先渲染层字段再落到策略分支。
   */
  const layerFields: ReactNode = layer === 'runtime-context' ? (
    <ParamInput className={styles.fieldSpan3} label={t('strategyParam.contextName.label')} hint={t('strategyParam.contextName.hint')}
      value={str('contextName')} onChange={(next) => set('contextName', next)} />
  ) : layer === 'agent-request' ? (
    <>
      {/* patch 是浅合并进冻结 LlmCallConfig 的对象（形态自由故用 JSON）；replace 只认显式 true。 */}
      <JsonField t={t} label={t('strategyParam.patch.label')} value={objectOf('patch')} fieldDrafts={props.fieldDrafts}
        draftKey={`${props.draftScope}:params.patch`} onChange={(next) => set('patch', next)} />
      <ParamToggle className={styles.fieldSpan3} label={t('strategyParam.replace.label')} hint={t('strategyParam.replace.hint')}
        checked={bool('replace')} onChange={(next) => set('replace', next)} />
    </>
  ) : layer === 'llm-stream' ? (
    <OptionField t={t} className={styles.fieldSpan3} label={t('strategyParam.mode.label')} hint={t('strategyParam.mode.hint')}
      value={str('mode')} options={['pass', 'replace']} fallback="pass" labelKeys={LLM_STREAM_MODE_LABEL_KEYS}
      onChange={(next) => set('mode', next)} />
  ) : layer === 'tool-pipeline' ? (
    <>
      {/* toolNames 只能按逗号串写：引擎 parseToolNames 只认字符串，数组会被解析成空
          = 匹配所有工具，把定向门扩大成全工具门。旧数组数据按同形态回显，编辑即写成字符串。 */}
      <ParamInput className={styles.fieldSpan6} label={t('strategyParam.toolNames.label')} hint={t('strategyParam.toolNames.hint')}
        value={Array.isArray(value['toolNames']) ? (value['toolNames'] as unknown[]).map(String).join(', ') : str('toolNames')}
        onChange={(next) => set('toolNames', next)} />
      <OptionField t={t} className={styles.fieldSpan3} label={t('strategyParam.preDecision.label')} hint={t('strategyParam.preDecision.hint')}
        value={str('preDecision')} options={['allow', 'deny', 'ask']} fallback="allow" labelKeys={PRE_DECISION_LABEL_KEYS}
        onChange={(next) => set('preDecision', next)} />
      <ParamInput className={styles.fieldSpan3} label={t('strategyParam.denyReason.label')} hint={t('strategyParam.denyReason.hint')}
        value={str('denyReason')} onChange={(next) => set('denyReason', next)} />
      <OptionField t={t} className={styles.fieldSpan3} label={t('strategyParam.postAction.label')} hint={t('strategyParam.postAction.hint')}
        value={str('postAction')} options={['accept', 'replace', 'block']} fallback="accept" labelKeys={POST_ACTION_LABEL_KEYS}
        onChange={(next) => set('postAction', next)} />
    </>
  ) : undefined
  const known = LAYER_PARAM_KEYS[layer ?? ''] ?? []
  const rest = Object.fromEntries(Object.entries(value).filter(([key]) => !known.includes(key)))
  const covered = Object.fromEntries(Object.entries(value).filter(([key]) => known.includes(key)))
  const readOnlyNote = LAYER_READ_ONLY_NOTES[layer ?? '']

  const managed = managedConfigSpec(id, props.fieldSources)
  const projected = (key: string): boolean => managed?.fields.some((field) => field.path === `params.${key}`) === true
  if (strategy === 'first-turn-anchor' || strategy === 'guide-auto') {
    const anchor = strategy === 'first-turn-anchor'
    return (
      <>
        {managed !== undefined && <ManagedFieldsPanel t={t} spec={managed} config={{ enabled: props.enabled, modelScope: props.modelScope, params: value }} />}
        {props.fieldSources?.configId === id && props.fieldSources?.fields.some((field) => field.source === 'prompt-config') && (
          <p className={clsx(styles.configFieldHint, styles.fieldFull)} data-config-source="prompt-config">{t('strategyParam.managed.local')}</p>
        )}
        {!projected('useCustom') && <ParamToggle className={styles.fieldSpan4} label={t('strategyParam.custom.label')} hint={t('strategyParam.custom.hint')}
          checked={bool('useCustom')} onChange={(next) => set('useCustom', next)} />}
        {!projected('text') && <ParamTextarea className={styles.fieldFull} label={t(anchor ? 'strategyParam.anchorText.label' : 'strategyParam.guideText.label')}
          hint={t(anchor ? 'strategyParam.anchorText.hint' : 'strategyParam.guideText.hint')} value={str('text')} onChange={(next) => set('text', next)} />}
        {anchor && !projected('buildPattern') && <ParamInput className={styles.fieldSpan6} label={t('strategyParam.buildPattern.label')} hint={t('strategyParam.buildPattern.hint')}
          value={str('buildPattern')} onChange={(next) => set('buildPattern', next)} />}
        {!projected('complexPattern') && <ParamInput className={styles.fieldSpan6} label={t('strategyParam.complexPattern.label')} hint={t('strategyParam.complexPattern.hint')}
          value={str('complexPattern')} onChange={(next) => set('complexPattern', next)} />}
        {anchor && !projected('firstTurnBuild') && <ParamTextarea className={styles.fieldFull} label={t('strategyParam.firstTurnBuild')} value={str('firstTurnBuild')} onChange={(next) => set('firstTurnBuild', next)} />}
        {anchor && !projected('firstTurnInspect') && <ParamTextarea className={styles.fieldFull} label={t('strategyParam.firstTurnInspect')} value={str('firstTurnInspect')} onChange={(next) => set('firstTurnInspect', next)} />}
        {!anchor && !projected('guideWeak') && <ParamTextarea className={styles.fieldFull} label={t('strategyParam.guideWeak')} value={str('guideWeak')} onChange={(next) => set('guideWeak', next)} />}
        {!projected(anchor ? 'firstTurnDeep' : 'guideDeep') && <ParamTextarea className={styles.fieldFull} label={t('strategyParam.deepGuide')}
          value={str(anchor ? 'firstTurnDeep' : 'guideDeep')} onChange={(next) => set(anchor ? 'firstTurnDeep' : 'guideDeep', next)} />}
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
        {layerFields}
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
    return (
      <>
        {layerFields}
        {/* 有层字段时不喊「无参数」：可编辑实例参数就在上面，提示只会与界面自相矛盾。 */}
        {layerFields === undefined && <p className={styles.configFieldHint}>{t('strategyParam.noParams')}</p>}
        {readOnlyNote !== undefined && <p className={styles.configFieldHint}>{t(readOnlyNote)}</p>}
      </>
    )
  }
  // 层字段之外仍有 params（未知键 / 旧数据）时继续走高级 JSON：新增分支既不吞未知
  // 资产，也不把已结构化的键重复渲染一遍；JSON 提交时把结构化值原样并回，避免丢字段。
  if (layerFields !== undefined) {
    return (
      <>
        {layerFields}
        {Object.keys(rest).length > 0 && (
          <JsonField t={t} label={t('field.json.advanced')} value={rest} fieldDrafts={props.fieldDrafts}
            draftKey={`${props.draftScope}:params`} onChange={(next) => { if (next !== undefined) onPatch({ ...covered, ...next }) }} />
        )}
      </>
    )
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
