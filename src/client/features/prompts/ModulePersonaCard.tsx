/** 人设动作字段只修改所属规则草稿，保存与冲突由规则编辑器管理。 */
import { useId, type ReactNode } from 'react'
import type { RuleAction } from '../../../shared/rules.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { FormField } from '../../ui/FormField.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import styles from '../../ui/controls.module.css'

export function ModulePersonaCard(props: { t: PromptToolTranslate; action: RuleAction; disabled?: boolean; onChange: (action: RuleAction) => void }): ReactNode {
  const { t, action, disabled } = props
  const id = useId()
  const patch = (field: string, value: string | boolean | undefined): void => {
    const next = { ...action }
    if (value === undefined) delete next[field]
    else next[field] = value
    props.onChange(next)
  }
  return <div className={styles.configForm} data-persona-action={action.id}>
    <FormField label={t('persona.audience')}>
      <MenuSelect compact ariaLabel={t('persona.audience')} disabled={disabled} value={String(action.audience ?? '')}
        options={[{ value: '', label: t('persona.all') }, { value: 'main', label: t('persona.main') }, { value: 'subagent', label: t('persona.subagent') }]}
        onChange={value => patch('audience', value || undefined)} />
    </FormField>
    {(['prefix', 'suffix'] as const).map(field => <FormField key={field} label={t(`persona.${field}.label`)}>
      <MenuSelect compact ariaLabel={`${t(`persona.${field}.label`)} ${t('persona.mode')}`} disabled={disabled}
        value={action[field] === undefined ? 'inherit' : 'custom'}
        options={[{ value: 'inherit', label: t('persona.inherit') }, { value: 'custom', label: t('persona.custom') }]}
        onChange={value => patch(field, value === 'inherit' ? undefined : '')} />
      <textarea className={styles.configTextarea} aria-label={t(`persona.${field}.aria`)} aria-describedby={`${id}-${field}-hint`} spellCheck={false}
        value={String(action[field] ?? '')} readOnly={disabled || action[field] === undefined}
        placeholder={action[field] === undefined ? t('persona.inheritedText', { field: t(`persona.${field}.label`) }) : undefined}
        onChange={event => patch(field, event.target.value)} />
      <p id={`${id}-${field}-hint`} className={styles.configFieldHint}>{t(`persona.${field}.hint`)}</p>
    </FormField>)}
    {(['complete', 'includeRuntimeContext'] as const).map(field => {
      const key = field === 'complete' ? 'complete' : 'runtimeContext'
      return <FormField key={field} label={t(`persona.${key}.label`)} hint={t(`persona.${key}.hint`)}>
        <MenuSelect compact ariaLabel={t(`persona.${key}.label`)} disabled={disabled}
          value={action[field] === undefined ? 'inherit' : String(action[field])}
          options={[{ value: 'inherit', label: t('persona.inherit') }, { value: 'true', label: t('persona.on') }, { value: 'false', label: t('persona.off') }]}
          onChange={value => patch(field, value === 'inherit' ? undefined : value === 'true')} />
      </FormField>
    })}
  </div>
}
