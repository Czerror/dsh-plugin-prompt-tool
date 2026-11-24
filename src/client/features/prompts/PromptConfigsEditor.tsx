import { useRef, useState, type ReactNode } from 'react'
import { Switch } from '../../ui/Switch.tsx'
import { Button } from '../../ui/Button.tsx'
import { PublicationNotice } from '../../ui/PublicationNotice.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import type { ModuleVariableScope } from '../../../shared/module-variables.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx'
import { useAutosave } from '../../data/use-autosave.ts'
import { VariablesEditor } from './PromptConfigFields.tsx'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './prompts.module.css'

const styles = { ...sharedCss, ...featureCss }


/** 两级持久变量共用一张卡；保存走 /module-variables 的范围与版本事务。
 *  模块值拥有同名覆盖，全局值在同一安装内共享。 */
export function TemplateVariablesModuleCard(props: {
  t: PromptToolTranslate
  scope: ModuleVariableScope
  onScopeChange: (scope: ModuleVariableScope) => void
  inheritedVariables: Record<string, string>
  loading: boolean
  error?: string
  templateVariables: Record<string, string>
  setTemplateVariables: (value: Record<string, string>) => void
  templateVariablesEnabled: boolean
  setTemplateVariablesEnabled: (value: boolean) => void
  saveTemplateVariables: (next?: Record<string, string>, enabled?: boolean) => Promise<boolean | void>
  publicationPending?: boolean
  retryPublication?: () => Promise<boolean>
  disabled?: boolean
}): ReactNode {
  const t = props.t
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const cardRef = useRef<HTMLElement>(null)
  const deleteRef = useRef<HTMLButtonElement>(null)
  const count = Object.keys(props.templateVariables).length
  const disabled = props.disabled || props.loading
  const autosave = useAutosave(props.scope, () => {
    if (!disabled && !confirmingDelete && !props.publicationPending && Object.keys(props.templateVariables).every(key => key.trim().length > 0)) void props.saveTemplateVariables()
  })
  const overrides = Object.keys(props.templateVariables).filter(key => Object.hasOwn(props.inheritedVariables, key))
  const inherited = Object.keys(props.inheritedVariables).filter(key => !Object.hasOwn(props.templateVariables, key))
  const enabled = props.templateVariablesEnabled
  const addRef = useRef<HTMLButtonElement>(null)
  // 空态也保留本层创建入口，不依赖已退场的顶部变量菜单。
  const clearAll = async (): Promise<void> => {
    if (disabled) return
    if (await props.saveTemplateVariables({}) === false) throw new Error(t('variables.deleteFailed'))
    setConfirmingDelete(false)
    requestAnimationFrame(() => addRef.current?.focus())
  }
  return (
    <article ref={cardRef} className={styles.moduleEmbedded}
      onFocus={autosave.onFocus} onBlur={autosave.onBlur}
      onCompositionStart={autosave.onCompositionStart} onCompositionEnd={autosave.onCompositionEnd}>
      <header className={styles.moduleEmbeddedHeader}>
        <h4 className={styles.moduleEmbeddedTitle}>{t('variables.title')}</h4>
        <span className={styles.configMeta}>{t('variables.cardMeta', { count })}</span>
        <span className={styles.configHeaderActions}>
          <MenuSelect value={props.scope} ariaLabel={t('form.section.scope')} compact
            options={[{ value: 'module', label: t('variables.scope.module') }, { value: 'global', label: t('variables.scope.global') }]}
            disabled={props.disabled || confirmingDelete} onChange={value => { autosave.flush(); props.onScopeChange(value as ModuleVariableScope) }} />
          {props.scope === 'module' && <HintTooltip label={enabled ? t('variables.toggleDisable') : t('variables.toggleEnable')}>
            <Switch label={t('variables.enableAria')} checked={enabled} disabled={disabled} onChange={(value) => {
              if (disabled) return
              props.setTemplateVariablesEnabled(value)
              void props.saveTemplateVariables(undefined, value)
            }} />
          </HintTooltip>}
          <span className={styles.configActions}>
            {count === 0 && <Button ref={addRef} shape="pill" variant="outline" disabled={disabled} onClick={() => {
              if (disabled) return
              props.setTemplateVariables({ '': '' })
              requestAnimationFrame(() => cardRef.current?.querySelector<HTMLInputElement>('input')?.focus())
            }}>{t('variables.add')}</Button>}
            {count > 0 && <Button ref={deleteRef} shape="pill" variant="outline" disabled={disabled} data-danger onClick={() => setConfirmingDelete(true)}>{t('variables.delete')}</Button>}
          </span>
        </span>
      </header>
      {props.error && !props.publicationPending && <p role="alert" className={styles.configFieldHint}>{props.error}</p>}
      <PublicationNotice publication={{ pending: props.publicationPending === true, error: props.publicationPending ? props.error : undefined }}
        pendingLabel={t('publication.pending')} retryLabel={t('workspace.retry')} disabled={props.disabled}
        onRetry={props.retryPublication === undefined ? undefined : () => { void props.retryPublication?.() }} />
      <div className={styles.moduleEmbeddedBody}>
        {props.scope === 'global' ? <p className={styles.configFieldHint}>{t('variables.globalHint')}</p> : <>
          {!enabled && <p className={styles.configFieldHint}>{t('variables.disabledHint')}</p>}
          {overrides.length > 0 && <p className={styles.configFieldHint}>{t('variables.overridden', { names: overrides.join(t('variables.nameSeparator')) })}</p>}
          {inherited.length > 0 && <p className={styles.configFieldHint}>{t('variables.inherited', { names: inherited.join(t('variables.nameSeparator')) })}</p>}
        </>}
        {props.loading ? (!props.error && <p className={styles.configFieldHint}>{t('variables.loading')}</p>)
          : count === 0 ? <p className={styles.configFieldHint}>{t('variables.empty')}</p>
            : <VariablesEditor key={props.scope} t={t} value={props.templateVariables} disabled={disabled} hideHeading
              onChange={(next) => { if (!disabled) props.setTemplateVariables(next ?? {}) }}
              onRemove={(next) => {
                if (disabled) return
                const values = next ?? {}
                props.setTemplateVariables(values)
                autosave.commit(() => { void props.saveTemplateVariables(values) })
              }} />}
      </div>
      {confirmingDelete && <ConfirmDialog title={t('variables.deleteTitle')} description={props.scope === 'global' ? t('variables.globalDeleteDescription') : t('variables.deleteDescription')}
        confirmLabel={t('variables.confirmClear')} cancelLabel={t('variables.cancel')} failureMessage={t('variables.deleteFailed')}
        returnFocusRef={deleteRef} onConfirm={clearAll} onCancel={() => setConfirmingDelete(false)} />}
    </article>
  )
}
