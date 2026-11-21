import { useId, type ReactNode } from 'react'
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
