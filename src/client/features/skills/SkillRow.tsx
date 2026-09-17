import { memo, type ReactNode } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SkillCatalogEntry } from '../../data/prompt-tool-fields.ts'
import type { SkillPolicyScope } from '../../../shared/skills.ts'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { StatusBadge } from '../../ui/StatusBadge.tsx'
import type { PromptToolTranslate } from '../../locales.ts'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './skills.module.css'
import { scopeAfterToggle, skillShadowed, skillStatusLabel, skillStatusTone, skillUnavailable } from './skill-status.ts'

const ui = { ...sharedCss, ...featureCss }

export interface SkillRowProps {
  skill: SkillCatalogEntry
  t: PromptToolTranslate
  busy: boolean
  /** 只有用户技能根里的技能可以删除；其他来源只读（改文件请到对应目录）。 */
  deletable: boolean
  /** 写调用策略：'none' 表示两端恢复。path 由清单提供，服务端会再校验一次身份。 */
  onSetScope: (name: string, path: string, scope: SkillPolicyScope) => void
  onDelete: (folder: string) => void
}

/** 技能行 memo：两个调用策略开关与删除是仅有的写操作，其余全部只读展示。 */
export const SkillRow = memo(function SkillRow(props: SkillRowProps): ReactNode {
  const { skill, t, busy } = props
  const status = skillStatusLabel(skill, t)
  const hint = skill.path ?? `${skill.dir}\\${skill.folder}`
  // 两个布尔是「该端当前可调用」：开关的 checked 直接取它，scopeAfterToggle 也按同一含义取反。
  const modelInvocable = skill.modelInvocable
  const userInvocable = skill.userInvocable
  // 无有效 frontmatter 或没有可写路径（例如来源未提供标记文件）时不给写入口。
  const writable = !busy && skill.valid && skill.path !== undefined
  return (
    <div className={ui.skillCard} data-blocked={skillUnavailable(skill) ? '' : undefined} data-invalid={!skill.valid ? '' : undefined}>
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
      {/* 调用策略开关：直接写技能文件 frontmatter 的官方两个键，正文与其余字段不动。 */}
      <div className={ui.skillRowActions} data-skill-block-group="">
        <span className={ui.skillPolicyGroup} role="group" aria-label={t('skills.row.toggles.aria', { name: skill.name })}>
          <HintTooltip label={t('skills.row.modelToggle.hint')}>
            <span className={ui.skillPolicyItem}>
              <Switch
                checked={modelInvocable}
                disabled={!writable}
                label={t('skills.row.modelToggle.aria', { name: skill.name })}
                onChange={() => {
                  if (skill.path !== undefined) props.onSetScope(skill.name, skill.path, scopeAfterToggle(skill, 'model'))
                }}
              />
              <span>{t('skills.row.modelToggle')}</span>
            </span>
          </HintTooltip>
          <HintTooltip label={t('skills.row.userToggle.hint')}>
            <span className={ui.skillPolicyItem}>
              <Switch
                checked={userInvocable}
                disabled={!writable}
                label={t('skills.row.userToggle.aria', { name: skill.name })}
                onChange={() => {
                  if (skill.path !== undefined) props.onSetScope(skill.name, skill.path, scopeAfterToggle(skill, 'user'))
                }}
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
