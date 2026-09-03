import type { ReactNode } from 'react'
import { FormField } from '../../ui/FormField.tsx'
import type { EngineMeta, PromptConfigDraft } from '../../prompt-tool-types.ts'
import { OptionField, StrategyParamsFields, VariablesEditor } from './PromptConfigFields.tsx'
import { autoResizeTextarea } from './textarea-resize.ts'
import { AUDIENCE_LABELS, SOURCE_FORMS, SOURCE_KINDS, fieldPolicyFor } from './prompt-config-policy.ts'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './prompts.module.css'

const styles = { ...sharedCss, ...featureCss }
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
