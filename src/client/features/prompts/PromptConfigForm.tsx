import type { ReactNode } from 'react'
import clsx from 'clsx'
import { FormField } from '../../ui/FormField.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import type { EngineMeta, PromptConfigDraft } from '../../prompt-tool-types.ts'
import { OptionField, StrategyParamsFields, VariablesEditor } from './PromptConfigFields.tsx'
import { autoResizeTextarea } from './textarea-resize.ts'
import {
  AUDIENCE_LABELS,
  DEDUPE_LABELS,
  FILL_LABELS,
  IDENTITY_FIELD_LABELS,
  LAYER_LABELS,
  MERGE_MODE_LABELS,
  MODEL_SCOPE_LABELS,
  POSITION_LABELS,
  PROMOTION_LABELS,
  ROLE_LABELS,
  SLOT_KIND_LABELS,
  SOURCE_FORM_LABELS,
  SOURCE_FORMS,
  SOURCE_KIND_LABELS,
  SOURCE_KINDS,
  STRATEGY_LABELS,
  fieldPolicyFor,
} from './prompt-config-policy.ts'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './prompts.module.css'

const styles = { ...sharedCss, ...featureCss }
const inputClass = clsx(styles.configInput, styles.fieldControl)
/** identity 结构化编辑（替代 JSON）：field 下拉 + value 输入；value 留空 = 使用默认（等于配置 id）。 */
function IdentityFields(props: { identity: { field: string; value: string } | undefined; onPatch: (identity: { field: string; value: string } | undefined) => void }): ReactNode {
  const field = props.identity?.field ?? 'plugin'
  const value = props.identity?.value ?? ''
  return (
    <>
      <OptionField className={styles.fieldSpan3} label="幂等范围" hint="决定重复配置的识别范围"
        value={field} options={['plugin', 'kind']} fallback="plugin" labels={IDENTITY_FIELD_LABELS} onChange={(next) => props.onPatch({ field: next, value })} />
      <FormField className={styles.fieldSpan9} label="幂等值" hint="留空时使用配置标识" hintMode="tooltip">
        <input className={inputClass} value={value} spellCheck={false}
          onChange={(e) => props.onPatch(e.target.value.length > 0 ? { field, value: e.target.value } : undefined)} />
      </FormField>
    </>
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
  const advancedCount = [
    config.sourceKind,
    config.form !== undefined && config.form !== '' && config.form !== 'notice',
    config.summary,
    config.templateFile,
    config.identity !== undefined && (config.identity.field !== 'plugin' || config.identity.value.length > 0),
  ].filter(Boolean).length
  return (
    <div className={clsx(styles.configForm, styles.configFormLayout)}>
      <div className={styles.configSectionTitle}>基础信息</div>
      <div className={styles.configGrid}>
        <FormField className={styles.fieldSpan3} label="标识" hint="配置的唯一标识，不能为空" hintMode="tooltip">
          <input className={inputClass} value={config.id} spellCheck={false} onChange={(e) => onPatch({ id: e.target.value })} />
        </FormField>
        <FormField className={styles.fieldSpan3} label="名称" hint="模块列表中显示的名称" hintMode="tooltip">
          <input className={inputClass} value={config.name ?? ''} spellCheck={false} onChange={(e) => onPatch({ name: e.target.value })} />
        </FormField>
        <OptionField className={styles.fieldSpan3} label="注入层" hint="决定提示内容注入的位置" value={config.layer} options={meta.layers} fallback="pre-step" labels={LAYER_LABELS} onChange={(value) => onPatch({ layer: value })} />
        <OptionField className={styles.fieldSpan3} label="内容策略" hint="决定提示内容的生成方式" value={config.strategy} options={meta.strategies} fallback="static" labels={STRATEGY_LABELS} onChange={(value) => onPatch({ strategy: value })} />
      </div>

      <div className={styles.configSectionTitle}>注入规则</div>
      <div className={styles.configGrid}>
        <OptionField className={styles.fieldSpan3} label="配置类型" hint="顺序配置按顺序值排列；固定锚点优先" value={config.configKind} options={meta.slotKinds} fallback="ordered" labels={SLOT_KIND_LABELS} onChange={(value) => onPatch({ configKind: value })} />
        {policy.role && <OptionField className={styles.fieldSpan2} label="消息角色" hint="选择注入消息使用的角色" value={config.role} options={meta.roles} fallback="user" labels={ROLE_LABELS} onChange={(value) => onPatch({ role: value })} />}
        {policy.position && <OptionField className={styles.fieldSpan3} label="拼接位置" hint="决定内容在同层消息中的位置" value={config.position} options={meta.positions} fallback="after-user" labels={POSITION_LABELS} onChange={(value) => onPatch({ position: value })} />}
        {policy.merge && <OptionField className={styles.fieldSpan2} label="合并方式" hint="决定同位置内容是否合并发送" value={config.mergeMode} options={meta.mergeModes} fallback="separate" labels={MERGE_MODE_LABELS} onChange={(value) => onPatch({ mergeMode: value })} />}
        {policy.order && <FormField className={styles.fieldSpan2} label="顺序" hint="数值越小越靠前" hintMode="tooltip"><input className={inputClass} type="number" step={1} value={config.order ?? 0} onChange={(e) => onPatch({ order: Number(e.target.value) })} /></FormField>}
        <FormField className={styles.fieldSpan6} label="互斥组" hint="同组启用互斥后，只执行排序最前的启用配置" hintMode="tooltip"><input className={inputClass} value={config.group ?? ''} spellCheck={false} onChange={(e) => onPatch({ group: e.target.value })} /></FormField>
        <div className={clsx(styles.configToggleField, styles.fieldSpan2)}>
          <span className={styles.configFieldLabel}>互斥</span>
          <HintTooltip label="开启后，同一互斥组只执行排序最前的启用配置">
            <label className={styles.configEnable}>
            <input type="checkbox" aria-label="互斥" checked={config.exclusive === true} onChange={(e) => onPatch({ exclusive: e.target.checked })} />
            <span className={styles.switch} aria-hidden="true"><i /></span>
            </label>
          </HintTooltip>
        </div>
        {policy.dedupe && <OptionField className={styles.fieldSpan4} label="去重方式" hint="控制配置的重复执行范围" value={config.dedupe} options={meta.dedupes} fallback="none" labels={DEDUPE_LABELS} onChange={(value) => onPatch({ dedupe: value })} />}
      </div>

      {(policy.promotion || policy.audience || policy.modelScope) && (
        <>
          <div className={styles.configSectionTitle}>作用范围</div>
          <div className={styles.configGrid}>
            {policy.promotion && <OptionField className={styles.fieldSpan3} label="晋升范围" hint="决定配置是否要求会话晋升" value={config.promotion} options={meta.promotions} fallback="none" labels={PROMOTION_LABELS} onChange={(value) => onPatch({ promotion: value })} />}
            {policy.audience && <OptionField className={styles.fieldSpan6} label="消息受众" hint="缺省（通用）=主会话与子代理都注入" value={config.audience ?? undefined} options={['', ...meta.audienceModes]} fallback="" labels={AUDIENCE_LABELS} onChange={(value) => onPatch(value === '' ? { audience: null } : { audience: value })} />}
            {policy.modelScope && <OptionField className={styles.fieldSpan3} label="模型范围" hint="限制配置生效的模型类型" value={config.modelScope} options={meta.modelScopes} fallback="all" labels={MODEL_SCOPE_LABELS} onChange={(value) => onPatch({ modelScope: value })} />}
          </div>
        </>
      )}

      <div className={styles.configSectionTitle}>内容</div>
      <FormField label="注入内容" hint="留空时不注入；支持使用 {{key}} 引用模板变量" hintMode="tooltip">
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
      </FormField>
      <VariablesEditor value={config.variables} onChange={(value) => onPatch({ variables: value })} />

      <div className={styles.configSectionTitle}>策略参数</div>
      <div className={clsx(styles.configGrid, styles.strategyGrid)}>
        {placeholder && (
          <OptionField className={styles.fieldSpan3} label="填充来源" hint="选择动态内容的来源" value={config.fill} options={fillOptions} fallback="" labels={FILL_LABELS} onChange={(value) => onPatch({ fill: value || undefined })} />
        )}
        <StrategyParamsFields strategy={strategy} layer={config.layer} params={config.params} id={config.id} onPatch={(value) => onPatch({ params: value })} />
      </div>

      <details className={styles.configAdvanced} open={advancedCount > 0 || undefined}>
        <summary className={styles.configAdvancedSummary}>高级元数据{advancedCount > 0 ? ` · 已设置 ${advancedCount} 项` : ''}</summary>
        <div className={styles.configGrid}>
          <OptionField className={styles.fieldSpan3} label="来源类型" hint="设置注入消息的来源标记；默认使用配置标识" value={config.sourceKind} options={SOURCE_KINDS} fallback="" keepCurrent labels={SOURCE_KIND_LABELS} onChange={(value) => onPatch({ sourceKind: value || undefined })} />
          <OptionField className={styles.fieldSpan3} label="消息形式" hint="设置注入消息的呈现形式" value={config.form} options={SOURCE_FORMS} fallback="notice" keepCurrent labels={SOURCE_FORM_LABELS} onChange={(value) => onPatch({ form: value || undefined })} />
          <FormField className={styles.fieldSpan3} label="摘要" hint="注入消息的简短说明" hintMode="tooltip">
            <input className={inputClass} value={config.summary ?? ''} spellCheck={false} onChange={(e) => onPatch({ summary: e.target.value })} />
          </FormField>
          <FormField className={styles.fieldSpan3} label="模板文件" hint="从预设目录读取内容模板" hintMode="tooltip">
            <input className={inputClass} value={config.templateFile ?? ''} spellCheck={false} onChange={(e) => onPatch({ templateFile: e.target.value })} />
          </FormField>
          <IdentityFields identity={config.identity} onPatch={(value) => onPatch({ identity: value })} />
        </div>
      </details>
    </div>
  )
}
