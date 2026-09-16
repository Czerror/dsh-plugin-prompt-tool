/** 导入预览卡：展示服务端同源转换报告与顺序组选择；只有用户确认才提交写入。
 *  组件自身不发起转换、不持草稿以外的状态，文本全部来自 prompt-tool 字典。 */
import { memo, type ReactNode } from 'react'
import type { StConversionReport } from '../../shared/bridge-contract.ts'
import type { PromptToolTranslate } from '../locales.ts'
import { MenuSelect } from './MenuSelect.tsx'
import sharedCss from './controls.module.css'

/** 预览态：文件内容与来源摘要在确认提交时原样回传（服务端重算摘要校验过期）。 */
export interface ImportPreviewState {
  files: Array<{ path: string; content: string }>
  sourceDigest: string
  report?: StConversionReport
  groupCharacterId?: string
}

export const ImportPreviewCard = memo(function ImportPreviewCard(props: {
  t: PromptToolTranslate
  preview: ImportPreviewState
  busy: boolean
  onGroupChange: (characterId: string) => void
  onConfirm: () => void
  onCancel: () => void
}): ReactNode {
  const { t, preview, busy } = props
  const report = preview.report
  const groups = report?.orderGroups ?? []
  const warnings = report?.diagnostics.filter((item) => item.severity === 'warning') ?? []
  const selectedGroup = preview.groupCharacterId ?? groups.find((group) => group.selected)?.characterId ?? groups[0]?.characterId ?? ''
  return (
    <div className={sharedCss.section}>
      <div className={sharedCss.sectionHeading}>
        <div>
          <h2>{t('importPreview.title')}</h2>
          <p>
            {report === undefined
              ? t('importPreview.noReport')
              : t('importPreview.summary', {
                inputs: report.summary.inputs, converted: report.summary.converted, disabled: report.summary.disabled,
                degraded: report.summary.degraded, unsupported: report.summary.unsupported, excluded: report.summary.excluded,
              })}
          </p>
        </div>
      </div>
      {report !== undefined && warnings.length > 0 && (
        <>
          <p>{t('importPreview.review', { count: warnings.length })}</p>
          <ul>
            {warnings.slice(0, 20).map((item) => (
              <li key={`${item.code}:${item.entryId ?? ''}`}>{item.message}</li>
            ))}
          </ul>
        </>
      )}
      {report !== undefined && warnings.length === 0 && <p>{t('importPreview.none')}</p>}
      {report?.truncated === true && <p>{t('importPreview.truncated')}</p>}
      {groups.length > 1 && (
        <div>
          <span>{t('importPreview.groups')}</span>
          <MenuSelect
            value={selectedGroup}
            options={groups.map((group) => ({
              value: group.characterId,
              label: t('importPreview.groupOption', { id: group.characterId, entries: group.entries }),
            }))}
            onChange={props.onGroupChange}
            ariaLabel={t('importPreview.groupsAria')}
            disabled={busy}
          />
        </div>
      )}
      <div>
        <button type="button" className={sharedCss.primaryPill} disabled={busy} onClick={props.onConfirm}>
          {t('importPreview.confirm')}
        </button>
        <button type="button" className={sharedCss.pillButton} disabled={busy} onClick={props.onCancel}>
          {t('importPreview.cancel')}
        </button>
      </div>
    </div>
  )
})
