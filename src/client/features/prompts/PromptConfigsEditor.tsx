import { useId, useRef, useState, type FocusEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutlineRegular } from '../../ui/icons.tsx'
import { Switch } from '../../ui/Switch.tsx'
import { Button } from '../../ui/Button.tsx'
import type { PromptToolTranslate } from '../../locales.ts'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx'
import { VariablesEditor } from './PromptConfigFields.tsx'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './prompts.module.css'

const styles = { ...sharedCss, ...featureCss }


/** 层设置区的模板变量卡片：{{key}} 插值源，非 promptConfig——
 *  不进配置保存路径，保存走 /module-variables 写 module.yml 顶层 variables 段。
 *  可折叠（chevron）/ 可删除（清空全部变量，两段式确认）/ 可新建（VariablesEditor 添加变量）。 */
export function TemplateVariablesModuleCard(props: {
  t: PromptToolTranslate
  templateVariables: Record<string, string>
  setTemplateVariables: (value: Record<string, string>) => void
  templateVariablesEnabled: boolean
  setTemplateVariablesEnabled: (value: boolean) => void
  saveTemplateVariables: (next?: Record<string, string>, enabled?: boolean) => Promise<boolean | void>
  publicationPending?: boolean
  retryPublication?: () => Promise<boolean>
  expanded?: boolean
  embedded?: boolean
  disabled?: boolean
  onToggleExpanded?: () => void
}): ReactNode {
  const t = props.t
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const cardRef = useRef<HTMLElement>(null)
  const deleteRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const count = Object.keys(props.templateVariables).length
  const enabled = props.templateVariablesEnabled
  const expanded = props.embedded || props.expanded === true
  const addRef = useRef<HTMLButtonElement>(null)
  // 空态也保留本层创建入口，不依赖已退场的顶部变量菜单。
  const clearAll = async (): Promise<void> => {
    if (props.disabled) return
    if (await props.saveTemplateVariables({}) === false) throw new Error(t('variables.deleteFailed'))
    props.setTemplateVariables({})
    setConfirmingDelete(false)
    if (!props.embedded && props.expanded) props.onToggleExpanded?.()
    requestAnimationFrame(() => addRef.current?.focus())
  }
  /** 失焦自动保存：焦点离开卡片容器（含收起/切换开关/点击删除）即持久化。 */
  const autoSaveOnBlur = (event: FocusEvent<HTMLElement>): void => {
    if (confirmingDelete || props.disabled || props.publicationPending) return
    const next = event.relatedTarget
    if (next === null || !cardRef.current?.contains(next as Node)) {
      void props.saveTemplateVariables()
    }
  }
  return (
    <article ref={cardRef} className={props.embedded ? styles.moduleEmbedded : styles.configCard} onBlur={autoSaveOnBlur}>
      <header className={props.embedded ? styles.moduleEmbeddedHeader : styles.configHeader}>
        {props.embedded ? <>
          <h4 className={styles.moduleEmbeddedTitle}>{t('variables.title')}</h4>
          <span className={styles.configMeta}>{t('variables.cardMeta', { count })}</span>
        </> : <button type="button" className={styles.configToggle} aria-expanded={expanded} aria-controls={expanded ? panelId : undefined} onClick={props.onToggleExpanded}>
          <span className={styles.configTitle}>
            <span className={styles.configName}>{t('variables.title')}</span>
            <span className={styles.configMeta}>{t('variables.cardMeta', { count })}</span>
          </span>
          <IconChevronDownOutlineRegular className={clsx(styles.chevron, expanded && styles.chevronOpen)} />
        </button>}
        <span className={styles.configHeaderActions}>
          <HintTooltip label={enabled ? t('variables.toggleDisable') : t('variables.toggleEnable')}>
            <Switch label={t('variables.enableAria')} checked={enabled} disabled={props.disabled} onChange={(value) => {
              if (props.disabled) return
              props.setTemplateVariablesEnabled(value)
              void props.saveTemplateVariables(undefined, value)
            }} />
          </HintTooltip>
          <span className={styles.configActions}>
            {count === 0 && <Button ref={addRef} shape="pill" variant="outline" disabled={props.disabled} onClick={() => {
              if (props.disabled) return
              props.setTemplateVariables({ '': '' })
              if (!expanded) props.onToggleExpanded?.()
              requestAnimationFrame(() => cardRef.current?.querySelector<HTMLInputElement>('input')?.focus())
            }}>{t('variables.add')}</Button>}
            {count > 0 && <Button ref={deleteRef} shape="pill" variant="outline" disabled={props.disabled} data-danger onClick={() => setConfirmingDelete(true)}>{t('variables.delete')}</Button>}
          </span>
        </span>
      </header>
      {props.publicationPending && props.retryPublication && <Button variant="outline" shape="pill" disabled={props.disabled} onClick={() => { void props.retryPublication?.() }}>{t('workspace.retry')}</Button>}
      {expanded && (
        <div id={panelId} className={props.embedded ? styles.moduleEmbeddedBody : styles.configForm}>
          {!enabled && <p className={styles.configFieldHint}>{t('variables.disabledHint')}</p>}
          {count === 0 ? <p className={styles.configFieldHint}>{t('variables.empty')}</p> : <VariablesEditor t={t} value={props.templateVariables} disabled={props.disabled} hideHeading={props.embedded} onChange={(next) => { if (!props.disabled) props.setTemplateVariables(next ?? {}) }} />}
        </div>
      )}
      {confirmingDelete && <ConfirmDialog title={t('variables.deleteTitle')} description={t('variables.deleteDescription')}
        confirmLabel={t('variables.confirmClear')} cancelLabel={t('variables.cancel')} failureMessage={t('variables.deleteFailed')}
        returnFocusRef={deleteRef} onConfirm={clearAll} onCancel={() => setConfirmingDelete(false)} />}
    </article>
  )
}
