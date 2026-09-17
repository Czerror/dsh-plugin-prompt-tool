import { memo, type ReactNode } from 'react'
import clsx from 'clsx'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SkillCatalogEntry } from '../../data/prompt-tool-fields.ts'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { StatusBadge } from '../../ui/StatusBadge.tsx'
import type { PromptToolTranslate } from '../../locales.ts'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './skills.module.css'
import { skillStatusLabel, skillStatusTone } from './skill-status.ts'

const ui = { ...sharedCss, ...featureCss }

export interface SkillRowProps {
  skill: SkillCatalogEntry
  t: PromptToolTranslate
  depth: number
  primaryIndex: number
  enabled: boolean
  isSelected: boolean
  selectable?: boolean
  dragging: boolean
  dropBefore: boolean
  dropAfter: boolean
  fixing: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onDragStart: (folder: string, event: React.DragEvent<HTMLDivElement>) => void
  onDragOver: (folder: string, event: React.DragEvent<HTMLDivElement>) => void
  onDrop: (folder: string, event: React.DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
  onToggleSelect: (folder: string) => void
  onToggleSkill: (folder: string) => void
  onFix: (folder: string) => void
  onMoveUp: (folder: string) => void
  onMoveDown: (folder: string) => void
}

/** 技能行 memo：props 全部为数据/稳定回调，单行变化只重渲染该行。 */
export const SkillRow = memo(function SkillRow(props: SkillRowProps): ReactNode {
  const { skill, t, depth, primaryIndex, enabled, isSelected, dragging, dropBefore, dropAfter, fixing } = props
  const nested = depth > 0
  const hint = `${skill.dir ?? 'skills'}/${skill.folder}${skill.description ? ` · ${skill.description}` : ''}`
  const status = skillStatusLabel(skill, enabled, t)
  return (
    <div
      className={clsx(ui.skillCard, !skill.valid && ui.skillRowInvalid)}
      data-nested={nested ? '' : undefined}
      data-selected={isSelected ? '' : undefined}
      data-dragging={dragging ? '' : undefined}
      data-drop-before={dropBefore ? '' : undefined}
      data-drop-after={dropAfter ? '' : undefined}
      draggable={skill.valid && !nested}
      onDragStart={(event) => props.onDragStart(skill.folder, event)}
      onDragOver={(event) => props.onDragOver(skill.folder, event)}
      onDrop={(event) => props.onDrop(skill.folder, event)}
      onDragEnd={props.onDragEnd}
    >
      {/* 勾选框：只选择（职责分离——开关状态由行内 Switch 与上方批量按钮控制）。 */}
      <label className={ui.skillSelect} aria-label={t('skills.row.select.aria', { name: skill.name || skill.folder })}>
        <input type="checkbox" checked={isSelected} disabled={!skill.valid || props.selectable === false} onChange={() => props.onToggleSelect(skill.folder)} />
      </label>
      {nested
        ? <HintTooltip label={t('skills.row.nested')}><span className={ui.skillNestedMark} aria-hidden="true">▸</span></HintTooltip>
        : (
          <>
            <HintTooltip label={t('skills.row.rank.drag', { index: primaryIndex + 1 })}><span className={ui.dragHandle} aria-hidden="true">⠿</span></HintTooltip>
            <HintTooltip label={t('skills.row.rank', { index: primaryIndex + 1 })}><span className={ui.skillRankBadge}>{primaryIndex + 1}</span></HintTooltip>
          </>
        )}
      <div className={ui.skillCardBody}>
        <span className={ui.skillCardTitleRow}>
          <strong>{skill.name || skill.folder}</strong>
          {skill.duplicate === true && <HintTooltip label={t('skills.row.duplicate', { dir: skill.dir ?? t('skills.row.duplicate.unknown') })}><span className={ui.duplicateBadge}>{t('skills.row.duplicate.badge')}</span></HintTooltip>}
          <StatusBadge tone={skillStatusTone(skill, enabled)} label={status} ariaLabel={t('skills.row.status.aria', { status })} />
        </span>
        <small className={ui.skillCardMeta}>{hint}</small>
        {!skill.valid && skill.issue && <span className={ui.skillIssue} role="note">{skill.issue}</span>}
      </div>
      {/* Switch：独立切换技能开关。 */}
      <Switch checked={enabled} disabled={!skill.valid} label={t('skills.row.enable.aria', { name: skill.name || skill.folder })} onChange={() => props.onToggleSkill(skill.folder)} />
      {!skill.valid ? (
        <button type="button" className={ui.pillButton} disabled={fixing} onClick={() => props.onFix(skill.folder)}>
          {fixing && <span className={ui.spinner} aria-hidden="true" />}
          {fixing ? t('skills.row.fixing') : t('skills.row.fix')}
        </button>
      ) : !nested ? (
        <span className={ui.skillOrderButtons}>
          <HintTooltip label={t('skills.row.moveUp')}><button type="button" className={ui.pillButton} aria-label={t('skills.row.moveUp.aria', { name: skill.name || skill.folder })} disabled={!props.canMoveUp} onClick={() => props.onMoveUp(skill.folder)}>↑</button></HintTooltip>
          <HintTooltip label={t('skills.row.moveDown')}><button type="button" className={ui.pillButton} aria-label={t('skills.row.moveDown.aria', { name: skill.name || skill.folder })} disabled={!props.canMoveDown} onClick={() => props.onMoveDown(skill.folder)}>↓</button></HintTooltip>
        </span>
      ) : null}
    </div>
  )
})
