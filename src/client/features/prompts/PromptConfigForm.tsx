import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FieldDraft } from '../../data/workspace-drafts.ts'
import { FormField } from '../../ui/FormField.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import type { PromptToolTranslate } from '../../locales.ts'
import type { EngineMeta, PromptConfigDraft } from '../../prompt-tool-types.ts'
import type { InstructionPolicyFileOverride } from '../../../shared/instructions.ts'
import { MatchFields, NumberField, OptionField, StrategyParamsFields, VariablesEditor } from './PromptConfigFields.tsx'
import { autoResizeTextarea } from './textarea-resize.ts'
import { instructionFileIdOf } from '../../data/prompt-config-content.ts'
import {
  AUDIENCE_LABEL_KEYS,
  DEDUPE_LABEL_KEYS,
  FILL_LABEL_KEYS,
  IDENTITY_FIELD_LABEL_KEYS,
  LAYER_LABEL_KEYS,
  MERGE_MODE_LABEL_KEYS,
  MODEL_SCOPE_LABEL_KEYS,
  POSITION_LABEL_KEYS,
  PROMOTION_LABEL_KEYS,
  ROLE_LABEL_KEYS,
  SLOT_KIND_LABEL_KEYS,
  SOURCE_FORM_LABEL_KEYS,
  SOURCE_FORMS,
  SOURCE_KIND_LABEL_KEYS,
  SOURCE_KINDS,
  STRATEGY_LABEL_KEYS,
  SUBJECT_LABEL_KEYS,
  clearedConditionPatch,
  fieldPolicyFor,
  translateLabel,
} from './prompt-config-policy.ts'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './prompts.module.css'

const styles = { ...sharedCss, ...featureCss }
const inputClass = clsx(styles.configInput, styles.fieldControl)
/** identity 结构化编辑（替代 JSON）：field 下拉 + value 输入；value 留空 = 使用默认（等于配置 id）。 */
function IdentityFields(props: { t: PromptToolTranslate; identity: { field: string; value: string } | undefined; disabled?: boolean; onPatch: (identity: { field: string; value: string } | undefined) => void }): ReactNode {
  const t = props.t
  const field = props.identity?.field ?? 'plugin'
  const value = props.identity?.value ?? ''
  return (
    <>
      <OptionField t={t} className={styles.fieldSpan3} label={t('form.identity.scope.label')} hint={t('form.identity.scope.hint')}
        value={field} options={['plugin', 'kind']} fallback="plugin" labelKeys={IDENTITY_FIELD_LABEL_KEYS} disabled={props.disabled} onChange={(next) => props.onPatch({ field: next, value })} />
      <FormField className={styles.fieldSpan9} label={t('form.identity.value.label')} hint={t('form.identity.value.hint')} hintMode="tooltip">
        <input className={inputClass} value={value} spellCheck={false} readOnly={props.disabled}
          onChange={(e) => props.onPatch(e.target.value.length > 0 ? { field, value: e.target.value } : undefined)} />
      </FormField>
    </>
  )
}

/** 单条提示词配置表单：按注入层级的能力矩阵过滤字段，只显示本层生效的参数。
 *  指令文件卡（AGENTS.md / CLAUDE.md）复用同一套分区与字段：来源固定的绑定项置灰只读，
 *  名称与顺序、位置、晋升、受众、模型范围写独立指令策略，正文写文件草稿。 */
