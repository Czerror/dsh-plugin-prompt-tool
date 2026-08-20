import type { ReactNode } from 'react'
import { PromptConfigList } from './PromptConfigList.tsx'
import { TemplatePicker } from './TemplatePicker.tsx'
import { useTemplatePicker } from './useTemplatePicker.ts'
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
}

/** 提示词配置编辑器：六层配置列表 + 模板插入 + 保存前权威校验（目录路径设置在「预设和配置」页）。 */
export function PromptConfigsEditor(props: PromptConfigsEditorProps): ReactNode {
  const templatePicker = useTemplatePicker(
    props.configs,
    (config) => props.onPatchConfigs([...props.configs, config]),
    props.onNotice,
  )

  return (
    <section className={styles.page} aria-label="提示词配置">
      <div className={styles.sectionHeading}>
        <div><h2>提示词配置</h2>
        <p>统一管理六个注入层级的提示词配置：内容、层级与位置全部自定义。保存前自动做引擎权威校验；同名 id 后写入者覆盖，新 id 追加。</p>
        </div>
      </div>

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

      <p className={styles.settingsNote}>提示词配置写入 <code>settings.promptConfigs</code>；目录合并优先级：默认四条 &lt; promptConfigsDir（预设和配置页设置）&lt; settings.promptConfigs。</p>
    </section>
  )
}
