import { useRef, useState, type FocusEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
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
  templateVariablesEnabled: boolean
  setTemplateVariablesEnabled: (value: boolean) => void
  saveTemplateVariables: () => Promise<void>
}

/** 预设级模板变量模块卡片（归类于配置列表下）：{{key}} 插值源，非 promptConfig——
 *  不进配置保存路径，保存走 /preset-variables 写 preset.yml 顶层 variables 段。
 *  可折叠（chevron）/ 可删除（清空全部变量，两段式确认）/ 可新建（VariablesEditor 添加变量）。 */
function TemplateVariablesModuleCard(props: {
  templateVariables: Record<string, string>
  setTemplateVariables: (value: Record<string, string>) => void
  templateVariablesEnabled: boolean
  setTemplateVariablesEnabled: (value: boolean) => void
  saveTemplateVariables: () => Promise<void>
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const cardRef = useRef<HTMLElement>(null)
  const count = Object.keys(props.templateVariables).length
  const enabled = props.templateVariablesEnabled
  const clearAll = (): void => {
    props.setTemplateVariables({})
    void props.saveTemplateVariables()
    setConfirmingDelete(false)
    setExpanded(false)
  }
  /** 失焦自动保存：焦点离开卡片容器（含收起/切换开关/点击删除）即持久化。 */
  const autoSaveOnBlur = (event: FocusEvent<HTMLElement>): void => {
    const next = event.relatedTarget
    if (next === null || !cardRef.current?.contains(next as Node)) {
      void props.saveTemplateVariables()
    }
  }
  return (
    <article ref={cardRef} className={styles.configCard} onBlur={autoSaveOnBlur}>
      <header className={styles.configHeader}>
        <button type="button" className={styles.configToggle} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          <span className={styles.configTitle}>
            <span className={styles.configName}>模板变量</span>
            <span className={styles.configMeta}>{`预设级 {{key}} 插值 · ${count} 个变量`}</span>
          </span>
          <IconChevronDownOutline14 className={clsx(styles.chevron, expanded && styles.chevronOpen)} />
        </button>
        <span className={styles.configHeaderActions}>
          <label className={styles.configEnable} title={enabled ? '点击停用模板变量插值' : '点击启用模板变量插值'}>
            <input
              type="checkbox"
              aria-label="启用模板变量插值"
              checked={enabled}
              onChange={(e) => {
                props.setTemplateVariablesEnabled(e.target.checked)
                void props.saveTemplateVariables()
              }}
            />
            <span className={styles.switch} aria-hidden="true"><i /></span>
          </label>
          <span className={styles.configActions}>
            {confirmingDelete ? (
              <>
                <button type="button" className={styles.pillButton} data-danger onClick={clearAll}>确认清空</button>
                <button type="button" className={styles.pillButton} data-variant="secondary" onClick={() => setConfirmingDelete(false)}>取消</button>
              </>
            ) : (
              <button type="button" className={styles.pillButton} data-danger onClick={() => setConfirmingDelete(true)}>删除</button>
            )}
          </span>
        </span>
      </header>
      {expanded && (
        <div className={styles.configForm}>
          {!enabled && <p className={styles.configFieldHint}>{'模板变量插值已停用：{{key}} 将不再被替换（预设级变量文件不生成）。'}</p>}
          <VariablesEditor value={props.templateVariables} onChange={(next) => props.setTemplateVariables(next ?? {})} />
        </div>
      )}
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
      <PromptConfigList
        meta={props.meta}
        configs={props.configs}
        savedConfigs={props.savedConfigs}
        extraActions={<button type="button" className={styles.primaryPill} onClick={templatePicker.openPicker}>新建</button>}
        beforeCards={
          <TemplateVariablesModuleCard
            templateVariables={props.templateVariables}
            setTemplateVariables={props.setTemplateVariables}
            templateVariablesEnabled={props.templateVariablesEnabled}
            setTemplateVariablesEnabled={props.setTemplateVariablesEnabled}
            saveTemplateVariables={props.saveTemplateVariables}
          />
        }
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
