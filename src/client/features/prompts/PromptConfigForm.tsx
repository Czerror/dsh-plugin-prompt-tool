import type { ReactNode } from 'react'
import clsx from 'clsx'
import { FormField } from '../../ui/FormField.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import type { PromptToolTranslate } from '../../locales.ts'
import type { EngineMeta, PromptConfigDraft } from '../../prompt-tool-types.ts'
import type { InstructionPolicyFileOverride } from '../../../shared/instructions.ts'
import { OptionField, StrategyParamsFields, VariablesEditor } from './PromptConfigFields.tsx'
import { autoResizeTextarea } from './textarea-resize.ts'
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
  fieldPolicyFor,
} from './prompt-config-policy.ts'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './prompts.module.css'

const styles = { ...sharedCss, ...featureCss }
const inputClass = clsx(styles.configInput, styles.fieldControl)
/** identity 结构化编辑（替代 JSON）：field 下拉 + value 输入；value 留空 = 使用默认（等于配置 id）。 */
function IdentityFields(props: { t: PromptToolTranslate; identity: { field: string; value: string } | undefined; onPatch: (identity: { field: string; value: string } | undefined) => void }): ReactNode {
  const t = props.t
  const field = props.identity?.field ?? 'plugin'
  const value = props.identity?.value ?? ''
  return (
    <>
      <OptionField t={t} className={styles.fieldSpan3} label={t('form.identity.scope.label')} hint={t('form.identity.scope.hint')}
        value={field} options={['plugin', 'kind']} fallback="plugin" labelKeys={IDENTITY_FIELD_LABEL_KEYS} onChange={(next) => props.onPatch({ field: next, value })} />
      <FormField className={styles.fieldSpan9} label={t('form.identity.value.label')} hint={t('form.identity.value.hint')} hintMode="tooltip">
        <input className={inputClass} value={value} spellCheck={false}
          onChange={(e) => props.onPatch(e.target.value.length > 0 ? { field, value: e.target.value } : undefined)} />
      </FormField>
    </>
  )
}

