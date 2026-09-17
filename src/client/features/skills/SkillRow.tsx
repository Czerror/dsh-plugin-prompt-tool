import { memo, type ReactNode } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SkillCatalogEntry } from '../../data/prompt-tool-fields.ts'
import type { SkillBlockScope } from '../../../shared/skills.ts'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { StatusBadge } from '../../ui/StatusBadge.tsx'
import type { PromptToolTranslate } from '../../locales.ts'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './skills.module.css'
import { scopeAfterToggle, skillShadowed, skillStatusLabel, skillStatusTone } from './skill-status.ts'

const ui = { ...sharedCss, ...featureCss }

export interface SkillRowProps {
  skill: SkillCatalogEntry
  t: PromptToolTranslate
  busy: boolean
  /** 只有用户技能根里的技能可以删除；其他来源只读（改文件请到对应目录）。 */
  deletable: boolean
  /** 设置注册层屏蔽范围：'none' 表示恢复该技能。 */
  onSetScope: (name: string, scope: SkillBlockScope) => void
  onDelete: (folder: string) => void
}

/** 技能行 memo：两个注册层开关与删除是仅有的写操作，其余全部只读展示。 */
export const SkillRow = memo(function SkillRow(props: SkillRowProps): ReactNode {
  const { skill, t, busy } = props
  const status = skillStatusLabel(skill, t)
  const hint = skill.path ?? `${skill.dir}\\${skill.folder}`
  // 先归一成两个布尔：同一个表达式在 checked 与 scopeAfterToggle 里含义相反（当前未屏蔽 / 点击后已屏蔽），
  // 直接内联正是上一轮被读反的地方。
  const modelBlocked = skill.blockedModel === true
  const userBlocked = skill.blockedUser === true
  return (
    <div className={ui.skillCard} data-blocked={skill.blocked ? '' : undefined} data-invalid={!skill.valid ? '' : undefined}>
      <div className={ui.skillCardBody}>
        <span className={ui.skillCardTitleRow}>
          <strong>{skill.name}</strong>
          <span className={ui.skillSourceBadge}>{t(`skills.source.${skill.source}` as never)}</span>
          <HintTooltip label={t('skills.row.priority', { rank: skill.rank })}>
            <span className={ui.skillRankBadge}>{skill.rank}</span>
          </HintTooltip>
          <StatusBadge tone={skillStatusTone(skill)} label={status} ariaLabel={t('skills.row.status.aria', { status })} />
        </span>
        <small className={ui.skillCardMeta}>{skill.description || t('skills.row.noDescription')}</small>
        <small className={ui.skillCardSource}>{hint}</small>
        {skillShadowed(skill) && <span className={ui.skillIssue} role="note">{t('skills.row.shadowedHint')}</span>}
        {!skill.valid && skill.issue && <span className={ui.skillIssue} role="note">{skill.issue}</span>}
      </div>
      {/* 注册层开关：技能自身的声明由上面的徽章与描述如实展示，这里只控制插件是否屏蔽该端。 */}
      <div className={ui.skillRowActions} data-skill-block-group="">
        <span className={ui.skillPolicyGroup} role="group" aria-label={t('skills.row.toggles.aria', { name: skill.name })}>
          <HintTooltip label={t('skills.row.modelToggle.hint')}>
            <span className={ui.skillPolicyItem}>
              <Switch
                checked={!modelBlocked}
                disabled={busy || !skill.valid}
                label={t('skills.row.modelToggle.aria', { name: skill.name })}
                onChange={() => props.onSetScope(skill.name, scopeAfterToggle(skill, 'model'))}
              />
              <span>{t('skills.row.modelToggle')}</span>
            </span>
          </HintTooltip>
          <HintTooltip label={t('skills.row.userToggle.hint')}>
            <span className={ui.skillPolicyItem}>
              <Switch
                checked={!userBlocked}
                disabled={busy || !skill.valid}
                label={t('skills.row.userToggle.aria', { name: skill.name })}
                onChange={() => props.onSetScope(skill.name, scopeAfterToggle(skill, 'user'))}
              />
              <span>{t('skills.row.userToggle')}</span>
            </span>
          </HintTooltip>
        </span>
        {props.deletable && (
          <HintTooltip label={t('skills.row.delete.hint')}>
            <button
              type="button"
              className={ui.pillButton}
              data-danger
              data-skill-delete={skill.folder}
              disabled={busy}
              onClick={() => props.onDelete(skill.folder)}
            >
              {t('skills.row.delete')}
            </button>
          </HintTooltip>
        )}
      </div>
    </div>
  )
})
