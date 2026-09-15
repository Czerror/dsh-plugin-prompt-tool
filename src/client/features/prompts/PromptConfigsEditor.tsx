import { useRef, useState, type FocusEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PromptToolTranslate } from '../../locales.ts'
import { PromptConfigList } from './PromptConfigList.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { VariablesEditor } from './PromptConfigFields.tsx'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './prompts.module.css'

const styles = { ...sharedCss, ...featureCss }

import type { EngineMeta, PromptConfigDraft } from '../../prompt-tool-types.ts'
import type { InstructionPolicyFileOverride, InstructionPolicySnapshot } from '../../../shared/instructions.ts'

export type { PromptConfigDraft, LayerFieldPolicy } from '../../prompt-tool-types.ts'
export type { ValidationErrorEntry } from '../../prompt-tool-types.ts'
export { JsonField } from './PromptConfigFields.tsx'
export { PromptConfigCard } from './PromptConfigCard.tsx'
export { PromptConfigForm } from './PromptConfigForm.tsx'
export { SOURCE_FORMS, SOURCE_KINDS, fieldPolicyFor } from './prompt-config-policy.ts'

export type { PromptConfigTemplateEntry } from '../../prompt-tool-types.ts'

export interface PromptConfigsEditorProps {
  t: PromptToolTranslate
  meta: EngineMeta
  configs: PromptConfigDraft[]
  onPatchConfigs: (configs: PromptConfigDraft[]) => void
  onSaveConfigs: (configs: PromptConfigDraft[]) => Promise<boolean>
  instructionPolicy?: InstructionPolicySnapshot
  onToggleInstructionSource?: (enabled: boolean) => Promise<boolean>
  /** 指令文件卡：显式写盘 / 重新读取（不经预设保存路径）。 */
  onSaveInstructionFile?: (fileId: string) => void
  onReloadInstructionFile?: (fileId: string) => void
  /** 指令文件卡的行为策略改动（独立策略存储）。 */
  onPatchInstructionPolicy?: (fileId: string, override: InstructionPolicyFileOverride) => void
  onNotice: (kind: 'ok' | 'error', message: string) => void
  /** 预设级模板变量（preset.yml 顶层 variables 段；编辑入口与模块列表统一）。 */
  templateVariables: Record<string, string>
  setTemplateVariables: (value: Record<string, string>) => void
  templateVariablesEnabled: boolean
  setTemplateVariablesEnabled: (value: boolean) => void
  /** 保存模板变量；开关变更时把新值一并传入，避免读到上一帧 enabled。 */
  saveTemplateVariables: (next?: Record<string, string>, enabled?: boolean) => Promise<void>
  viewFilter: string
  onViewFilterChange: (value: string) => void
  createdConfigId?: string
  /** 模板变量卡片展开态由页面持有：合并创建菜单的「添加模板变量」需要展开它。 */
  variablesExpanded: boolean
  onVariablesExpandedChange: (value: boolean) => void
  /** 公共配置：模型、模板变量以外的预设级默认值等，不属于任何插入点。 */
  commonCards?: ReactNode
  /** 模块列表置顶卡片：脱离「公共配置」分组的单例配置（人设），不参与层过滤。 */
  beforeCards?: ReactNode
  /** 模块卡（引擎能力、自定义工具）：视觉上排在层级配置卡之前。 */
  moduleCards?: ReactNode
  /** 模块列表工具栏中的合并创建菜单。 */
  toolbarActions?: ReactNode
}

/** 预设级模板变量模块卡片（归类于配置列表下）：{{key}} 插值源，非 promptConfig——
 *  不进配置保存路径，保存走 /preset-variables 写 preset.yml 顶层 variables 段。
 *  可折叠（chevron）/ 可删除（清空全部变量，两段式确认）/ 可新建（VariablesEditor 添加变量）。 */
