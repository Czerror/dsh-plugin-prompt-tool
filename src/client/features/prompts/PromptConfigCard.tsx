import { memo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PromptToolTranslate } from '../../locales.ts'
import type { EngineMeta, PromptConfigDraft } from '../../prompt-tool-types.ts'
import type { InstructionPolicyFileOverride } from '../../../shared/instructions.ts'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { PromptConfigForm } from './PromptConfigForm.tsx'
import { instructionFileIdOf } from '../../data/prompt-config-content.ts'
import { FILL_LABEL_KEYS, LAYER_LABEL_KEYS, POSITION_LABEL_KEYS, STRATEGY_LABEL_KEYS, fieldPolicyFor, translateLabel } from './prompt-config-policy.ts'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './prompts.module.css'

const styles = { ...sharedCss, ...featureCss }

export type { PromptConfigDraft, LayerFieldPolicy } from '../../prompt-tool-types.ts'
/** 列表卡片（memo 化）：props 全部为数据或稳定回调——config 引用变化才重渲染该卡，
 *  129 卡列表编辑/拖拽 hover 时不再整列表级联渲染。 */
export const PromptConfigCard = memo(function PromptConfigCard(props: {
  t: PromptToolTranslate
  meta: EngineMeta
  config: PromptConfigDraft
  expanded: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  dragging?: boolean
  dropBefore?: boolean
  dropAfter?: boolean
  onToggleExpanded: (id: string) => void
  onToggleEnabled: (id: string, enabled: boolean) => void
  onPatch: (id: string, patch: Partial<PromptConfigDraft>) => void
  onMoveUp: (id: string) => void
  onMoveDown: (id: string) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  /** 指令文件卡的显式写盘（不经预设保存路径）。 */
  onSaveInstructionFile?: (fileId: string) => void
  /** 指令文件卡的重新读取（冲突/不可读时丢弃本地草稿，采纳磁盘版本）。 */
  onReloadInstructionFile?: (fileId: string) => void
  /** 指令文件卡的行为策略改动（独立策略存储；null 字段不提交）。 */
  onPatchInstructionPolicy?: (fileId: string, override: InstructionPolicyFileOverride) => void
  onDragStart?: (id: string, event: React.DragEvent<HTMLElement>) => void
  onDragOver?: (id: string, event: React.DragEvent<HTMLElement>) => void
  onDrop?: (id: string, event: React.DragEvent<HTMLElement>) => void
  onDragEnd?: () => void
}): ReactNode {
  const { t, meta, config } = props
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const enabled = config.enabled !== false
  const instructionFileId = instructionFileIdOf(config)
  const fileNotWritable = config.contentStatus !== undefined && config.contentStatus !== 'ready'
  const policy = fieldPolicyFor(meta, config.layer)
  const layer = config.layer ?? 'pre-step'
  const strategy = config.strategy ?? 'static'
  const chips = [translateLabel(t, LAYER_LABEL_KEYS, layer), translateLabel(t, STRATEGY_LABEL_KEYS, strategy)]
  if (config.fill) chips.push(translateLabel(t, FILL_LABEL_KEYS, config.fill))
  if (policy.position) {
    const position = config.position ?? 'after-user'
    chips.push(t('card.chip.position', { value: translateLabel(t, POSITION_LABEL_KEYS, position) }))
  }
  if (config.mergeMode === 'merged') chips.push(t('card.chip.merged'))
  if ((config.order ?? 0) !== 0) chips.push(t('card.chip.order', { order: config.order ?? 0 }))
  if (config.group) chips.push(t(config.exclusive === true ? 'card.chip.exclusiveGroup' : 'card.chip.group', { name: config.group }))
  // 指令文件卡：读取状态与未保存/冲突必须常驻可见，不用空 textarea 掩盖读取失败。
  if (config.contentStatus !== undefined && config.contentStatus !== 'ready') chips.push(t('card.chip.fileUnavailable'))
  if (config.contentConflict === true) chips.push(t('card.chip.fileConflict'))
  else if (config.contentDirty === true) chips.push(t(config.contentSaving === true ? 'card.chip.fileSaving' : 'card.chip.fileDirty'))
  return (
    <article
      className={clsx(styles.configCard, props.expanded && styles.configCardOpen)}
      data-dragging={props.dragging ? '' : undefined}
      data-drop-before={props.dropBefore ? '' : undefined}
      data-drop-after={props.dropAfter ? '' : undefined}
      onDragOver={props.onDragOver === undefined ? undefined : (event) => props.onDragOver!(config.id, event)}
      onDrop={props.onDrop === undefined ? undefined : (event) => props.onDrop!(config.id, event)}
      onDragEnd={props.onDragEnd}
    >
      <header className={styles.configHeader}>
        {props.onDragStart !== undefined && (
          <HintTooltip label={t('card.dragHint')}>
            <span
              className={styles.dragHandle}
              aria-hidden="true"
              draggable
              onDragStart={(event) => props.onDragStart!(config.id, event)}
            >⠿</span>
          </HintTooltip>
        )}
        <button type="button" className={styles.configToggle} aria-expanded={props.expanded} onClick={() => props.onToggleExpanded(config.id)}>
          <span className={styles.configTitle}>
            <span className={styles.configTitleRow}>
              <span className={styles.configName}>{config.name && config.name !== config.id ? `${config.id} · ${config.name}` : config.id}</span>
            </span>
            <span className={styles.configMeta}>{chips.join(' · ')}</span>
          </span>
          <IconChevronDownOutline14 className={clsx(styles.chevron, props.expanded && styles.chevronOpen)} />
        </button>
        <span className={styles.configHeaderActions}>
          <HintTooltip label={enabled ? t('card.disableHint') : t('card.enableHint')}>
            <label className={styles.configEnable}>
              <input
                type="checkbox"
                checked={enabled}
                aria-label={t('card.enableAria', { name: config.name ?? config.id })}
                onChange={(e) => {
                  // 文件卡的启停属于独立策略：写 preset 卡字段会被静默丢弃。
                  if (instructionFileId !== undefined) props.onPatchInstructionPolicy?.(instructionFileId, { enabled: e.target.checked })
                  else props.onToggleEnabled(config.id, e.target.checked)
                }}
              />
              <span className={styles.switch} aria-hidden="true"><i /></span>
            </label>
          </HintTooltip>
          <span className={styles.configActions}>
            {instructionFileId !== undefined && (
              <>
                <button
                  type="button"
                  className={styles.pillButton}
                  disabled={fileNotWritable || config.contentConflict === true || config.contentDirty !== true || config.contentSaving === true}
                  onClick={() => props.onSaveInstructionFile?.(instructionFileId)}
                >{t('card.saveFile')}</button>
                {(config.contentConflict === true || fileNotWritable) && (
                  <button
                    type="button"
                    className={styles.pillButton}
                    data-variant="secondary"
                    onClick={() => props.onReloadInstructionFile?.(instructionFileId)}
                  >{t('card.reloadFile')}</button>
                )}
              </>
            )}
            <button type="button" className={styles.pillButton} disabled={!props.canMoveUp} onClick={() => props.onMoveUp(config.id)}>{t('card.moveUp')}</button>
            <button type="button" className={styles.pillButton} disabled={!props.canMoveDown} onClick={() => props.onMoveDown(config.id)}>{t('card.moveDown')}</button>
            <button type="button" className={styles.pillButton} onClick={() => props.onDuplicate(config.id)}>{t('card.duplicate')}</button>
            {confirmingDelete ? (
              <>
                <button type="button" className={styles.pillButton} data-danger onClick={() => props.onDelete(config.id)}>{t('card.confirmDelete')}</button>
                <button type="button" className={styles.pillButton} data-variant="secondary" onClick={() => setConfirmingDelete(false)}>{t('card.cancel')}</button>
              </>
            ) : (
              <button type="button" className={styles.pillButton} data-danger onClick={() => setConfirmingDelete(true)}>{t('card.delete')}</button>
            )}
          </span>
        </span>
      </header>
      {props.expanded && config.contentMessage !== undefined && (
        <p className={styles.configFieldHint}>{t('card.fileStatusDetail', { message: config.contentMessage })}</p>
      )}
      {props.expanded && (
        <PromptConfigForm
          t={t}
          meta={meta}
          config={config}
          onPatch={(patch) => props.onPatch(config.id, patch)}
          {...(instructionFileId === undefined
            ? {}
            : { onPatchPolicy: (patch: InstructionPolicyFileOverride) => props.onPatchInstructionPolicy?.(instructionFileId, patch) })}
        />
      )}
    </article>
  )
})
