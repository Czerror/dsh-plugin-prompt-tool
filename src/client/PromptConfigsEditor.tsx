import { type ReactNode } from 'react'
import { PromptConfigList } from './PromptConfigList.tsx'
import { TemplatePicker } from './TemplatePicker.tsx'
import { useTemplatePicker } from './useTemplatePicker.ts'
import { VariablesEditor } from './PromptConfigCard.tsx'
import styles from './PromptUi.module.css'

import type { EngineMeta, PromptConfigDraft } from './prompt-tool-types.ts'

export type { PromptConfigDraft, LayerFieldPolicy } from './prompt-tool-types.ts'
export type { ValidationErrorEntry } from './prompt-tool-types.ts'
export { Field, JsonField, PromptConfigCard, PromptConfigForm, SOURCE_FORMS, SOURCE_KINDS, fieldPolicyFor } from './PromptConfigCard.tsx'
export type { PromptConfigCardActions } from './PromptConfigCard.tsx'
export type { PromptConfigTemplateEntry } from './prompt-tool-types.ts'

export interface PromptConfigsEditorProps {
  meta: EngineMeta
  configs: PromptConfigDraft[]
  savedConfigs: PromptConfigDraft[]
  onPatchConfigs: (configs: PromptConfigDraft[]) => void
  onSaveConfigs: (configs: PromptConfigDraft[]) => void
  onNotice: (kind: 'ok' | 'error', message: string) => void
  /** 预设级模板变量（preset.yml 顶层 variables 段；编辑入口与模块列表统一）。 */
  templateVariables: Record<string, string>
  setTemplateVariables: (value: Record<string, string>) => void
  saveTemplateVariables: () => Promise<void>
}

/** 预设级模板变量模块卡片：{{key}} 插值源（非 promptConfig——不进配置列表保存路径，
 *  保存走 /preset-variables 写 preset.yml 顶层 variables 段）。 */
function TemplateVariablesModuleCard(props: {
  templateVariables: Record<string, string>
  setTemplateVariables: (value: Record<string, string>) => void
  saveTemplateVariables: () => Promise<void>
}): ReactNode {
  const count = Object.keys(props.templateVariables).length
  return (
    <article className={styles.configCard}>
      <header className={styles.configHeader}>
        <span className={styles.configTitle}>
          <span className={styles.configName}>模板变量</span>
          <span className={styles.configMeta}>{`预设级 {{key}} 插值 · ${count} 个变量`}</span>
        </span>
      </header>
      <div className={styles.configForm}>
        <VariablesEditor value={props.templateVariables} onChange={(next) => props.setTemplateVariables(next ?? {})} />
        <span>
          <button type="button" className={styles.pillButton} onClick={() => void props.saveTemplateVariables()}>保存模板变量</button>
        </span>
      </div>
    </article>
  )
}

/** 提示词配置编辑器：配置列表（层级/策略过滤已并入列表）+ 模板插入 + 保存前权威校验。 */
export function PromptConfigsEditor(props: PromptConfigsEditorProps): ReactNode {
  const templatePicker = useTemplatePicker(
    props.configs,
    (config) => props.onPatchConfigs([...props.configs, config]),
    props.onNotice,
  )
  return (
    <section className={styles.page} aria-label="提示词配置">
      <TemplateVariablesModuleCard
        templateVariables={props.templateVariables}
        setTemplateVariables={props.setTemplateVariables}
        saveTemplateVariables={props.saveTemplateVariables}
      />
      <PromptConfigList
        meta={props.meta}
        configs={props.configs}
        savedConfigs={props.savedConfigs}
        extraActions={<button type="button" className={styles.primaryPill} onClick={templatePicker.openPicker}>新建</button>}
        onPatchConfigs={props.onPatchConfigs}
        onSaveConfigs={props.onSaveConfigs}
        onNotice={props.onNotice}
      />

      {templatePicker.open && (
        <TemplatePicker templates={templatePicker.templates} onPick={templatePicker.pickTemplate} onClose={templatePicker.closePicker} />
      )}

      <p className={styles.settingsNote}>提示词配置写入 <code>settings.promptConfigs</code>；外部提示词配置可经「预设配置 → 导入预设」引入。</p>
    </section>
  )
}
