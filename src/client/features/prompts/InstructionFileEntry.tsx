/**
 * 前置步骤层卡内的指令文件条目（AGENTS.md / CLAUDE.md 及其 .local 变体）。
 *
 * 文件正文与指令策略的所有权不变：正文只经显式保存写回原文件，行为字段写独立策略存储。
 * 这里只改变编辑入口——文件不再作为列表里的独立卡片，而是在前置步骤层卡的下拉里选择。
 */
import { useState, type ReactNode } from 'react'
import type { PromptToolTranslate } from '../../locales.ts'
import type { EngineMeta, PromptConfigDraft } from '../../prompt-tool-types.ts'
import type { InstructionPolicyFileOverride, InstructionPolicySnapshot } from '../../../shared/instructions.ts'
import { instructionFileIdOf } from '../../data/prompt-config-content.ts'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { ToggleRow } from '../../ui/ToggleRow.tsx'
import { PromptConfigForm } from './PromptConfigForm.tsx'
import styles from '../../ui/controls.module.css'

/** 独立指令文件来源总开关：原生位于前置步骤层卡，不再作为全层级常驻行。 */
export function InstructionSourceRow(props: {
  t: PromptToolTranslate
  policy: InstructionPolicySnapshot
  /** 任一文件卡仍由官方指令注入负责时，开关不接管负责人。 */
  ownerConflict?: boolean
  onToggle: (enabled: boolean) => Promise<boolean>
  onNotice: (kind: 'ok' | 'error', message: string) => void
}): ReactNode {
  const { t, policy } = props
  const [saving, setSaving] = useState(false)
  return (
    <ToggleRow
      id="prompt-tool-instruction-source"
      label={t('instructions.source.label')}
      checked={policy.policy.enabled}
      disabled={saving || policy.error !== undefined}
      hint={[
        policy.error !== undefined
          ? t('instructions.source.unavailable', { reason: policy.error })
          : t(policy.policy.enabled ? 'instructions.source.enabled' : 'instructions.source.disabled'),
        ...(props.ownerConflict === true ? [t('instructions.source.ownerConflict')] : []),
      ].join('；')}
      onChange={async (enabled) => {
        if (saving || policy.error !== undefined) return false
        setSaving(true)
        try {
          return await props.onToggle(enabled)
        } catch (error) {
          props.onNotice('error', t('configs.notice.saveFailed', { reason: error instanceof Error ? error.message : String(error) }))
          return false
        } finally {
          setSaving(false)
        }
      }}
    />
  )
}

/** 单条指令文件：正文编辑器 + 显式写盘/重新读取 + 独立策略字段。 */
export function InstructionFileEntry(props: {
  t: PromptToolTranslate
  meta: EngineMeta
  card: PromptConfigDraft
  onPatch: (patch: Partial<PromptConfigDraft>) => void
  onPatchPolicy?: (fileId: string, patch: InstructionPolicyFileOverride) => void
  onSave?: (fileId: string) => void
  onReload?: (fileId: string) => void
}): ReactNode {
  const { t, card } = props
  const fileId = instructionFileIdOf(card)
  const notWritable = card.contentStatus !== undefined && card.contentStatus !== 'ready'
  const saveDisabled = fileId === undefined || notWritable || card.contentConflict === true
    || card.contentDirty !== true || card.contentSaving === true
  const enabled = card.enabled !== false
  const status = card.contentMessage ?? (card.contentConflict === true ? t('card.chip.fileConflict') : undefined)
  return (
    <>
      {status !== undefined && <p className={styles.configFieldHint}>{t('card.fileStatusDetail', { message: status })}</p>}
      <div className={styles.configActions}>
        <HintTooltip label={enabled ? t('card.disableHint') : t('card.enableHint')}>
          <label className={styles.configEnable}>
            <input
              type="checkbox"
              checked={enabled}
              aria-label={t('card.enableAria', { name: card.name ?? card.id })}
              onChange={(event) => { if (fileId !== undefined) props.onPatchPolicy?.(fileId, { enabled: event.target.checked }) }}
            />
            <span className={styles.switch} aria-hidden="true"><i /></span>
          </label>
        </HintTooltip>
        <button type="button" className={styles.pillButton} disabled={saveDisabled}
          onClick={() => { if (fileId !== undefined) props.onSave?.(fileId) }}>{t('card.saveFile')}</button>
        {(card.contentConflict === true || notWritable) && (
          <button type="button" className={styles.pillButton} data-variant="secondary"
            onClick={() => { if (fileId !== undefined) props.onReload?.(fileId) }}>{t('card.reloadFile')}</button>
        )}
      </div>
      <PromptConfigForm
        t={t}
        meta={props.meta}
        config={card}
        onPatch={props.onPatch}
        {...(fileId === undefined || props.onPatchPolicy === undefined
          ? {}
          : { onPatchPolicy: (patch: InstructionPolicyFileOverride) => props.onPatchPolicy?.(fileId, patch) })}
      />
    </>
  )
}
