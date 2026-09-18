import { memo, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconChevronDownOutline14, Menu, Switch, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PromptToolTranslate } from '../../locales.ts'
import type { EngineMeta, PromptConfigDraft } from '../../prompt-tool-types.ts'
import type { InstructionPolicyFileOverride } from '../../../shared/instructions.ts'
import type { FieldDraft } from '../../data/workspace-drafts.ts'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx'
import { StatusBadge } from '../../ui/StatusBadge.tsx'
import { useMenuFocus } from '../../ui/menu-focus.ts'
import { PromptConfigForm } from './PromptConfigForm.tsx'
import { instructionFileIdOf } from '../../data/prompt-config-content.ts'
import { AUDIENCE_LABEL_KEYS, LAYER_LABEL_KEYS, POSITION_LABEL_KEYS, STRATEGY_LABEL_KEYS, fieldPolicyFor, translateLabel } from './prompt-config-policy.ts'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './prompts.module.css'

const styles = { ...sharedCss, ...featureCss }
export type { PromptConfigDraft, LayerFieldPolicy } from '../../prompt-tool-types.ts'

/** 卡片拥有正文及其 portal 的逻辑焦点边界，真正离开时才提交指令正文。 */
export const PromptConfigCard = memo(function PromptConfigCard(props: {
  t: PromptToolTranslate
  meta: EngineMeta
  config: PromptConfigDraft
  expanded: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  disabled?: boolean
  readOnlyReason?: string
  fieldDrafts?: Map<string, FieldDraft>
  draftScope?: string
  dragging?: boolean
  dropBefore?: boolean
  dropAfter?: boolean
  onToggleExpanded: (id: string) => void
  onToggleEnabled: (id: string, enabled: boolean) => void
  onPatch: (id: string, patch: Partial<PromptConfigDraft>) => void
  onMoveUp: (id: string) => void
  onMoveDown: (id: string) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void | Promise<void>
  onSaveInstructionFile?: (fileId: string) => void
  onReloadInstructionFile?: (fileId: string) => void | Promise<void>
  onPatchInstructionPolicy?: (fileId: string, override: InstructionPolicyFileOverride) => void
  onDragStart?: (id: string, event: React.DragEvent<HTMLElement>) => void
  onDragOver?: (id: string, event: React.DragEvent<HTMLElement>) => void
  onDrop?: (id: string, event: React.DragEvent<HTMLElement>) => void
  onDragEnd?: () => void
}): ReactNode {
  const { t, meta, config } = props
  const [confirmation, setConfirmation] = useState<'delete' | 'reload'>()
  const [menuOpen, setMenuOpen] = useState(false)
  const firstItemRef = useMenuFocus(menuOpen)
  useEffect(() => { setMenuOpen(false); setConfirmation(undefined) }, [props.draftScope, config.id])
  const cardRef = useRef<HTMLElement>(null)
  const actionRef = useRef<HTMLSpanElement>(null)
  const reloadRef = useRef<HTMLSpanElement>(null)
  const ownsFocus = useRef(false)
  const panelId = useId()
  const enabled = config.enabled !== false
  const name = config.name || config.id
  const instructionFileId = instructionFileIdOf(config)
  const fileNotWritable = config.contentStatus !== undefined && config.contentStatus !== 'ready'
  const focusAction = (): void => { actionRef.current?.querySelector('button')?.focus() }
  const policy = fieldPolicyFor(meta, config.layer)
  const strategy = config.strategy === 'instruction-hint' ? 'placeholder' : config.strategy ?? 'static'
  const chips = [translateLabel(t, LAYER_LABEL_KEYS, config.layer ?? 'pre-step'), translateLabel(t, STRATEGY_LABEL_KEYS, strategy)]
  if (policy.position) chips.push(t('card.chip.position', { value: translateLabel(t, POSITION_LABEL_KEYS, config.position ?? 'after-user') }))
  if (config.audience && config.audience !== 'all') chips.push(t('card.chip.audience', { value: translateLabel(t, AUDIENCE_LABEL_KEYS, config.audience) }))
  const status = config.contentConflict === true ? t('card.chip.fileConflict')
    : fileNotWritable ? (config.contentStatus === 'missing' ? t('card.fileMissing') : config.contentStatus === 'too-large' ? t('card.fileTooLarge') : t('card.chip.fileUnavailable'))
      : config.contentSaving === true ? t('card.chip.fileSaving') : config.contentDirty === true ? t('card.chip.fileDirty') : undefined
  const menuItems: MenuEntry[] = [
    { id: 'up', label: t('card.moveUp'), disabled: props.disabled || !props.canMoveUp },
    { id: 'down', label: t('card.moveDown'), disabled: props.disabled || !props.canMoveDown },
    ...(instructionFileId === undefined ? [
      { id: 'duplicate', label: t('card.duplicate'), disabled: props.disabled },
      { id: 'delete', label: <span className={styles.configFieldError}>{t('card.delete')}</span>, danger: true, disabled: props.disabled },
    ] : []),
  ]
  const firstItem = menuItems.find((item) => !('type' in item) && !item.disabled)
  if (firstItem && !('type' in firstItem)) firstItem.label = <span ref={firstItemRef}>{firstItem.label}</span>
  const reload = (): void => {
    if (instructionFileId === undefined) return
    if (config.contentDirty) setConfirmation('reload')
    else void props.onReloadInstructionFile?.(instructionFileId)
  }
  return <article ref={cardRef} className={clsx(styles.configCard, props.expanded && styles.configCardOpen)}
    data-config-id={config.id} data-dragging={props.dragging ? '' : undefined}
    data-drop-before={props.dropBefore ? '' : undefined} data-drop-after={props.dropAfter ? '' : undefined}
    onFocus={() => { ownsFocus.current = true }}
    onBlur={() => {
      ownsFocus.current = false
      requestAnimationFrame(() => {
        if (!ownsFocus.current) setMenuOpen(false)
        if (!ownsFocus.current && instructionFileId !== undefined && config.contentDirty === true
          && config.contentSaving !== true && config.contentConflict !== true && !fileNotWritable && !props.disabled && confirmation === undefined) {
          props.onSaveInstructionFile?.(instructionFileId)
        }
      })
    }}
    onDragOver={props.onDragOver === undefined ? undefined : (event) => props.onDragOver!(config.id, event)}
    onDrop={props.onDrop === undefined ? undefined : (event) => props.onDrop!(config.id, event)} onDragEnd={props.onDragEnd}>
    <span className={styles.visuallyHidden} role="status" aria-atomic="true">{status && !fileNotWritable && !config.contentConflict ? `${name}：${status}` : ''}</span>
    <header className={styles.configHeader}>
      {props.onDragStart !== undefined && <HintTooltip label={t('card.dragHint')}>
        <span className={styles.dragHandle} aria-hidden="true" draggable onDragStart={(event) => props.onDragStart!(config.id, event)}>⠿</span>
      </HintTooltip>}
      <button type="button" className={styles.configToggle} aria-expanded={props.expanded} aria-controls={panelId} onClick={() => props.onToggleExpanded(config.id)}>
        <span className={styles.configTitle}>
          <span className={styles.configTitleRow}><span className={styles.configName}>{name}</span></span>
          <span className={styles.configMeta}>{chips.join(' · ')}</span>
        </span>
        <IconChevronDownOutline14 className={clsx(styles.chevron, props.expanded && styles.chevronOpen)} />
      </button>
      {status && <StatusBadge tone={config.contentConflict ? 'warning' : fileNotWritable ? 'danger' : 'neutral'} label={status} />}
      <span className={styles.configHeaderActions}>
        <Switch className={styles.configEnable} checked={enabled} label={t('card.enableAria', { name })} disabled={props.disabled || (instructionFileId !== undefined && config.contentSaving === true)}
          onChange={(next) => {
            if (instructionFileId !== undefined) props.onPatchInstructionPolicy?.(instructionFileId, { enabled: next })
            else props.onToggleEnabled(config.id, next)
          }} />
        <span ref={actionRef} tabIndex={-1} onKeyDown={(event) => {
          if (!menuOpen || (event.key !== 'Escape' && event.key !== 'Tab')) return
          event.stopPropagation()
          if (event.key === 'Escape') event.preventDefault()
          focusAction()
          setMenuOpen(false)
        }}>
          <Menu open={menuOpen} portal autoFocus compact align="end" items={menuItems} onClose={() => setMenuOpen(false)}
            onSelect={(action) => {
              setMenuOpen(false)
              focusAction()
              if (action === 'delete') setConfirmation('delete')
              else if (action === 'up') props.onMoveUp(config.id)
              else if (action === 'down') props.onMoveDown(config.id)
              else if (action === 'duplicate') props.onDuplicate(config.id)
            }}
            anchor={<Button size="sm" variant="ghost" aria-label={t('card.actionsAria', { name })} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>⋯</Button>} />
        </span>
      </span>
    </header>
    {(config.contentConflict || fileNotWritable || config.contentMessage || props.readOnlyReason) && <div className={styles.configStatus}>
      {config.contentConflict && <p>{t('card.fileConflictDetail')}</p>}
      {config.contentDirty && (config.contentConflict || fileNotWritable) && <p>{t('card.chip.fileDirty')}</p>}
      {config.contentMessage && <p>{t('card.fileStatusDetail', { message: config.contentMessage })}</p>}
      {props.readOnlyReason && <p>{props.readOnlyReason}</p>}
      {instructionFileId !== undefined && (config.contentConflict || fileNotWritable) && <span ref={reloadRef} tabIndex={-1}>
        <Button size="sm" variant="outline" disabled={config.contentSaving} onClick={reload}>{t('card.reloadFile')}</Button>
      </span>}
    </div>}
    <div id={panelId} hidden={!props.expanded}>
      {props.expanded && <>
        <p className={styles.configFullName}>{config.id}{config.name && config.name !== config.id ? ` · ${config.name}` : ''}</p>
        <PromptConfigForm t={t} meta={meta} config={config} disabled={props.disabled} fieldDrafts={props.fieldDrafts} draftScope={`${props.draftScope}:${config.id}`}
          onPatch={(patch) => props.onPatch(config.id, patch)}
          {...(instructionFileId === undefined ? {} : { onPatchPolicy: (patch: InstructionPolicyFileOverride) => props.onPatchInstructionPolicy?.(instructionFileId, patch) })} />
      </>}
    </div>
    {confirmation && <ConfirmDialog title={t(confirmation === 'delete' ? 'card.deleteTitle' : 'card.reloadTitle', { name })}
      description={t(confirmation === 'delete' ? 'card.deleteDescription' : 'card.reloadDescription', { name })}
      confirmLabel={t(confirmation === 'delete' ? 'card.confirmDelete' : 'card.reloadFile')} cancelLabel={t('card.cancel')}
      failureMessage={t('card.operationFailed')} returnFocusRef={confirmation === 'delete' ? actionRef : reloadRef}
      onCancel={() => { setConfirmation(undefined); if (confirmation === 'delete') focusAction(); else reloadRef.current?.querySelector('button')?.focus() }}
      onConfirm={() => confirmation === 'delete' ? props.onDelete(config.id) : props.onReloadInstructionFile?.(instructionFileId!)} />}
  </article>
})
