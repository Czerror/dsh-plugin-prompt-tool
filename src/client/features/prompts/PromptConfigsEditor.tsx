import { useId, useRef, useState, type FocusEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutlineRegular, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PromptToolTranslate } from '../../locales.ts'
import { PromptConfigList, type PromptConfigListProps } from './PromptConfigList.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx'
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

export interface PromptConfigsEditorProps extends Pick<PromptConfigListProps, 'browse' | 'fieldDrafts' | 'draftScope' | 'notice' | 'noticeKind' | 'readOnlyReason' | 'onChoosePreset' | 'onCreate' | 'createdHidden' | 'onShowCreated'> {
  t: PromptToolTranslate
  meta: EngineMeta
  configs: PromptConfigDraft[]
  onPatchConfigs: (configs: PromptConfigDraft[]) => void
  onSaveConfigs: (configs: PromptConfigDraft[]) => Promise<boolean>
  onSaveInstructions?: () => Promise<boolean>
  instructionPolicy?: InstructionPolicySnapshot
  onToggleInstructionSource?: (enabled: boolean) => Promise<boolean>
  /** 指令文件卡：显式写盘 / 重新读取（不经预设保存路径）。 */
  onSaveInstructionFile?: (fileId: string) => void
  onReloadInstructionFile?: (fileId: string) => void
  /** 指令文件卡的行为策略改动（独立策略存储）。 */
  onPatchInstructionPolicy?: (fileId: string, override: InstructionPolicyFileOverride) => void
  onNotice: (kind: 'ok' | 'error', message: string) => void
  viewFilter: string
  onViewFilterChange: (value: string) => void
  /** 统一搜索词（页面持有）：同一搜索词过滤配置实例、能力卡、共享设置区与单例卡。 */
  keyword?: string
  onKeywordChange?: (value: string) => void
  /** 本层引擎设置内容（页面注入）：同层每张实例卡显示同一份值，展开才渲染。 */
  renderLayerSettings?: (layer: string, config: PromptConfigDraft) => ReactNode
  /** 该层是否有可编辑设置：决定真实实例卡内是否显示设置区。 */
  hasLayerSettings?: (layer: string) => boolean
  matchesLayerSettings?: (layer: string, keyword: string) => boolean
  createdConfigId?: string
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
/** 模板变量卡（模块列表置顶单例）；子代理页的「添加模板变量」入口复用同一实现。 */
export function TemplateVariablesModuleCard(props: {
  t: PromptToolTranslate
  templateVariables: Record<string, string>
  setTemplateVariables: (value: Record<string, string>) => void
  templateVariablesEnabled: boolean
  setTemplateVariablesEnabled: (value: boolean) => void
  saveTemplateVariables: (next?: Record<string, string>, enabled?: boolean) => Promise<boolean | void>
  expanded: boolean
  disabled?: boolean
  onToggleExpanded: () => void
}): ReactNode {
  const t = props.t
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const cardRef = useRef<HTMLElement>(null)
  const deleteRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const count = Object.keys(props.templateVariables).length
  const enabled = props.templateVariablesEnabled
  const addRef = useRef<HTMLButtonElement>(null)
  // 空态也保留本层创建入口，不依赖已退场的顶部变量菜单。
  const clearAll = async (): Promise<void> => {
    if (props.disabled) return
    if (await props.saveTemplateVariables({}) === false) throw new Error(t('variables.deleteFailed'))
    props.setTemplateVariables({})
    setConfirmingDelete(false)
    if (props.expanded) props.onToggleExpanded()
    requestAnimationFrame(() => addRef.current?.focus())
  }
  /** 失焦自动保存：焦点离开卡片容器（含收起/切换开关/点击删除）即持久化。 */
  const autoSaveOnBlur = (event: FocusEvent<HTMLElement>): void => {
    if (confirmingDelete || props.disabled) return
    const next = event.relatedTarget
    if (next === null || !cardRef.current?.contains(next as Node)) {
      void props.saveTemplateVariables()
    }
  }
  return (
    <article ref={cardRef} className={styles.configCard} onBlur={autoSaveOnBlur}>
      <header className={styles.configHeader}>
        <button type="button" className={styles.configToggle} aria-expanded={props.expanded} aria-controls={props.expanded ? panelId : undefined} onClick={props.onToggleExpanded}>
          <span className={styles.configTitle}>
            <span className={styles.configName}>{t('variables.title')}</span>
            <span className={styles.configMeta}>{t('variables.cardMeta', { count })}</span>
          </span>
          <IconChevronDownOutlineRegular className={clsx(styles.chevron, props.expanded && styles.chevronOpen)} />
        </button>
        <span className={styles.configHeaderActions}>
          <HintTooltip label={enabled ? t('variables.toggleDisable') : t('variables.toggleEnable')}>
            <Switch label={t('variables.enableAria')} checked={enabled} disabled={props.disabled} onChange={(value) => {
              if (props.disabled) return
              props.setTemplateVariablesEnabled(value)
              void props.saveTemplateVariables(undefined, value)
            }} />
          </HintTooltip>
          <span className={styles.configActions}>
            {count === 0 && <button ref={addRef} type="button" disabled={props.disabled} className={styles.pillButton} onClick={() => {
              if (props.disabled) return
              props.setTemplateVariables({ '': '' })
              if (!props.expanded) props.onToggleExpanded()
              requestAnimationFrame(() => cardRef.current?.querySelector<HTMLInputElement>('input')?.focus())
            }}>{t('variables.add')}</button>}
            {count > 0 && <button ref={deleteRef} type="button" disabled={props.disabled} className={styles.pillButton} data-danger onClick={() => setConfirmingDelete(true)}>{t('variables.delete')}</button>}
          </span>
        </span>
      </header>
      {props.expanded && (
        <div id={panelId} className={styles.configForm}>
          {!enabled && <p className={styles.configFieldHint}>{t('variables.disabledHint')}</p>}
          {count === 0 ? <p className={styles.configFieldHint}>{t('variables.empty')}</p> : <VariablesEditor t={t} value={props.templateVariables} disabled={props.disabled} onChange={(next) => { if (!props.disabled) props.setTemplateVariables(next ?? {}) }} />}
        </div>
      )}
      {confirmingDelete && <ConfirmDialog title={t('variables.deleteTitle')} description={t('variables.deleteDescription')}
        confirmLabel={t('variables.confirmClear')} cancelLabel={t('variables.cancel')} failureMessage={t('variables.deleteFailed')}
        returnFocusRef={deleteRef} onConfirm={clearAll} onCancel={() => setConfirmingDelete(false)} />}
    </article>
  )
}


/** 提示词配置编辑器：配置列表（策略过滤已并入列表）+ 公共配置卡 + 保存前权威校验。 */
export function PromptConfigsEditor(props: PromptConfigsEditorProps): ReactNode {
  const t = props.t
  return (
    <section className={styles.page} aria-label={t('configs.editor.aria')} data-module-list="true">
      <PromptConfigList
        t={t}
        scope="main"
        browse={props.browse}
        fieldDrafts={props.fieldDrafts}
        draftScope={props.draftScope}
        notice={props.notice}
        noticeKind={props.noticeKind}
        readOnlyReason={props.readOnlyReason}
        onChoosePreset={props.onChoosePreset}
        onCreate={props.onCreate}
        createdHidden={props.createdHidden}
        onShowCreated={props.onShowCreated}
        commonCards={props.commonCards === undefined ? undefined : <div className={styles.commonCards} aria-label={t('configs.common.aria')} data-module-category="common">
          {props.commonCards}
        </div>}
        meta={props.meta}
        configs={props.configs}
        viewFilter={props.viewFilter}
        onViewFilterChange={props.onViewFilterChange}
        keyword={props.keyword}
        onKeywordChange={props.onKeywordChange}
        renderLayerSettings={props.renderLayerSettings}
        hasLayerSettings={props.hasLayerSettings}
        matchesLayerSettings={props.matchesLayerSettings}
        createdConfigId={props.createdConfigId}
        toolbarActions={props.toolbarActions}
        beforeCards={props.beforeCards}
        moduleCards={props.moduleCards}
        onPatchConfigs={props.onPatchConfigs}
        onSaveConfigs={props.onSaveConfigs}
        onSaveInstructions={props.onSaveInstructions}
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
