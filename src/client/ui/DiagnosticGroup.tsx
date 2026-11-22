import { useId, useState, type ReactNode, type Ref } from 'react'
import { IconChevronDownOutlineRegular } from './icons.tsx'
import css from './diagnostics.module.css'

/** Render records on expansion. The rule navigator also opens specific ancestors on return. */
export function DiagnosticGroup(props: {
  label: string
  meta?: ReactNode
  children: () => ReactNode
  open?: boolean
  onToggle?: () => void
  triggerRef?: Ref<HTMLButtonElement>
  level?: 'section' | 'group' | 'record'
}) {
  const [localOpen, setLocalOpen] = useState(false)
  const open = props.open ?? localOpen
  const id = useId()
  return <div className={css.fold} data-level={props.level ?? 'section'}>
    <button type="button" ref={props.triggerRef} className={css.summary} aria-expanded={open}
      aria-controls={open ? id : undefined} onClick={props.onToggle ?? (() => setLocalOpen(!open))}>
      <IconChevronDownOutlineRegular /><span className={css.label} title={props.label}>{props.label}</span>
      {props.meta !== undefined && <span className={css.meta}>{props.meta}</span>}
    </button>
    {open && <div id={id} className={css.content}>{props.children()}</div>}
  </div>
}