export function PromptConfigForm(props: {
  t: PromptToolTranslate
  meta: EngineMeta
  config: PromptConfigDraft
  disabled?: boolean
  fieldDrafts?: Map<string, FieldDraft>
  draftScope?: string
  onPatch: (patch: Partial<PromptConfigDraft>) => void
  /** 指令文件卡：行为策略写独立策略存储（不写 preset.yml）。 */
  onPatchPolicy?: (patch: InstructionPolicyFileOverride) => void
}): ReactNode {
  const { t, meta, config, onPatch: patchConfig, onPatchPolicy } = props
  // 指令文件卡：正文对应磁盘上的原文件；读取失败或磁盘已变时不得继续编辑覆盖。
  // 与写盘路径共用同一身份判定：origin 或 sourceKind+params.fileId 都算指令文件卡。
  const isInstructionFile = config.contentStatus !== undefined || instructionFileIdOf(config) !== undefined
  const locked = isInstructionFile
  const disabled = props.disabled === true
  const filePath = typeof config.params?.displayPath === 'string' && config.params.displayPath.length > 0
    ? config.params.displayPath
    : typeof config.params?.file === 'string' ? config.params.file : ''
  const textReadOnly = isInstructionFile
    && ((config.contentStatus !== undefined && config.contentStatus !== 'ready') || config.contentConflict === true)
  const instructionHint = config.strategy === 'instruction-hint'
  /** 普通卡写 preset 卡字段；指令文件卡的绑定由文件来源固定，只有策略字段落到独立策略。 */
  const onPatch = (patch: Partial<PromptConfigDraft>): void => {
    if (disabled) return
    if (!locked) {
      patchConfig(instructionHint ? { strategy: 'placeholder', fill: 'instruction-hint', ...patch } : patch)
      return
    }
    if (typeof patch.text === 'string') {
      patchConfig({ text: patch.text })
      return
    }
    const next: InstructionPolicyFileOverride = {}
    if (typeof patch.name === 'string') next.name = patch.name
    if (typeof patch.order === 'number' && Number.isSafeInteger(patch.order) && patch.order >= 0) next.order = patch.order
    if (typeof patch.position === 'string') next.position = patch.position
    if (typeof patch.promotion === 'string') next.promotion = patch.promotion
    if (patch.audience !== undefined) next.audience = patch.audience
    if (typeof patch.modelScope === 'string') next.modelScope = patch.modelScope
    if (Object.keys(next).length > 0) onPatchPolicy?.(next)
  }
  const policy = fieldPolicyFor(meta, config.layer)
  // 条件判定（subject / match）只在引擎字段矩阵允许的层可编辑；指令文件卡的绑定不可改，
  // 且独立指令策略不承载这两项，故整块隐藏，避免做出被 onPatch 静默丢弃的假入口。
  const conditional = !locked && (policy.subject || policy.match)
  const defaultSubject = meta.layerDefaultSubjects?.[config.layer ?? 'pre-step']
  const layerDetail = meta.layerLabels[config.layer ?? '']?.detail
  // 可发出角色（引擎 EMITTABLE_ROLES）之外的值是旧输入：可加载、可保存，但运行时降级，
  // 表单必须说明这一点，而不是把非法角色继续摆成可选新值。
  const roleDowngraded = meta.roles.length > 0
    && typeof config.role === 'string' && config.role.length > 0 && !meta.roles.includes(config.role)
  const strategy = instructionHint ? 'placeholder' : config.strategy ?? 'static'
  const placeholder = strategy === 'placeholder' && policy.placeholder
  const fillOptions = ['', ...meta.fills]
  const advancedCount = [
    config.sourceKind,
    config.form !== undefined && config.form !== '' && config.form !== 'notice',
    config.summary,
    config.templateFile,
    config.identity !== undefined && (config.identity.field !== 'plugin' || config.identity.value.length > 0),
  ].filter(Boolean).length
  const [advancedOpen, setAdvancedOpen] = useState(advancedCount > 0)
  return (
    <div className={clsx(styles.configForm, styles.configFormLayout)}>
      <div className={styles.configSectionTitle}>{t('form.section.basic')}</div>
      <div className={styles.configGrid}>
        <FormField className={styles.fieldSpan3} label={t('form.id.label')} hint={t('form.id.hint')} hintMode="tooltip">
          <input className={inputClass} value={config.id} spellCheck={false} readOnly={locked || disabled} onChange={(e) => onPatch({ id: e.target.value })} />
        </FormField>
        <FormField className={styles.fieldSpan3} label={t('form.name.label')} hint={t('form.name.hint')} hintMode="tooltip">
          <input className={inputClass} value={config.name ?? ''} spellCheck={false} readOnly={disabled} onChange={(e) => onPatch({ name: e.target.value })} />
        </FormField>
        <OptionField t={t} className={styles.fieldSpan3} label={t('form.layer.label')} hint={t('form.layer.hint')} value={config.layer} options={meta.layers} fallback="pre-step" labelKeys={LAYER_LABEL_KEYS} disabled={locked || disabled} onChange={(value) => onPatch({ layer: value, ...clearedConditionPatch(meta, value) })} />
        <OptionField t={t} className={styles.fieldSpan3} label={t('form.strategy.label')} hint={t('form.strategy.hint')} value={strategy} options={meta.strategies.filter((value) => value !== 'instruction-hint')} fallback="static" labelKeys={STRATEGY_LABEL_KEYS} disabled={locked || disabled} onChange={(value) => onPatch({ strategy: value, fill: value === 'placeholder' ? (config.fill ?? (instructionHint ? 'instruction-hint' : 'env-facts')) : undefined })} />
      </div>
      {/* 层说明由引擎 LAYER_LABELS 下发（新增层无需在客户端重抄一遍语义）。 */}
      {layerDetail !== undefined && <p className={styles.configFieldHint}>{layerDetail}</p>}
      {locked && (
        <>
          <p className={styles.configFieldHint}>{t('form.text.fileTarget', { path: filePath })}</p>
          <p className={styles.configFieldHint}>{t('file.bindingLocked')}</p>
          <p className={styles.configFieldHint}>{t('file.policyNote')}</p>
        </>
      )}

      <div className={styles.configSectionTitle}>{t('form.section.rules')}</div>
      <div className={styles.configGrid}>
        <OptionField t={t} className={styles.fieldSpan3} label={t('form.kind.label')} hint={t('form.kind.hint')} value={config.configKind} options={meta.slotKinds} fallback="ordered" labelKeys={SLOT_KIND_LABEL_KEYS} disabled={locked || disabled} onChange={(value) => onPatch({ configKind: value })} />
        {policy.role && <OptionField t={t} className={styles.fieldSpan2} label={t('form.role.label')} hint={t('form.role.hint')} value={config.role} options={meta.roles} fallback="user" labelKeys={ROLE_LABEL_KEYS} disabled={locked || disabled} onChange={(value) => onPatch({ role: value })} />}
        {policy.role && roleDowngraded && <p className={clsx(styles.configFieldHint, styles.fieldSpan9)}>{t('form.role.downgraded')}</p>}
        {policy.position && <OptionField t={t} className={styles.fieldSpan3} label={t('form.position.label')} hint={t('form.position.hint')} value={config.position} options={meta.positions} fallback="after-user" labelKeys={POSITION_LABEL_KEYS} disabled={disabled} onChange={(value) => onPatch({ position: value })} />}
        {policy.merge && <OptionField t={t} className={styles.fieldSpan2} label={t('form.merge.label')} hint={t('form.merge.hint')} value={config.mergeMode} options={meta.mergeModes} fallback="separate" labelKeys={MERGE_MODE_LABEL_KEYS} disabled={locked || disabled} onChange={(value) => onPatch({ mergeMode: value })} />}
        {policy.order && <NumberField t={t} className={styles.fieldSpan2} label={t('form.order.label')} hint={t('form.order.hint')}
          value={config.order} fallback={locked ? 30 : 0} integer min={locked ? 0 : undefined} disabled={disabled}
          fieldDrafts={props.fieldDrafts} draftKey={`${props.draftScope}:order`} onChange={(value) => { if (typeof value === 'number') onPatch({ order: value }) }} />}
        <FormField className={styles.fieldSpan6} label={t('form.group.label')} hint={t('form.group.hint')} hintMode="tooltip"><input className={inputClass} value={config.group ?? ''} spellCheck={false} readOnly={locked || disabled} onChange={(e) => onPatch({ group: e.target.value })} /></FormField>
        <div className={clsx(styles.configToggleField, styles.fieldSpan2)}>
          <span className={styles.configFieldLabel}>{t('form.exclusive.label')}</span>
          <HintTooltip label={t('form.exclusive.hint')}>
            <span className={styles.configEnable}><Switch label={t('form.exclusive.label')} checked={config.exclusive === true} disabled={locked || disabled} onChange={(next) => onPatch({ exclusive: next })} /></span>
          </HintTooltip>
        </div>
        {policy.dedupe && <OptionField t={t} className={styles.fieldSpan4} label={t('form.dedupe.label')} hint={t('form.dedupe.hint')} value={config.dedupe} options={meta.dedupes} fallback="none" labelKeys={DEDUPE_LABEL_KEYS} disabled={locked || disabled} onChange={(value) => onPatch({ dedupe: value })} />}
        {conditional && (
          <>
            <p className={clsx(styles.configFieldLabel, styles.fieldFull)}>{t('form.match.group')}</p>
            <OptionField t={t} className={styles.fieldSpan3} label={t('form.subject.label')} hint={t('form.subject.hint')}
              value={config.subject} options={['', ...(meta.subjects ?? [])]} fallback="" labelKeys={SUBJECT_LABEL_KEYS} disabled={disabled}
              onChange={(value) => onPatch({ subject: value === '' ? undefined : value })} />
            {config.subject === undefined && defaultSubject !== undefined && (
              <p className={clsx(styles.configFieldHint, styles.fieldSpan9)}>{t('form.subject.defaultHint', { value: translateLabel(t, SUBJECT_LABEL_KEYS, defaultSubject) })}</p>
            )}
            <MatchFields t={t} value={config.match} disabled={disabled} onChange={(value) => onPatch({ match: value })} />
          </>
        )}
      </div>

      {(policy.promotion || policy.audience || policy.modelScope) && (
        <>
          <div className={styles.configSectionTitle}>{t('form.section.scope')}</div>
          <div className={styles.configGrid}>
            {policy.promotion && <OptionField t={t} className={styles.fieldSpan3} label={t('form.promotion.label')} hint={t('form.promotion.hint')} value={config.promotion} options={meta.promotions} fallback="none" labelKeys={PROMOTION_LABEL_KEYS} disabled={disabled} onChange={(value) => onPatch({ promotion: value })} />}
            {policy.audience && <OptionField t={t} className={styles.fieldSpan6} label={t('form.audience.label')} hint={t('form.audience.hint')} value={config.audience ?? undefined} options={['', ...meta.audienceModes]} fallback="" labelKeys={AUDIENCE_LABEL_KEYS} disabled={disabled} onChange={(value) => onPatch(value === '' ? { audience: null } : { audience: value })} />}
            {policy.modelScope && <OptionField t={t} className={styles.fieldSpan3} label={t('form.modelScope.label')} hint={t('form.modelScope.hint')} value={config.modelScope} options={meta.modelScopes} fallback="all" labelKeys={MODEL_SCOPE_LABEL_KEYS} disabled={disabled} onChange={(value) => onPatch({ modelScope: value })} />}
          </div>
        </>
      )}

      <div className={styles.configSectionTitle}>{t('form.section.content')}</div>
      {locked && textReadOnly && <p className={styles.configFieldHint}>{t('form.text.fileReadOnly')}</p>}
      <FormField label={t('form.text.label')} hint={t('form.text.hint')} hintMode="tooltip">
        <textarea
          className={styles.configTextarea}
          aria-label={t('form.text.aria')}
          value={[config.text ?? '', ...(config.texts ?? [])].filter((item) => item.length > 0).join('\n')}
          spellCheck={false}
          readOnly={disabled || (locked && textReadOnly)}
          onChange={(e) => {
            autoResizeTextarea(e)
            const next = e.target.value
            // 内容资产（prompt-injector）走生成目录文件通道（text → params.text 由写盘端接管）；
            // 指令文件卡：正文始终按字符串写草稿（允许清空），焦点离开卡片时自动写回原文件。
            // 其余配置单段写 text（对齐官方 PromptSection.text 单字符串语义，texts 仅多段/旧数据兼容读取）。
            if (locked || config.id === 'prompt-injector') {
              onPatch({ text: next, texts: [] })
            } else {
              onPatch({ text: next.trim().length > 0 ? next : undefined, texts: [] })
            }
          }}
        />
      </FormField>
      {!locked && <VariablesEditor t={t} value={config.variables} disabled={disabled} onChange={(value) => onPatch({ variables: value })} />}

      <div className={styles.configSectionTitle}>{t('form.section.strategy')}</div>
      <fieldset disabled={disabled} className={clsx(styles.configGrid, styles.strategyGrid, styles.configFieldset)}>
        {placeholder && (
          <OptionField t={t} className={styles.fieldSpan3} label={t('form.fill.label')} hint={t('form.fill.hint')} value={config.fill ?? (instructionHint ? 'instruction-hint' : undefined)} options={fillOptions} fallback="" labelKeys={FILL_LABEL_KEYS} disabled={locked || disabled} onChange={(value) => onPatch({ fill: value || undefined })} />
        )}
        {!locked && <StrategyParamsFields t={t} strategy={strategy} layer={config.layer} params={config.params} id={config.id} enabled={config.enabled} modelScope={config.modelScope} fieldDrafts={props.fieldDrafts} draftScope={props.draftScope} onPatch={(value) => onPatch({ params: value })} />}
      </fieldset>

      <details className={styles.configAdvanced} open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
        <summary className={styles.configAdvancedSummary}>{advancedCount > 0 ? t('form.advanced.setCount', { count: advancedCount }) : t('form.advanced.label')}</summary>
        <div className={styles.configGrid}>
          <OptionField t={t} className={styles.fieldSpan3} label={t('form.sourceKind.label')} hint={t('form.sourceKind.hint')} value={config.sourceKind} options={SOURCE_KINDS} fallback="" keepCurrent labelKeys={SOURCE_KIND_LABEL_KEYS} disabled={locked || disabled} onChange={(value) => onPatch({ sourceKind: value || undefined })} />
          <OptionField t={t} className={styles.fieldSpan3} label={t('form.form.label')} hint={t('form.form.hint')} value={config.form} options={SOURCE_FORMS} fallback="notice" keepCurrent labelKeys={SOURCE_FORM_LABEL_KEYS} disabled={locked || disabled} onChange={(value) => onPatch({ form: value || undefined })} />
          {!locked && (
            <>
              <FormField className={styles.fieldSpan3} label={t('form.summary.label')} hint={t('form.summary.hint')} hintMode="tooltip">
                <input className={inputClass} value={config.summary ?? ''} spellCheck={false} readOnly={disabled} onChange={(e) => onPatch({ summary: e.target.value })} />
              </FormField>
              <FormField className={styles.fieldSpan3} label={t('form.templateFile.label')} hint={t('form.templateFile.hint')} hintMode="tooltip">
                <input className={inputClass} value={config.templateFile ?? ''} spellCheck={false} readOnly={disabled} onChange={(e) => onPatch({ templateFile: e.target.value })} />
              </FormField>
              <IdentityFields t={t} identity={config.identity} disabled={disabled} onPatch={(value) => onPatch({ identity: value })} />
            </>
          )}
        </div>
      </details>
    </div>
  )
}
