/** 导入预览卡：展示服务端同源转换报告与顺序组选择；只有用户确认才提交写入。
 *  组件自身不发起转换、不持草稿以外的状态，文本全部来自 prompt-tool 字典。
 *  候选状态（多 prompt_order 组无法明确对应）只让用户选组后重新预览，确认保持禁用——
 *  候选从未宣称已转换，也没有可回传的写入凭据。 */
import { memo, type ReactNode } from 'react'
import type { PromptToolTranslate } from '../locales.ts'
import type { ImportOrderCandidates, ImportPreviewState } from '../prompt-tool-types.ts'
import { MenuSelect } from './MenuSelect.tsx'
import sharedCss from './controls.module.css'

export type { ImportPreviewState } from '../prompt-tool-types.ts'

export const ImportPreviewCard = memo(function ImportPreviewCard(props: {
  t: PromptToolTranslate
  preview?: ImportPreviewState
  candidates?: ImportOrderCandidates
  /** 提交进行中：确认与取消都禁用。 */
  busy: boolean
  /** 重新预览进行中：旧 ready 已失效，只有确认禁用（仍可继续换组）。 */
  confirmDisabled?: boolean
  hideActions?: boolean
  onGroupChange: (characterId: string) => void
  onConfirm: () => void
  onCancel: () => void
}): ReactNode {
  const { t, preview, candidates, busy } = props
  const candidateMode = candidates !== undefined
  const confirmDisabled = busy || props.confirmDisabled === true || candidateMode
  const report = preview?.report
  const groups = report?.orderGroups ?? []
  const warnings = report?.diagnostics.filter((item) => item.severity === 'warning') ?? []
  const infos = report?.diagnostics.filter((item) => item.severity === 'info') ?? []
  const excluded = report?.entries.filter((entry) => entry.classification === 'excluded') ?? []
  const selectedGroup = preview?.groupCharacterId ?? groups.find((group) => group.selected)?.characterId ?? groups[0]?.characterId ?? ''
  // 有损信息必须可查看：只要还存在降级/不支持/排除条目或 info 诊断，就不宣称"无需检查"。
  const lossy = (report?.summary.degraded ?? 0) + (report?.summary.unsupported ?? 0) + (report?.summary.excluded ?? 0)
  const hasFindings = warnings.length > 0 || infos.length > 0 || excluded.length > 0 || lossy > 0
  const groupOption = (id: string, entries: number): { value: string; label: string } =>
    ({ value: id, label: t('importPreview.groupOption', { id, entries }) })
  /** 一条诊断/条目的定位：来源身份与目标身份分字段展示，不只重复告警文字。 */
  const location = (source?: string, target?: string): ReactNode =>
    (source === undefined && target === undefined)
      ? null
      : (
        <small className={sharedCss.previewLocation}>
          {source === undefined ? null : t('importPreview.diagSource', { source })}
          {source !== undefined && target !== undefined ? ' · ' : null}
          {target === undefined ? null : t('importPreview.diagTarget', { target })}
        </small>
      )
  return (
    <div className={sharedCss.section}>
      <div className={sharedCss.sectionHeading}>
        <div>
          <h2>{t('importPreview.title')}</h2>
          {candidateMode
            ? <p>{t('importPreview.needsGroup', { source: candidates.sourceName ?? '' })}</p>
            : (
              <p>
                {report === undefined
                  ? null
                  : t('importPreview.summary', {
                    inputs: report.summary.inputs, converted: report.summary.converted, disabled: report.summary.disabled,
                    degraded: report.summary.degraded, unsupported: report.summary.unsupported, excluded: report.summary.excluded,
                  })}
              </p>
            )}
        </div>
      </div>
      {candidateMode && (
        <div>
          <span>{t('importPreview.groups')}</span>
          <MenuSelect
            value=""
            options={candidates.candidates.map((candidate) => groupOption(candidate.characterId, candidate.entries))}
            onChange={props.onGroupChange}
            ariaLabel={t('importPreview.groupsAria')}
            placeholder={t('importPreview.pickGroup')}
            disabled={busy}
          />
        </div>
      )}
      {!candidateMode && groups.length > 1 && (
        <div>
          <span>{t('importPreview.groups')}</span>
          <MenuSelect value={selectedGroup} options={groups.map((group) => groupOption(group.characterId, group.entries))}
            onChange={props.onGroupChange} ariaLabel={t('importPreview.groupsAria')} disabled={busy} />
        </div>
      )}
      {!candidateMode && report !== undefined && warnings.length > 0 && (
        <div className={sharedCss.previewGroup}>
          <p className={sharedCss.previewGroupTitle}>{t('importPreview.review', { count: warnings.length })}</p>
          {/* 服务端已给出有界数据：这里全部展示（长列表在容器内滚动），不再二次截断。 */}
          <ul className={sharedCss.previewList} data-preview-warnings tabIndex={0} aria-label={t('importPreview.reviewAria', { count: warnings.length })}>
            {warnings.map((item) => (
              <li className={sharedCss.previewItem} key={`${item.code}:${item.entryId ?? ''}`}>
                {item.message}
                {location(item.entryId, item.targetId)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!candidateMode && report !== undefined && infos.length > 0 && (
        <div className={sharedCss.previewGroup}>
          <p className={sharedCss.previewGroupTitle}>{t('importPreview.info', { count: infos.length })}</p>
          <ul className={sharedCss.previewList} data-preview-infos tabIndex={0} aria-label={t('importPreview.infoAria', { count: infos.length })}>
            {infos.map((item) => (
              <li className={sharedCss.previewItem} key={`${item.code}:${item.entryId ?? ''}`}>
                {item.message}
                {location(item.entryId, item.targetId)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!candidateMode && report !== undefined && excluded.length > 0 && (
        <div className={sharedCss.previewGroup}>
          <p className={sharedCss.previewGroupTitle}>{t('importPreview.excluded', { count: excluded.length })}</p>
          <ul className={sharedCss.previewList} data-preview-excluded tabIndex={0} aria-label={t('importPreview.excludedAria', { count: excluded.length })}>
            {excluded.map((entry, index) => (
              <li className={sharedCss.previewItem} key={`${entry.sourceId}:${index}`}>
                {t('importPreview.excludedItem', { source: entry.sourceId, codes: entry.codes.join(', ') })}
                {location(entry.sourceName)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!candidateMode && report !== undefined && !hasFindings && <p>{t('importPreview.none')}</p>}
      {!candidateMode && report?.truncated === true && (
        <p>
          {t('importPreview.truncated', {
            entries: report.entries.length,
            diagnostics: report.diagnostics.length,
            inputs: report.summary.inputs,
          })}
        </p>
      )}
      {!props.hideActions && <div>
        <button type="button" className={sharedCss.primaryPill} disabled={confirmDisabled} onClick={props.onConfirm}>
          {t('importPreview.confirm')}
        </button>
        <button type="button" className={sharedCss.pillButton} disabled={busy} onClick={props.onCancel}>
          {t('importPreview.cancel')}
        </button>
      </div>}
    </div>
  )
})
