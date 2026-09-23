import { memo, useEffect, useId, useMemo, useReducer, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutlineRegular, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SkillCatalogEntry } from '../../data/prompt-tool-fields.ts'
import type { SkillPolicyChange } from '../../../shared/skills.ts'
import type { SkillEditorDraft } from '../../data/workspace-drafts.ts'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx'
import { StatusBadge } from '../../ui/StatusBadge.tsx'
import type { PromptToolTranslate } from '../../locales.ts'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './skills.module.css'
import { policyAfterToggle, skillShadowed, skillStatusLabel, skillStatusTone, skillUnavailable } from './skill-status.ts'

const ui = { ...sharedCss, ...featureCss }

export interface SkillRowProps {
  skill: SkillCatalogEntry
  t: PromptToolTranslate
  busy: boolean
  store: PromptToolStore
  sessionId: string | undefined
  onSetPolicy: (name: string, path: string, change: SkillPolicyChange) => Promise<boolean>
  onDelete: (skill: SkillCatalogEntry) => void
}

/** 三行摘要与卡内编辑；草稿按会话和文件身份保留，不随折叠、筛选或切页丢失。 */
export const SkillRow = memo(function SkillRow(props: SkillRowProps): ReactNode {
  const { skill, t, busy, store, sessionId } = props
  const panelId = useId()
  const key = JSON.stringify([sessionId, skill.id, skill.path])
  const editor = useMemo((): SkillEditorDraft => {
    const retained = store.editorDrafts.skills.get(key)
    if (retained) return retained
    const next = { text: '', description: '', error: '', loading: false, saving: false }
    store.editorDrafts.skills.set(key, next)
    return next
  }, [store.editorDrafts, key])
  const [, render] = useReducer((value: number) => value + 1, 0)
  const [expanded, setExpanded] = useState(store.editorDrafts.expanded.get(key) ?? false)
  const [confirmReload, setConfirmReload] = useState(false)
  useEffect(() => { editor.refresh = render; return () => { editor.refresh = undefined } }, [editor])
  const dirty = editor.saved !== undefined && (editor.text !== editor.saved.content || editor.description !== editor.saved.description)
  const editable = skill.canEdit === true && skill.path !== undefined
  const load = async (): Promise<void> => {
    if (editor.loading || editor.saving) return
    editor.loading = true
    editor.error = ''
    editor.refresh?.()
    try {
      const result = await store.readSkill(skill, sessionId)
      if (result.ok) { editor.saved = result.value; editor.text = result.value.content; editor.description = result.value.description }
      else editor.error = result.message ?? t('skills.edit.readFailed')
    } catch (error) {
      editor.error = error instanceof Error ? error.message : t('skills.edit.readFailed')
    } finally { editor.loading = false; editor.refresh?.() }
  }
  useEffect(() => { if (expanded && editable && !editor.saved && !editor.error) void load() }, [expanded, editable, editor])
  const save = async (): Promise<void> => {
    if (!editor.saved || editor.saving || editor.loading || busy || !editable || !dirty) return
    editor.saving = true
    editor.error = ''
    const submitted = editor.text
    const description = editor.description
    editor.refresh?.()
    try {
      const result = await store.saveSkill(skill, submitted, description, editor.saved.revision, sessionId)
      if (result.ok) {
        editor.saved = result.value
        if (editor.text === submitted) editor.text = result.value.content
        if (editor.description === description) editor.description = result.value.description
      } else editor.error = result.message ?? t('skills.edit.saveFailed')
    } catch (error) {
      editor.error = error instanceof Error ? error.message : t('skills.edit.saveFailed')
    } finally { editor.saving = false; editor.refresh?.() }
  }
  const toggle = async (side: 'model' | 'user'): Promise<void> => {
    if (skill.path !== undefined && await props.onSetPolicy(skill.name, skill.path, policyAfterToggle(skill, side))
      && editable && (!editor.saved || (editor.text === editor.saved.content && editor.description === editor.saved.description))) await load()
  }
  const status = skillStatusLabel(skill, t)
  const hint = skill.path ?? (skill.dir.length > 0 ? `${skill.dir}/${skill.folder}` : skill.provider ?? '')
  // 两个开关只表示文件声明；实际会话注册状态单独显示在徽章里。
  const modelInvocable = skill.modelInvocable
  const userInvocable = skill.userInvocable
  // 无有效 frontmatter 或没有可写路径（例如来源未提供标记文件）时不给写入口。
  const writable = !busy && !dirty && !editor.loading && !editor.saving && skill.canSetPolicy === true && skill.valid && skill.path !== undefined
  return (
    <article className={clsx(ui.configCard, ui.skillEntry, expanded && ui.configCardOpen)} data-skill-card={skill.id} data-blocked={skillUnavailable(skill) ? '' : undefined} data-invalid={!skill.valid ? '' : undefined}>
      <header className={ui.configHeader}>
        <button type="button" className={ui.configToggle} data-skill-expand="" aria-expanded={expanded} aria-controls={panelId}
          aria-label={t('skills.row.expand', { name: skill.name })}
          onClick={() => { setExpanded(!expanded); store.editorDrafts.expanded.set(key, !expanded) }}>
          <span className={ui.configTitle}>
            <span className={ui.skillCardTitleRow} data-skill-heading="">
              <strong className={ui.skillName}>{skill.name}</strong>
              <StatusBadge tone={skillStatusTone(skill)} label={status} ariaLabel={t('skills.row.status.aria', { status })} />
              {dirty && <span className={ui.skillDraftMark}>{t('skills.edit.dirty')}</span>}
            </span>
            <span className={ui.skillCardMeta} data-skill-description="">{skill.description || t('skills.row.noDescription')}</span>
            <span className={ui.skillSourceLine} data-skill-source="">
              <span className={ui.skillCardSource}>{hint}</span>
              <span className={ui.skillPriority}>{t('skills.row.priorityShort', { rank: skill.rank })}</span>
            </span>
          </span>
          <IconChevronDownOutlineRegular className={clsx(ui.chevron, expanded && ui.chevronOpen)} />
        </button>
      </header>
      <div id={panelId} hidden={!expanded} className={ui.configForm}>
        {expanded && <>
          {skillShadowed(skill) && <span className={ui.skillIssue} role="note">{t('skills.row.shadowedHint')}</span>}
          {!skill.valid && skill.issue && <span className={ui.skillIssue} role="note">{skill.issue}</span>}
          {skill.readonlyReason && <span className={ui.skillCardSource} role="note">{skill.readonlyReason}</span>}
          {/* 调用策略只改官方两个键；正文和其余字段不动。 */}
          <div className={ui.skillRowActions} data-skill-block-group="">
            <span className={ui.skillPolicyGroup} role="group" aria-label={t('skills.row.toggles.aria', { name: skill.name })}>
              <HintTooltip label={t('skills.row.modelToggle.hint')}>
                <span className={ui.skillPolicyItem} data-skill-policy="model">
                  <span>{t('skills.row.modelToggle')}</span>
                  <Switch checked={modelInvocable} disabled={!writable}
                    label={t('skills.row.modelToggle.aria', { name: skill.name })}
                    onChange={() => { void toggle('model') }} />
                </span>
              </HintTooltip>
              <HintTooltip label={t('skills.row.userToggle.hint')}>
                <span className={ui.skillPolicyItem} data-skill-policy="user">
                  <span>{t('skills.row.userToggle')}</span>
                  <Switch checked={userInvocable} disabled={!writable}
                    label={t('skills.row.userToggle.aria', { name: skill.name })}
                    onChange={() => { void toggle('user') }} />
                </span>
              </HintTooltip>
            </span>
          </div>
          {editable && <>
            <label className={ui.skillCreateField}>
              <span>{t('skills.edit.description')}</span>
              <input className={ui.configInput} data-skill-description-editor="" aria-label={t('skills.edit.description')}
                value={editor.description} disabled={!editor.saved || editor.loading}
                onChange={(event) => { editor.description = event.target.value; editor.refresh?.() }} />
            </label>
            <label className={ui.skillCreateField}>
              <span>{t('skills.edit.content')}</span>
              <textarea className={clsx(ui.configInput, ui.skillEditor)} data-skill-editor="" aria-label={t('skills.edit.content')}
                spellCheck={false} rows={14} value={editor.text} disabled={!editor.saved || editor.loading}
                onChange={(event) => { editor.text = event.target.value; editor.refresh?.() }} />
            </label>
            <p className={ui.configFieldHint}>{t('skills.edit.hint')}</p>
            {editor.error && <p className={ui.skillIssue} role="alert">{editor.error}</p>}
          </>}
          <div className={clsx(ui.skillRowActions, ui.skillFooter)} data-skill-actions="">
            {editable && <>
              <button type="button" className={ui.pillButton} data-skill-save="" disabled={!dirty || busy || editor.loading || editor.saving} onClick={() => { void save() }}>
                {t(editor.saving ? 'skills.edit.saving' : 'skills.edit.save')}
              </button>
              <button type="button" className={ui.pillButton} data-skill-reload="" disabled={busy || editor.loading || editor.saving}
                onClick={() => { if (dirty) setConfirmReload(true); else void load() }}>{t('skills.edit.reload')}</button>
            </>}
            {editable && <span className={ui.configFieldHint} role="status">{t(editor.loading ? 'skills.edit.loading' : dirty ? 'skills.edit.dirty' : editor.saved ? 'skills.edit.saved' : 'skills.edit.unloaded')}</span>}
            {skill.canDelete === true && skill.path !== undefined && (
              <HintTooltip label={t('skills.row.delete.hint')}>
                <button type="button" className={clsx(ui.pillButton, ui.skillDelete)} data-danger data-skill-delete={skill.folder}
                  data-skill-path={skill.path} disabled={busy || editor.saving} onClick={() => props.onDelete(skill)}>
                  {t('skills.row.delete')}
                </button>
              </HintTooltip>
            )}
          </div>
        </>}
      </div>
      {confirmReload && <ConfirmDialog title={t('skills.edit.reload')} description={t('skills.edit.reloadConfirm')}
        confirmLabel={t('skills.edit.reload')} cancelLabel={t('skills.dir.cancel')}
        onConfirm={async () => { await load(); setConfirmReload(false) }} onCancel={() => setConfirmReload(false)} />}
    </article>
  )
})
