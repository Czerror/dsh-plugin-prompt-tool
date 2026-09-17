import { memo, type ReactNode } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SkillCatalogEntry } from '../../data/prompt-tool-fields.ts'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { StatusBadge } from '../../ui/StatusBadge.tsx'
import type { PromptToolTranslate } from '../../locales.ts'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './skills.module.css'
import { skillEnabled, skillShadowed, skillStatusLabel, skillStatusTone } from './skill-status.ts'

const ui = { ...sharedCss, ...featureCss }

export interface SkillRowProps {
  skill: SkillCatalogEntry
  t: PromptToolTranslate
  busy: boolean
  /** 只有用户技能根里的技能可以删除；其他来源只读（改文件请到对应目录）。 */
  deletable: boolean
  onToggleBlock: (name: string, blocked: boolean) => void
  onDelete: (folder: string) => void
}

/** 技能行 memo：屏蔽开关与删除是仅有的写操作，其余全部只读展示。 */
export const SkillRow = memo(function SkillRow(props: SkillRowProps): ReactNode {
  const { skill, t, busy } = props
  const enabled = skillEnabled(skill)
  const status = skillStatusLabel(skill, t)
  const hint = skill.path ?? `${skill.dir}\\${skill.folder}`
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
      <div className={ui.skillRowActions}>
        <HintTooltip label={skill.blocked ? t('skills.row.block.hintOn') : t('skills.row.block.hintOff')}>
          <Switch
            checked={enabled}
            disabled={busy || !skill.valid}
            label={t('skills.row.block.aria', { name: skill.name })}
            onChange={() => props.onToggleBlock(skill.name, !skill.blocked)}
          />
        </HintTooltip>
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
