import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutlineRegular, IconTrashOutlineRegular, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { HintTooltip } from './HintTooltip.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import styles from './controls.module.css'
/** 引擎模块可折叠卡片：与模块列表（PromptConfigList）同款形态——
 *  configCard + configToggle + chevron，点击展开 configForm 编辑组合行 config
 *  （经 params 参数桥扁平键落 preset.yml）。归类于配置列表下（beforeCards）。
 *  layer：卡片主归属的官方注入层（九层之一，归属来自 ENGINE_CAPABILITIES /
 *  ENGINE_EDITOR_GROUPS 共享契约），由统一模块列表按插入点组织展示；不参与运行时 hook 排序。 */
export function EngineModuleCard(props: {
  name: string
  meta: string
  layer?: string
  children?: ReactNode
  onDelete?: () => void | Promise<void>
  deleteLabels?: { title: string; description: string; confirm: string; cancel: string; failure: string }
  readOnlyReason?: string
  expanded?: boolean
  defaultExpanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  /** 创建或选择另一个行为时展开；不因普通字段编辑反复展开。 */
  revealKey?: string
  /** 稳定定位锚点（能力 id）：创建后滚动定位用，与展开状态无关。 */
  anchorId?: string
  /** 纯开关卡：开关直接渲染在 header 顶层（右侧），卡片不展开、不折叠。 */
  topSwitch?: {
    id: string
    label: string
    hint: string
    checked: boolean
    disabled?: boolean
    onToggle: () => void
  }
}): ReactNode {
  const [localExpanded, setLocalExpanded] = useState(props.defaultExpanded ?? props.revealKey !== undefined)
  const expanded = props.expanded ?? localExpanded
  const setExpanded = (next: boolean): void => { setLocalExpanded(next); props.onExpandedChange?.(next) }
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const deleteRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  useEffect(() => {
    if (props.revealKey !== undefined) setExpanded(true)
    setConfirmingDelete(false)
  }, [props.revealKey])
  const compact = props.topSwitch !== undefined
  const title = <span className={styles.configTitle}>
    <span className={styles.configTitleRow}>
      <span className={styles.configName}>{props.name}</span>
      {props.layer !== undefined && <span className={styles.configChip}>{props.layer}</span>}
    </span>
    <span className={styles.configMeta}>{props.meta}</span>
  </span>
  return (
    <article className={clsx(styles.configCard, styles.moduleCard, !compact && expanded && styles.configCardOpen)} data-module-card="true" data-module-card-id={props.anchorId}>
      <header className={styles.configHeader}>
        {compact ? <span className={styles.configToggle} data-static>{title}</span> :
          <button type="button" className={styles.configToggle} aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded(!expanded)}>
            {title}<IconChevronDownOutlineRegular className={clsx(styles.chevron, expanded && styles.chevronOpen)} />
          </button>}
        {(props.topSwitch !== undefined || props.onDelete !== undefined) && (
          <span className={styles.configHeaderActions}>
            {props.topSwitch !== undefined && <HintTooltip label={props.topSwitch.hint}>
              <span className={styles.configEnable}>
                <Switch
                  checked={props.topSwitch.checked}
                  disabled={props.topSwitch.disabled}
                  label={props.topSwitch.label}
                  onChange={props.topSwitch.onToggle}
                />
              </span>
            </HintTooltip>}
            {props.onDelete !== undefined && (
              <HintTooltip label={props.deleteLabels?.title ?? `删除 ${props.name}`}>
                <button ref={deleteRef} type="button" className={styles.pillButton} data-danger aria-label={props.deleteLabels?.title ?? `删除引擎能力 ${props.name}`}
                  onClick={() => setConfirmingDelete(true)}><IconTrashOutlineRegular /></button>
              </HintTooltip>
            )}
          </span>
        )}
      </header>
      {props.readOnlyReason && <p className={styles.configFieldHint}>{props.readOnlyReason}</p>}
      {!compact && <div id={panelId} hidden={!expanded} className={styles.configForm}>{expanded && <><p className={styles.configFullName}>{props.name}{props.anchorId && ` · ${props.anchorId}`}</p>{props.children}</>}</div>}
      {confirmingDelete && props.onDelete && <ConfirmDialog
        title={props.deleteLabels?.title ?? `删除 ${props.name}`} description={props.deleteLabels?.description ?? `从当前预设移除“${props.name}”能力。`}
        confirmLabel={props.deleteLabels?.confirm ?? '确认删除'} cancelLabel={props.deleteLabels?.cancel ?? '取消'}
        failureMessage={props.deleteLabels?.failure} returnFocusRef={deleteRef} onConfirm={props.onDelete} onCancel={() => setConfirmingDelete(false)} />}
    </article>
  )
}