function TemplateVariablesModuleCard(props: {
  t: PromptToolTranslate
  templateVariables: Record<string, string>
  setTemplateVariables: (value: Record<string, string>) => void
  templateVariablesEnabled: boolean
  setTemplateVariablesEnabled: (value: boolean) => void
  saveTemplateVariables: (next?: Record<string, string>, enabled?: boolean) => Promise<void>
  expanded: boolean
  onToggleExpanded: () => void
}): ReactNode {
  const t = props.t
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const cardRef = useRef<HTMLElement>(null)
  const count = Object.keys(props.templateVariables).length
  const enabled = props.templateVariablesEnabled
  // 无变量时不显示卡片（模块列表恢复干净；「新建 → Variables」添加空行后自动出现）。
  if (count === 0) return null
  const clearAll = (): void => {
    props.setTemplateVariables({})
    void props.saveTemplateVariables({})
    setConfirmingDelete(false)
    if (props.expanded) props.onToggleExpanded()
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
        <button type="button" className={styles.configToggle} aria-expanded={props.expanded} onClick={props.onToggleExpanded}>
          <span className={styles.configTitle}>
            <span className={styles.configName}>{t('variables.title')}</span>
            <span className={styles.configMeta}>{t('variables.cardMeta', { count })}</span>
          </span>
          <IconChevronDownOutline14 className={clsx(styles.chevron, props.expanded && styles.chevronOpen)} />
        </button>
        <span className={styles.configHeaderActions}>
          <HintTooltip label={enabled ? t('variables.toggleDisable') : t('variables.toggleEnable')}>
            <label className={styles.configEnable}>
              <input
                type="checkbox"
                aria-label={t('variables.enableAria')}
                checked={enabled}
                onChange={(e) => {
                  props.setTemplateVariablesEnabled(e.target.checked)
                  void props.saveTemplateVariables(undefined, e.target.checked)
                }}
              />
              <span className={styles.switch} aria-hidden="true"><i /></span>
            </label>
          </HintTooltip>
          <span className={styles.configActions}>
            {confirmingDelete ? (
              <>
                <button type="button" className={styles.pillButton} data-danger onClick={clearAll}>{t('variables.confirmClear')}</button>
                <button type="button" className={styles.pillButton} data-variant="secondary" onClick={() => setConfirmingDelete(false)}>{t('variables.cancel')}</button>
              </>
            ) : (
              <button type="button" className={styles.pillButton} data-danger onClick={() => setConfirmingDelete(true)}>{t('variables.delete')}</button>
            )}
          </span>
        </span>
      </header>
      {props.expanded && (
        <div className={styles.configForm}>
          {!enabled && <p className={styles.configFieldHint}>{t('variables.disabledHint')}</p>}
          <VariablesEditor t={t} value={props.templateVariables} onChange={(next) => props.setTemplateVariables(next ?? {})} />
        </div>
      )}
    </article>
  )
}


/** 提示词配置编辑器：配置列表（策略过滤已并入列表）+ 公共配置卡 + 保存前权威校验。 */
export function PromptConfigsEditor(props: PromptConfigsEditorProps): ReactNode {
  const t = props.t
  return (
    <section className={styles.page} aria-label={t('configs.editor.aria')} data-module-list="true">
      <div className={styles.commonCards} aria-label={t('configs.common.aria')} data-module-category="common">
        {props.commonCards}
        <TemplateVariablesModuleCard
          t={t}
          templateVariables={props.templateVariables}
          setTemplateVariables={props.setTemplateVariables}
          templateVariablesEnabled={props.templateVariablesEnabled}
          setTemplateVariablesEnabled={props.setTemplateVariablesEnabled}
          saveTemplateVariables={props.saveTemplateVariables}
          expanded={props.variablesExpanded}
          onToggleExpanded={() => props.onVariablesExpandedChange(!props.variablesExpanded)}
        />
      </div>
      <PromptConfigList
        t={t}
        meta={props.meta}
        configs={props.configs}
        viewFilter={props.viewFilter}
        onViewFilterChange={props.onViewFilterChange}
        createdConfigId={props.createdConfigId}
        toolbarActions={props.toolbarActions}
        beforeCards={props.beforeCards}
        moduleCards={props.moduleCards}
        onPatchConfigs={props.onPatchConfigs}
        onSaveConfigs={props.onSaveConfigs}
        instructionPolicy={props.instructionPolicy}
        onToggleInstructionSource={props.onToggleInstructionSource}
        onSaveInstructionFile={props.onSaveInstructionFile}
        onReloadInstructionFile={props.onReloadInstructionFile}
        onPatchInstructionPolicy={props.onPatchInstructionPolicy}
        onNotice={props.onNotice}
      />

      <p className={styles.settingsNote}>{t('configs.note.preset')}</p>
      <p className={styles.settingsNote}>{t('configs.note.variables')}</p>
    </section>
  )
}
