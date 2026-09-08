import { memo, type ReactNode } from 'react'
import clsx from 'clsx'
import type { SkillCatalogEntry } from '../../data/prompt-tool-fields.ts'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { StatusBadge } from '../../ui/StatusBadge.tsx'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './skills.module.css'
import { skillStatusLabel, skillStatusTone } from './skill-status.ts'

const ui = { ...sharedCss, ...featureCss }

export interface SkillRowProps {
  skill: SkillCatalogEntry
  depth: number
  primaryIndex: number
  enabled: boolean
  isSelected: boolean
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
  const { skill, depth, primaryIndex, enabled, isSelected, dragging, dropBefore, dropAfter, fixing } = props
  const nested = depth > 0
  const hint = `${skill.dir ?? 'skills'}/${skill.folder}${skill.description ? ` · ${skill.description}` : ''}`
  const status = skillStatusLabel(skill, enabled)
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
      <label className={ui.skillSelect} aria-label={`选择 ${skill.name || skill.folder}`}>
        <input type="checkbox" checked={isSelected} disabled={!skill.valid} onChange={() => props.onToggleSelect(skill.folder)} />
      </label>
      {nested
        ? <HintTooltip label="嵌套子技能；跟随主技能，不参与拖拽排序"><span className={ui.skillNestedMark} aria-hidden="true">▸</span></HintTooltip>
        : (
          <>
            <HintTooltip label={`第 ${primaryIndex + 1} 位；拖动调整顺序`}><span className={ui.dragHandle} aria-hidden="true">⠿</span></HintTooltip>
            <HintTooltip label={`第 ${primaryIndex + 1} 位`}><span className={ui.skillRankBadge}>{primaryIndex + 1}</span></HintTooltip>
          </>
        )}
      <div className={ui.skillCardBody}>
        <span className={ui.skillCardTitleRow}>
          <strong>{skill.name || skill.folder}</strong>
          {skill.duplicate === true && <HintTooltip label={`同名技能；来源目录 ${skill.dir ?? '未知'}`}><span className={ui.duplicateBadge}>同名</span></HintTooltip>}
          <StatusBadge tone={skillStatusTone(skill, enabled)} label={status} ariaLabel={`技能调用状态：${status}`} />
        </span>
        <small className={ui.skillCardMeta}>{hint}</small>
        {!skill.valid && skill.issue && <span className={ui.skillIssue} role="note">{skill.issue}</span>}
      </div>
      {/* Switch：独立切换技能开关。 */}
      <label className={ui.skillSwitch} htmlFor={`pt-skill-${skill.folder}`}>
        <input id={`pt-skill-${skill.folder}`} type="checkbox" checked={enabled} disabled={!skill.valid} aria-label={`启用 ${skill.name || skill.folder}`} onChange={() => props.onToggleSkill(skill.folder)} />
        <span className={ui.switch} aria-hidden="true"><i /></span>
      </label>
      {!skill.valid ? (
        <button type="button" className={ui.pillButton} disabled={fixing} onClick={() => props.onFix(skill.folder)}>
          {fixing && <span className={ui.spinner} aria-hidden="true" />}
          {fixing ? '修复中…' : '修复'}
        </button>
      ) : !nested ? (
        <span className={ui.skillOrderButtons}>
          <HintTooltip label="上移"><button type="button" className={ui.pillButton} aria-label={`上移 ${skill.name || skill.folder}`} disabled={!props.canMoveUp} onClick={() => props.onMoveUp(skill.folder)}>↑</button></HintTooltip>
          <HintTooltip label="下移"><button type="button" className={ui.pillButton} aria-label={`下移 ${skill.name || skill.folder}`} disabled={!props.canMoveDown} onClick={() => props.onMoveDown(skill.folder)}>↓</button></HintTooltip>
        </span>
      ) : null}
    </div>
  )
})
