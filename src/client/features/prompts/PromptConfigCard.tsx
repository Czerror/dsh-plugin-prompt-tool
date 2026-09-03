import { memo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { EngineMeta, PromptConfigDraft } from '../../prompt-tool-types.ts'
import { PromptConfigForm } from './PromptConfigForm.tsx'
import { fieldPolicyFor } from './prompt-config-policy.ts'
import styles from '../../PromptUi.module.css'

export type { PromptConfigDraft, LayerFieldPolicy } from '../../prompt-tool-types.ts'
/** 列表卡片（memo 化）：props 全部为数据或稳定回调——config 引用变化才重渲染该卡，
 *  129 卡列表编辑/拖拽 hover 时不再整列表级联渲染。 */
export const PromptConfigCard = memo(function PromptConfigCard(props: {
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
  onDragStart?: (id: string, event: React.DragEvent<HTMLElement>) => void
  onDragOver?: (id: string, event: React.DragEvent<HTMLElement>) => void
  onDrop?: (id: string, event: React.DragEvent<HTMLElement>) => void
  onDragEnd?: () => void
}): ReactNode {
  const { meta, config } = props
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const enabled = config.enabled !== false
  const policy = fieldPolicyFor(meta, config.layer)
  const chips = [config.layer ?? 'pre-step', config.strategy ?? 'static']
  if (config.fill) chips.push(config.fill)
  if (policy.position) chips.push(`pos=${config.position ?? 'after-user'}`)
  if (config.mergeMode === 'merged') chips.push('merged')
  if ((config.order ?? 0) !== 0) chips.push(`order=${config.order}`)
  if (config.group) chips.push(config.exclusive === true ? `exclusive:${config.group}` : `group:${config.group}`)
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
          <span
            className={styles.dragHandle}
            title="拖动调整顺序"
            aria-hidden="true"
            draggable
            onDragStart={(event) => props.onDragStart!(config.id, event)}
          >⠿</span>
        )}
        <button type="button" className={styles.configToggle} aria-expanded={props.expanded} onClick={() => props.onToggleExpanded(config.id)}>
          <span className={styles.configTitle}>
            <span className={styles.configTitleRow}>
              <span className={styles.configName}>{config.name && config.name !== config.id ? `${config.id} · ${config.name}` : config.id}</span>
              {config.layer === 'system-section' && config.params?.sectionName === 'deployment:persona' && (
                <span className={styles.configChip} title="deployment:persona 同名 shadow：主会话人设（子代理经 scope 链继承）">人设</span>
              )}
            </span>
            <span className={styles.configMeta}>{chips.join(' · ')}</span>
          </span>
          <IconChevronDownOutline14 className={clsx(styles.chevron, props.expanded && styles.chevronOpen)} />
        </button>
        <span className={styles.configHeaderActions}>
          <label className={styles.configEnable} title={enabled ? '点击关闭' : '点击启用'}>
            <input type="checkbox" checked={enabled} aria-label={`启用 ${config.name ?? config.id}`} onChange={(e) => props.onToggleEnabled(config.id, e.target.checked)} />
            <span className={styles.switch} aria-hidden="true"><i /></span>
          </label>
          <span className={styles.configActions}>
            <button type="button" className={styles.pillButton} disabled={!props.canMoveUp} onClick={() => props.onMoveUp(config.id)}>上移</button>
            <button type="button" className={styles.pillButton} disabled={!props.canMoveDown} onClick={() => props.onMoveDown(config.id)}>下移</button>
            <button type="button" className={styles.pillButton} onClick={() => props.onDuplicate(config.id)}>复制</button>
            {confirmingDelete ? (
              <>
                <button type="button" className={styles.pillButton} data-danger onClick={() => props.onDelete(config.id)}>确认删除</button>
                <button type="button" className={styles.pillButton} data-variant="secondary" onClick={() => setConfirmingDelete(false)}>取消</button>
              </>
            ) : (
              <button type="button" className={styles.pillButton} data-danger onClick={() => setConfirmingDelete(true)}>删除</button>
            )}
          </span>
        </span>
      </header>
      {props.expanded && <PromptConfigForm meta={meta} config={config} onPatch={(patch) => props.onPatch(config.id, patch)} />}
    </article>
  )
})
