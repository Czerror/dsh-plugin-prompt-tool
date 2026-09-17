import { memo, type ReactNode } from 'react'
import clsx from 'clsx'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SkillCatalogEntry } from '../../data/prompt-tool-fields.ts'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { StatusBadge } from '../../ui/StatusBadge.tsx'
import type { PromptToolTranslate } from '../../locales.ts'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './skills.module.css'
import { skillIdOf, skillStatusLabel, skillStatusTone } from './skill-status.ts'

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
  busy?: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onDragStart: (id: string, event: React.DragEvent<HTMLDivElement>) => void
  onDragOver: (id: string, event: React.DragEvent<HTMLDivElement>) => void
  onDrop: (id: string, event: React.DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
  onToggleSelect: (id: string) => void
  onToggleSkill: (id: string) => void
  /** 模型 / 用户调用策略：只提交被切换的那一项。 */
  onTogglePolicy: (id: string, policy: { modelInvocable?: boolean; userInvocable?: boolean }) => void
  onFix: (id: string) => void
  onDelete: (id: string) => void
  onMoveUp: (id: string) => void
  onMoveDown: (id: string) => void
}

/** 技能行 memo：props 全部为数据/稳定回调，单行变化只重渲染该行。 */
export const SkillRow = memo(function SkillRow(props: SkillRowProps): ReactNode {
  const { skill, t, depth, primaryIndex, enabled, isSelected, dragging, dropBefore, dropAfter, fixing } = props
  const nested = depth > 0
  const id = skillIdOf(skill)
  const label = skill.name || id
  const entity = skill.entityPath ?? (skill.dir === undefined ? id : `${skill.dir}/${id}`)
  const hint = `${entity}${skill.description ? ` · ${skill.description}` : ''}`
  const status = skillStatusLabel(skill, enabled, t)
  /** 调用策略开关只在「已启用且有效」时可编辑：完全停用时策略仍保留，但需先启用链接。 */
  const policyEditable = skill.valid && enabled && props.busy !== true
  return (
    <div
      className={clsx(ui.skillCard, !skill.valid && ui.skillRowInvalid)}
      data-nested={nested ? '' : undefined}
      data-selected={isSelected ? '' : undefined}
      data-dragging={dragging ? '' : undefined}
      data-drop-before={dropBefore ? '' : undefined}
      data-drop-after={dropAfter ? '' : undefined}
      draggable={skill.valid && !nested}
      onDragStart={(event) => props.onDragStart(id, event)}
      onDragOver={(event) => props.onDragOver(id, event)}
      onDrop={(event) => props.onDrop(id, event)}
      onDragEnd={props.onDragEnd}
    >
      {/* 勾选框：只选择（职责分离——开关状态由行内 Switch 与上方批量按钮控制）。 */}
      <label className={ui.skillSelect} data-skill-select="" aria-label={t('skills.row.select.aria', { name: label })}>
        <input type="checkbox" checked={isSelected} disabled={!skill.valid || props.selectable === false} onChange={() => props.onToggleSelect(id)} />
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
          <strong>{label}</strong>
          {skill.duplicate === true && <HintTooltip label={t('skills.row.duplicate')}><span className={ui.duplicateBadge}>{t('skills.row.duplicate.badge')}</span></HintTooltip>}
          <StatusBadge tone={skillStatusTone(skill, enabled)} label={status} ariaLabel={t('skills.row.status.aria', { status })} />
        </span>
        <small className={ui.skillCardMeta}>{hint}</small>
        {skill.source !== undefined && skill.source.length > 0 && (
          <small className={ui.skillCardSource}>{t('skills.row.source', { source: skill.source })}</small>
        )}
        {!skill.valid && skill.issue && <span className={ui.skillIssue} role="note">{skill.issue}</span>}
      </div>
      {/* 调用策略：模型 / 用户各自独立，YAML 为唯一管理来源（服务端同步回 frontmatter）。 */}
      <span className={ui.skillPolicyGroup} data-skill-policy="" role="group" aria-label={t('skills.row.policy.aria', { name: label })}>
        <HintTooltip label={enabled ? t('skills.row.model.hint') : t('skills.row.policy.disabledHint')}>
          <label className={ui.skillPolicyItem}>
            <input
              type="checkbox"
              checked={skill.modelInvocable}
              disabled={!policyEditable}
              data-skill-policy-key="model"
              aria-label={t('skills.row.model.aria', { name: label })}
              onChange={() => props.onTogglePolicy(id, { modelInvocable: !skill.modelInvocable })}
            />
            <span>{t('skills.row.model')}</span>
          </label>
        </HintTooltip>
        <HintTooltip label={enabled ? t('skills.row.user.hint') : t('skills.row.policy.disabledHint')}>
          <label className={ui.skillPolicyItem}>
            <input
              type="checkbox"
              checked={skill.userInvocable}
              disabled={!policyEditable}
              data-skill-policy-key="user"
              aria-label={t('skills.row.user.aria', { name: label })}
              onChange={() => props.onTogglePolicy(id, { userInvocable: !skill.userInvocable })}
            />
            <span>{t('skills.row.user')}</span>
          </label>
        </HintTooltip>
      </span>
      {/* Switch：完全停用（链接）——实体与资源保持不变。 */}
      <Switch checked={enabled} disabled={!skill.valid || props.busy === true} label={t('skills.row.enable.aria', { name: label })} onChange={() => props.onToggleSkill(id)} />
      {!skill.valid ? (
        <button type="button" className={ui.pillButton} disabled={fixing || props.busy === true} onClick={() => props.onFix(id)}>
          {fixing && <span className={ui.spinner} aria-hidden="true" />}
          {fixing ? t('skills.row.fixing') : t('skills.row.fix')}
        </button>
      ) : !nested ? (
        <span className={ui.skillOrderButtons}>
          <HintTooltip label={t('skills.row.moveUp')}><button type="button" className={ui.pillButton} aria-label={t('skills.row.moveUp.aria', { name: label })} disabled={!props.canMoveUp} onClick={() => props.onMoveUp(id)}>↑</button></HintTooltip>
          <HintTooltip label={t('skills.row.moveDown')}><button type="button" className={ui.pillButton} aria-label={t('skills.row.moveDown.aria', { name: label })} disabled={!props.canMoveDown} onClick={() => props.onMoveDown(id)}>↓</button></HintTooltip>
        </span>
      ) : null}
      <HintTooltip label={t('skills.row.delete.hint')}>
        <button
          type="button"
          className={ui.pillButton}
          data-danger
          data-skill-delete={id}
          disabled={props.busy === true}
          onClick={() => props.onDelete(id)}
        >
          {t('skills.row.delete')}
        </button>
      </HintTooltip>
    </div>
  )
})
