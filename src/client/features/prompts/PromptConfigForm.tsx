import type { ReactNode } from 'react'
import clsx from 'clsx'
import { FormField } from '../../ui/FormField.tsx'
import type { EngineMeta, PromptConfigDraft } from '../../prompt-tool-types.ts'
import { OptionField, StrategyParamsFields, VariablesEditor } from './PromptConfigFields.tsx'
import { autoResizeTextarea } from './textarea-resize.ts'
import { AUDIENCE_LABELS, SOURCE_FORMS, SOURCE_KINDS, fieldPolicyFor } from './prompt-config-policy.ts'
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
      <OptionField className={styles.fieldSpan3} label="identity.field（幂等身份域）" hint="plugin = 按插件 id 幂等；kind = 按注入类型"
        value={field} options={['plugin', 'kind']} fallback="plugin" onChange={(next) => props.onPatch({ field: next, value })} />
      <FormField className={styles.fieldSpan9} label="identity.value（幂等身份值）" hint="留空 = 使用默认（等于配置 id）">
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
        <FormField className={styles.fieldSpan3} label="id（唯一，必填）">
          <input className={inputClass} value={config.id} spellCheck={false} onChange={(e) => onPatch({ id: e.target.value })} />
        </FormField>
        <FormField className={styles.fieldSpan3} label="name（显示名）">
          <input className={inputClass} value={config.name ?? ''} spellCheck={false} onChange={(e) => onPatch({ name: e.target.value })} />
        </FormField>
        <OptionField className={styles.fieldSpan3} label="layer" hint="切换后按新层能力矩阵显示字段" value={config.layer} options={meta.layers} fallback="pre-step" onChange={(value) => onPatch({ layer: value })} />
        <OptionField className={styles.fieldSpan3} label="strategy" hint="placeholder 需配合 fill" value={config.strategy} options={meta.strategies} fallback="static" onChange={(value) => onPatch({ strategy: value })} />
      </div>

      <div className={styles.configSectionTitle}>注入规则</div>
      <div className={styles.configGrid}>
        <OptionField className={styles.fieldSpan3} label="configKind" hint="ordered 按 order 升序；anchor 固定排最前" value={config.configKind} options={meta.slotKinds} fallback="ordered" onChange={(value) => onPatch({ configKind: value })} />
        {policy.role && <OptionField className={styles.fieldSpan2} label="role" hint="注入消息角色" value={config.role} options={meta.roles} fallback="user" onChange={(value) => onPatch({ role: value })} />}
        {policy.position && <OptionField className={styles.fieldSpan3} label="position" hint="同层拼接位置" value={config.position} options={meta.positions} fallback="after-user" onChange={(value) => onPatch({ position: value })} />}
        {policy.merge && <OptionField className={styles.fieldSpan2} label="mergeMode" hint="merged 会拼接为一条消息" value={config.mergeMode} options={meta.mergeModes} fallback="separate" onChange={(value) => onPatch({ mergeMode: value })} />}
        {policy.order && <FormField className={styles.fieldSpan2} label="order" hint="数值小者在前"><input className={inputClass} type="number" step={1} value={config.order ?? 0} onChange={(e) => onPatch({ order: Number(e.target.value) })} /></FormField>}
        <FormField className={styles.fieldSpan6} label="group" hint="同 group 且 exclusive=true 时只执行排序后的第一个 enabled 配置"><input className={inputClass} value={config.group ?? ''} spellCheck={false} onChange={(e) => onPatch({ group: e.target.value })} /></FormField>
        <label className={clsx(styles.configEnable, styles.configToggleField, styles.fieldSpan2)} title={config.exclusive === true ? '点击关闭互斥' : '点击开启互斥'}>
          <span className={styles.configFieldLabel}>exclusive</span>
          <input type="checkbox" aria-label="exclusive" checked={config.exclusive === true} onChange={(e) => onPatch({ exclusive: e.target.checked })} />
          <span className={styles.switch} aria-hidden="true"><i /></span>
        </label>
        {policy.dedupe && <OptionField className={styles.fieldSpan4} label="dedupe" hint="session=每会话一次；batch=当前批去重" value={config.dedupe} options={meta.dedupes} fallback="none" onChange={(value) => onPatch({ dedupe: value })} />}
      </div>

      {(policy.promotion || policy.audience || policy.modelScope) && (
        <>
          <div className={styles.configSectionTitle}>作用范围</div>
          <div className={styles.configGrid}>
            {policy.promotion && <OptionField className={styles.fieldSpan3} label="promotion" hint="none=不晋升；main=主会话；include-subagents=子代理跟随" value={config.promotion} options={meta.promotions} fallback="none" onChange={(value) => onPatch({ promotion: value })} />}
            {policy.audience && <OptionField className={styles.fieldSpan6} label="消息受众" hint="缺省（通用）=主会话与子代理都注入" value={config.audience ?? undefined} options={['', ...meta.audienceModes]} fallback="" labels={AUDIENCE_LABELS} onChange={(value) => onPatch(value === '' ? { audience: null } : { audience: value })} />}
            {policy.modelScope && <OptionField className={styles.fieldSpan3} label="modelScope" hint="all / pro / flash" value={config.modelScope} options={meta.modelScopes} fallback="all" onChange={(value) => onPatch({ modelScope: value })} />}
          </div>
        </>
      )}

      <div className={styles.configSectionTitle}>内容</div>
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

      <div className={styles.configSectionTitle}>策略参数</div>
      <div className={clsx(styles.configGrid, styles.strategyGrid)}>
        {placeholder && (
          <OptionField className={styles.fieldSpan3} label="fill（placeholder 专用）" hint="instruction-hint / env-facts / skill-catalog" value={config.fill} options={fillOptions} fallback="" onChange={(value) => onPatch({ fill: value || undefined })} />
        )}
        <StrategyParamsFields strategy={strategy} layer={config.layer} params={config.params} id={config.id} onPatch={(value) => onPatch({ params: value })} />
      </div>

      <details className={styles.configAdvanced} open={advancedCount > 0 || undefined}>
        <summary className={styles.configAdvancedSummary}>高级元数据{advancedCount > 0 ? ` · 已设置 ${advancedCount} 项` : ''}</summary>
        <div className={styles.configGrid}>
          <OptionField className={styles.fieldSpan3} label="sourceKind" hint="注入消息 source.kind；默认等于 id" value={config.sourceKind} options={SOURCE_KINDS} fallback="" keepCurrent onChange={(value) => onPatch({ sourceKind: value || undefined })} />
          <OptionField className={styles.fieldSpan3} label="form" hint="source.form；默认 notice" value={config.form} options={SOURCE_FORMS} fallback="notice" keepCurrent onChange={(value) => onPatch({ form: value || undefined })} />
          <FormField className={styles.fieldSpan3} label="summary">
            <input className={inputClass} value={config.summary ?? ''} spellCheck={false} onChange={(e) => onPatch({ summary: e.target.value })} />
          </FormField>
          <FormField className={styles.fieldSpan3} label="templateFile">
            <input className={inputClass} value={config.templateFile ?? ''} spellCheck={false} onChange={(e) => onPatch({ templateFile: e.target.value })} />
          </FormField>
          <IdentityFields identity={config.identity} onPatch={(value) => onPatch({ identity: value })} />
        </div>
      </details>
    </div>
  )
}
