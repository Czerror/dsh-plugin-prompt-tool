import { useId, useRef, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button } from '../../ui/Button.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { IconChevronDownOutlineRegular, IconCloseFillRegular } from '../../ui/icons.tsx'
import ui from '../../ui/controls.module.css'
import css from './rules.module.css'

export interface StepCreation { active: string; select: (path: string) => void }

/** 同一规则只展开当前列表的创建控件，其他列表保留入口。 */
export function StepAdd(props: { creation: StepCreation; path: string; label: string; disabled?: boolean; children: ReactNode }): ReactNode {
  const panelId = useId(), open = props.creation.active === props.path
  return <div className={css.stepAdd}>
    <Button shape="pill" variant="outline" disabled={props.disabled} aria-expanded={open} aria-controls={panelId}
      onClick={() => props.creation.select(open ? '' : props.path)}>
      <IconChevronDownOutlineRegular className={clsx(ui.chevron, open && ui.chevronOpen)} />{props.label}
    </Button>
    <div id={panelId} hidden={!open}>{open && <div className={css.stepAdd} data-step-add>{props.children}</div>}</div>
  </div>
}

export function CloseButton(props: { label: string; disabled?: boolean; onClick: () => void }): ReactNode {
  return <HintTooltip label={props.label}>
    <button type="button" className={clsx(ui.tagChipRemove, css.stepClose)} aria-label={props.label} disabled={props.disabled} onClick={props.onClick}>
      <IconCloseFillRegular />
    </button>
  </HintTooltip>
}

/** 条件、分支和动作共用摘要、键盘焦点与展开区。 */
export function StepCard(props: {
  kind: string
  kindLabel: string
  summary: string
  hint?: string
  open: boolean
  onToggle: () => void
  actions?: ReactNode
  level: number
  children: ReactNode
}): ReactNode {
  const panelId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const toggle = (
    <button ref={toggleRef} type="button" className={css.stepToggle} aria-expanded={props.open} aria-controls={panelId}
      onClick={() => {
        if (props.open && bodyRef.current !== null && bodyRef.current.contains(document.activeElement)) toggleRef.current?.focus()
        props.onToggle()
      }}>
      <IconChevronDownOutlineRegular className={clsx(ui.chevron, props.open && ui.chevronOpen)} />
      <span className={css.stepKind}>{props.kindLabel}</span>
      <span className={css.stepSummary}>{props.summary}</span>
    </button>
  )
  return <section className={clsx(css.stepCard, props.open && css.stepCardOpen)} data-step={props.kind} data-open={props.open || undefined} data-level={props.level}>
    <div className={css.stepHead}>
      {props.hint === undefined ? toggle : <HintTooltip label={props.hint}>{toggle}</HintTooltip>}
      {props.actions !== undefined && <span className={css.stepActions}>{props.actions}</span>}
    </div>
    <div id={panelId} ref={bodyRef} hidden={!props.open} className={css.stepBody}>{props.open && props.children}</div>
  </section>
}