/** 单条提示词配置表单：按注入层级的能力矩阵过滤字段，只显示本层生效的参数。 */
export function PromptConfigForm(props: {
  t: PromptToolTranslate
  meta: EngineMeta
  config: PromptConfigDraft
  onPatch: (patch: Partial<PromptConfigDraft>) => void
  /** 指令文件卡：行为策略写独立策略存储（不写 preset.yml）。 */
  onPatchPolicy?: (patch: InstructionPolicyFileOverride) => void
}): ReactNode {
  const { t, meta, config, onPatch, onPatchPolicy } = props
  const policy = fieldPolicyFor(meta, config.layer)
  const strategy = config.strategy ?? 'static'
  const placeholder = strategy === 'placeholder' && policy.placeholder
  const fillOptions = ['', ...meta.fills]
  const advancedCount = [
    config.sourceKind,
    config.form !== undefined && config.form !== '' && config.form !== 'notice',
    config.summary,
    config.templateFile,
    config.identity !== undefined && (config.identity.field !== 'plugin' || config.identity.value.length > 0),
  ].filter(Boolean).length
  // 指令文件卡：正文对应磁盘上的原文件；读取失败或磁盘已变时不得继续编辑覆盖。
  const isInstructionFile = config.contentStatus !== undefined || config.origin?.kind === 'instruction-file'
  const filePath = typeof config.params?.displayPath === 'string' && config.params.displayPath.length > 0
    ? config.params.displayPath
    : typeof config.params?.file === 'string' ? config.params.file : ''
  const textReadOnly = isInstructionFile
    && ((config.contentStatus !== undefined && config.contentStatus !== 'ready') || config.contentConflict === true)
  // 指令文件卡：绑定（插入点/角色/表单/填充/去重）由文件来源固定，正文走显式保存；
  // 行为策略待独立策略存储接线后再放开，先不提供会静默丢弃的假控件。
  if (isInstructionFile) {
    return (
      <div className={clsx(styles.configForm, styles.configFormLayout)}>
        <div className={styles.configSectionTitle}>{t('form.section.content')}</div>
        <p className={styles.configFieldHint}>{t('form.text.fileTarget', { path: filePath })}</p>
        <p className={styles.configFieldHint}>{t('file.bindingLocked')}</p>
        {textReadOnly && <p className={styles.configFieldHint}>{t('form.text.fileReadOnly')}</p>}
        {config.contentOwnerConflict === true && <p className={styles.configFieldHint}>{t('file.ownerConflict')}</p>}
        <p className={styles.configFieldHint}>{t('file.policyNote')}</p>
        <FormField label={t('form.text.label')} hint={t('form.text.hint')} hintMode="tooltip">
          <textarea
            className={styles.configTextarea}
            aria-label={t('form.text.aria')}
            value={config.text ?? ''}
            spellCheck={false}
            readOnly={textReadOnly}
            onChange={(e) => {
              autoResizeTextarea(e)
              onPatch({ text: e.target.value })
            }}
          />
        </FormField>
        {/* 行为策略：独立存储，改动即按 revision 提交；绑定字段仍不可改。 */}
        <div className={styles.configSectionTitle}>{t('form.section.rules')}</div>
        <div className={clsx(styles.configGrid, styles.strategyGrid)}>
          <FormField className={styles.fieldSpan2} label={t('form.order.label')} hint={t('form.order.hint')} hintMode="tooltip">
            <input
              className={inputClass}
              type="number"
              min={0}
              step={1}
              defaultValue={config.order ?? 30}
              onBlur={(event) => {
                const next = Number(event.target.value)
                if (Number.isSafeInteger(next) && next >= 0) onPatchPolicy?.({ order: next })
              }}
            />
          </FormField>
          {policy.position && <OptionField t={t} className={styles.fieldSpan3} label={t('form.position.label')} hint={t('form.position.hint')} value={config.position} options={meta.positions} fallback="after-user" labelKeys={POSITION_LABEL_KEYS} onChange={(value) => onPatchPolicy?.({ position: value })} />}
          {policy.promotion && <OptionField t={t} className={styles.fieldSpan3} label={t('form.promotion.label')} hint={t('form.promotion.hint')} value={config.promotion} options={meta.promotions} fallback="none" labelKeys={PROMOTION_LABEL_KEYS} onChange={(value) => onPatchPolicy?.({ promotion: value })} />}
          {policy.audience && <OptionField t={t} className={styles.fieldSpan3} label={t('form.audience.label')} hint={t('form.audience.hint')} value={config.audience ?? undefined} options={['', ...meta.audienceModes]} fallback="" labelKeys={AUDIENCE_LABEL_KEYS} onChange={(value) => onPatchPolicy?.({ audience: value === '' ? null : value })} />}
          {policy.modelScope && <OptionField t={t} className={styles.fieldSpan3} label={t('form.modelScope.label')} hint={t('form.modelScope.hint')} value={config.modelScope} options={meta.modelScopes} fallback="all" labelKeys={MODEL_SCOPE_LABEL_KEYS} onChange={(value) => onPatchPolicy?.({ modelScope: value })} />}
        </div>
      </div>
    )
  }
  return (
    <div className={clsx(styles.configForm, styles.configFormLayout)}>
      <div className={styles.configSectionTitle}>{t('form.section.basic')}</div>
      <div className={styles.configGrid}>
        <FormField className={styles.fieldSpan3} label={t('form.id.label')} hint={t('form.id.hint')} hintMode="tooltip">
          <input className={inputClass} value={config.id} spellCheck={false} onChange={(e) => onPatch({ id: e.target.value })} />
        </FormField>
        <FormField className={styles.fieldSpan3} label={t('form.name.label')} hint={t('form.name.hint')} hintMode="tooltip">
          <input className={inputClass} value={config.name ?? ''} spellCheck={false} onChange={(e) => onPatch({ name: e.target.value })} />
        </FormField>
        <OptionField t={t} className={styles.fieldSpan3} label={t('form.layer.label')} hint={t('form.layer.hint')} value={config.layer} options={meta.layers} fallback="pre-step" labelKeys={LAYER_LABEL_KEYS} onChange={(value) => onPatch({ layer: value })} />
        <OptionField t={t} className={styles.fieldSpan3} label={t('form.strategy.label')} hint={t('form.strategy.hint')} value={config.strategy} options={meta.strategies} fallback="static" labelKeys={STRATEGY_LABEL_KEYS} onChange={(value) => onPatch({ strategy: value })} />
      </div>

      <div className={styles.configSectionTitle}>{t('form.section.rules')}</div>
      <div className={styles.configGrid}>
        <OptionField t={t} className={styles.fieldSpan3} label={t('form.kind.label')} hint={t('form.kind.hint')} value={config.configKind} options={meta.slotKinds} fallback="ordered" labelKeys={SLOT_KIND_LABEL_KEYS} onChange={(value) => onPatch({ configKind: value })} />
        {policy.role && <OptionField t={t} className={styles.fieldSpan2} label={t('form.role.label')} hint={t('form.role.hint')} value={config.role} options={meta.roles} fallback="user" labelKeys={ROLE_LABEL_KEYS} onChange={(value) => onPatch({ role: value })} />}
        {policy.position && <OptionField t={t} className={styles.fieldSpan3} label={t('form.position.label')} hint={t('form.position.hint')} value={config.position} options={meta.positions} fallback="after-user" labelKeys={POSITION_LABEL_KEYS} onChange={(value) => onPatch({ position: value })} />}
        {policy.merge && <OptionField t={t} className={styles.fieldSpan2} label={t('form.merge.label')} hint={t('form.merge.hint')} value={config.mergeMode} options={meta.mergeModes} fallback="separate" labelKeys={MERGE_MODE_LABEL_KEYS} onChange={(value) => onPatch({ mergeMode: value })} />}
        {policy.order && <FormField className={styles.fieldSpan2} label={t('form.order.label')} hint={t('form.order.hint')} hintMode="tooltip"><input className={inputClass} type="number" step={1} value={config.order ?? 0} onChange={(e) => onPatch({ order: Number(e.target.value) })} /></FormField>}
        <FormField className={styles.fieldSpan6} label={t('form.group.label')} hint={t('form.group.hint')} hintMode="tooltip"><input className={inputClass} value={config.group ?? ''} spellCheck={false} onChange={(e) => onPatch({ group: e.target.value })} /></FormField>
        <div className={clsx(styles.configToggleField, styles.fieldSpan2)}>
          <span className={styles.configFieldLabel}>{t('form.exclusive.label')}</span>
          <HintTooltip label={t('form.exclusive.hint')}>
            <label className={styles.configEnable}>
            <input type="checkbox" aria-label={t('form.exclusive.label')} checked={config.exclusive === true} onChange={(e) => onPatch({ exclusive: e.target.checked })} />
            <span className={styles.switch} aria-hidden="true"><i /></span>
            </label>
          </HintTooltip>
        </div>
        {policy.dedupe && <OptionField t={t} className={styles.fieldSpan4} label={t('form.dedupe.label')} hint={t('form.dedupe.hint')} value={config.dedupe} options={meta.dedupes} fallback="none" labelKeys={DEDUPE_LABEL_KEYS} onChange={(value) => onPatch({ dedupe: value })} />}
      </div>

      {(policy.promotion || policy.audience || policy.modelScope) && (
        <>
          <div className={styles.configSectionTitle}>{t('form.section.scope')}</div>
          <div className={styles.configGrid}>
            {policy.promotion && <OptionField t={t} className={styles.fieldSpan3} label={t('form.promotion.label')} hint={t('form.promotion.hint')} value={config.promotion} options={meta.promotions} fallback="none" labelKeys={PROMOTION_LABEL_KEYS} onChange={(value) => onPatch({ promotion: value })} />}
            {policy.audience && <OptionField t={t} className={styles.fieldSpan6} label={t('form.audience.label')} hint={t('form.audience.hint')} value={config.audience ?? undefined} options={['', ...meta.audienceModes]} fallback="" labelKeys={AUDIENCE_LABEL_KEYS} onChange={(value) => onPatch(value === '' ? { audience: null } : { audience: value })} />}
            {policy.modelScope && <OptionField t={t} className={styles.fieldSpan3} label={t('form.modelScope.label')} hint={t('form.modelScope.hint')} value={config.modelScope} options={meta.modelScopes} fallback="all" labelKeys={MODEL_SCOPE_LABEL_KEYS} onChange={(value) => onPatch({ modelScope: value })} />}
          </div>
        </>
      )}

      <div className={styles.configSectionTitle}>{t('form.section.content')}</div>
      <FormField label={t('form.text.label')} hint={t('form.text.hint')} hintMode="tooltip">
        <textarea
          className={styles.configTextarea}
          aria-label={t('form.text.aria')}
          value={[config.text ?? '', ...(config.texts ?? [])].filter((item) => item.length > 0).join('\n')}
          spellCheck={false}
          onChange={(e) => {
            autoResizeTextarea(e)
            const next = e.target.value
            // 内容资产（prompt-injector）走生成目录文件通道（text → params.text 由写盘端接管）；
            // 其余配置单段写 text（对齐官方 PromptSection.text 单字符串语义，texts 仅多段/旧数据兼容读取）。
            if (config.id === 'prompt-injector') {
              onPatch({ text: next, texts: [] })
            } else {
              onPatch({ text: next.trim().length > 0 ? next : undefined, texts: [] })
            }
          }}
        />
      </FormField>
      <VariablesEditor t={t} value={config.variables} onChange={(value) => onPatch({ variables: value })} />

      <div className={styles.configSectionTitle}>{t('form.section.strategy')}</div>
      <div className={clsx(styles.configGrid, styles.strategyGrid)}>
        {placeholder && (
          <OptionField t={t} className={styles.fieldSpan3} label={t('form.fill.label')} hint={t('form.fill.hint')} value={config.fill} options={fillOptions} fallback="" labelKeys={FILL_LABEL_KEYS} onChange={(value) => onPatch({ fill: value || undefined })} />
        )}
        <StrategyParamsFields t={t} strategy={strategy} layer={config.layer} params={config.params} id={config.id} onPatch={(value) => onPatch({ params: value })} />
      </div>

      <details className={styles.configAdvanced} open={advancedCount > 0 || undefined}>
        <summary className={styles.configAdvancedSummary}>{advancedCount > 0 ? t('form.advanced.setCount', { count: advancedCount }) : t('form.advanced.label')}</summary>
        <div className={styles.configGrid}>
          <OptionField t={t} className={styles.fieldSpan3} label={t('form.sourceKind.label')} hint={t('form.sourceKind.hint')} value={config.sourceKind} options={SOURCE_KINDS} fallback="" keepCurrent labelKeys={SOURCE_KIND_LABEL_KEYS} onChange={(value) => onPatch({ sourceKind: value || undefined })} />
          <OptionField t={t} className={styles.fieldSpan3} label={t('form.form.label')} hint={t('form.form.hint')} value={config.form} options={SOURCE_FORMS} fallback="notice" keepCurrent labelKeys={SOURCE_FORM_LABEL_KEYS} onChange={(value) => onPatch({ form: value || undefined })} />
          <FormField className={styles.fieldSpan3} label={t('form.summary.label')} hint={t('form.summary.hint')} hintMode="tooltip">
            <input className={inputClass} value={config.summary ?? ''} spellCheck={false} onChange={(e) => onPatch({ summary: e.target.value })} />
          </FormField>
          <FormField className={styles.fieldSpan3} label={t('form.templateFile.label')} hint={t('form.templateFile.hint')} hintMode="tooltip">
            <input className={inputClass} value={config.templateFile ?? ''} spellCheck={false} onChange={(e) => onPatch({ templateFile: e.target.value })} />
          </FormField>
          <IdentityFields t={t} identity={config.identity} onPatch={(value) => onPatch({ identity: value })} />
        </div>
      </details>
    </div>
  )
}
