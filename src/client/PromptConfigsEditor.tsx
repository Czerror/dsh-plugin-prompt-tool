import { useState, type ReactNode } from 'react'
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

/** /meta 未加载时的层兜底列表（与工作台 FALLBACK_LAYERS 同源语义）。 */
const FALLBACK_EDITOR_LAYERS = ['pre-step', 'system-section', 'runtime-context', 'agent-request', 'llm-stream', 'tool-pipeline']

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
  const [filterLayer, setFilterLayer] = useState<string>('')
  const templatePicker = useTemplatePicker(
    props.configs,
    (config) => props.onPatchConfigs([...props.configs, config]),
    props.onNotice,
  )
  const layers = props.meta.layers.length > 0 ? props.meta.layers : FALLBACK_EDITOR_LAYERS

  return (
    <section className={styles.page} aria-label="提示词配置">
      <label className={styles.listFilterRow}>
        <span className={styles.settingCopy}><small>按注入层级筛选</small></span>
        <select
          className={styles.configInput}
          value={filterLayer}
          aria-label="按注入层级筛选"
          onChange={(event) => setFilterLayer(event.target.value)}
        >
          <option value="">全部层级</option>
          {layers.map((layer) => (
            <option key={layer} value={layer}>{layer}</option>
          ))}
        </select>
      </label>
      <PromptConfigList
        meta={props.meta}
        configs={props.configs}
        savedConfigs={props.savedConfigs}
        layer={filterLayer.length > 0 ? filterLayer : undefined}
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
