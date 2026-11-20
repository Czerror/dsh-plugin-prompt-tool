import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import type { PromptToolTranslate } from '../locales.ts'
import { AutoSaveSelection } from './AutoSaveSelection.ts'
import { Button } from './Button.tsx'
import { IconCloseFillRegular, IconSearchOutlineRegular } from './icons.tsx'
import type { MenuSelectOption, MenuSelectProps } from './MenuSelect.tsx'
import { SearchInput } from './SearchInput.tsx'
import css from './CanvasChoice.module.css'

export function CanvasChoiceDialog({ t, id, title, query, onQueryChange, onAccept, onClose, children }: {
  t: PromptToolTranslate
  id?: string
  title: string
  query: string
  onQueryChange: (query: string) => void
  onAccept?: () => void
  onClose: () => void
  children: ReactNode
}): ReactNode {
  const titleId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const pressedOutside = useRef(false)

  useLayoutEffect(() => {
    const node = dialog.current
    node?.showModal()
    search.current?.focus({ preventScroll: true })
    return () => { node?.close() }
  }, [])

  const outside = (node: HTMLDialogElement, x: number, y: number): boolean => {
    const rect = node.getBoundingClientRect()
    return x < rect.left || x > rect.right || y < rect.top || y > rect.bottom
  }
  return <dialog ref={dialog} id={id} className={css.dialog} aria-labelledby={titleId} {...{ closedby: 'any' }}
    onClose={event => { event.stopPropagation(); if (!event.currentTarget.open) onClose() }}
    onCancel={event => {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }}
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
      event.stopPropagation()
      // Chromium 的搜索框会先清空查询，阻止对话框收到默认的关闭请求。
      if (event.target === search.current && search.current.value) {
        event.preventDefault()
        onClose()
      }
    }}
    onPointerDown={event => {
      if (!('closedBy' in HTMLDialogElement.prototype)) {
        pressedOutside.current = event.button === 0 && outside(event.currentTarget, event.clientX, event.clientY)
      }
    }} onPointerCancel={() => { pressedOutside.current = false }} onPointerUp={event => {
      if (pressedOutside.current && outside(event.currentTarget, event.clientX, event.clientY)) onClose()
      pressedOutside.current = false
    }}>
    <header className={css.heading}>
      <h2 id={titleId}>{title}</h2>
      <Button icon aria-label={t('choice.close')} onClick={onClose}><IconCloseFillRegular /></Button>
    </header>
    <SearchInput ref={search} aria-label={t('choice.search')} placeholder={t('choice.search')} value={query}
      onChange={event => onQueryChange(event.currentTarget.value)} onKeyDown={event => {
        if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
        event.preventDefault()
        onAccept?.()
      }} />
    <div className={css.list}>{children}</div>
  </dialog>
}

function ChoiceDialog({ props, t, id, choose, close }: {
  props: MenuSelectProps; t: PromptToolTranslate; id: string; choose: (value: string) => void; close: () => void
}): ReactNode {
  const [query, setQuery] = useState('')
  const index = useMemo(() => props.options.map(option => ({
    option,
    keyword: `${option.label} ${option.value} ${option.group ?? ''}`.toLowerCase(),
  })), [props.options])
  const needle = query.trim().toLowerCase()
  const matched = needle ? index.filter(entry => entry.keyword.includes(needle)) : index
  const groups: Array<{ name: string | undefined; options: MenuSelectOption[] }> = []
  for (const { option } of matched) {
    const last = groups.at(-1)
    if (last && last.name === option.group) last.options.push(option)
    else groups.push({ name: option.group, options: [option] })
  }
  useEffect(() => { if (props.disabled) close() }, [close, props.disabled])

  const select = (option: MenuSelectOption): void => {
    if (props.disabled || option.disabled) return
    close()
    choose(option.value)
  }

  return <CanvasChoiceDialog t={t} id={id} title={props.ariaLabel} query={query} onQueryChange={setQuery} onClose={close}
    onAccept={() => { if (matched.length === 1) select(matched[0]!.option) }}>
      {groups.length === 0 && <p role="status">{t('choice.noMatch')}</p>}
      {groups.map(({ name, options }, position) => <section key={position} className={css.group}
        aria-labelledby={name ? `${id}-group-${position}` : undefined}>
        {name && <h3 id={`${id}-group-${position}`}>{name}</h3>}
        {options.map(option => <Button key={option.value} className={css.option} aria-pressed={props.value === option.value}
          disabled={props.disabled || option.disabled} onClick={() => select(option)}>{option.label}</Button>)}
      </section>)}
  </CanvasChoiceDialog>
}

export function CanvasChoice({ t, ...props }: MenuSelectProps & { t: PromptToolTranslate }): ReactNode {
  const id = useId()
  const [open, setOpen] = useState(false)
  const commit = useContext(AutoSaveSelection)
  const selected = props.options.find(option => option.value === props.value)
  const display = selected?.label ?? (props.value || props.placeholder || t('choice.empty'))
  const choose = (value: string): void => {
    if (props.disabled || value === props.value) return
    props.onChange(value)
    if (commit) queueMicrotask(commit)
  }
  const attrs = {
    id: props.id, 'aria-label': props.ariaLabel,
    'aria-labelledby': props['aria-labelledby'], 'aria-invalid': props['aria-invalid'],
    'aria-describedby': props['aria-describedby'],
  }

  if (!open && !props.onOpen && props.options.length > 0 && props.options.length <= 4 && !props.options.some(option => option.group)) {
    return <div {...attrs} role="radiogroup" aria-disabled={props.disabled} className={clsx(css.radios, props.className)}
      aria-describedby={selected ? attrs['aria-describedby'] : [attrs['aria-describedby'], `${id}-unknown`].filter(Boolean).join(' ')}>
      {!selected && <span id={`${id}-unknown`} className={css.unknown}>{display}</span>}
      {props.options.map(option => <label key={option.value} className={css.radio}>
        <input type="radio" name={id} value={option.value} checked={props.value === option.value}
          disabled={props.disabled || option.disabled} onChange={() => choose(option.value)} />
        <span>{option.label}</span>
      </label>)}
    </div>
  }

  return <>
    <Button {...attrs} variant="outline" size={props.compact ? 'sm' : 'md'} className={clsx(css.trigger, props.className)}
      disabled={props.disabled} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={event => {
        event.currentTarget.focus({ preventScroll: true })
        props.onOpen?.()
        setOpen(true)
      }}>
      <span>{display}</span><IconSearchOutlineRegular aria-hidden="true" />
    </Button>
    {open && <ChoiceDialog props={props} t={t} id={id} choose={choose} close={() => setOpen(false)} />}
  </>
}
