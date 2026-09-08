import { cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEventHandler, type MouseEventHandler, type MutableRefObject, type ReactElement, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'
import css from './HintTooltip.module.css'
import { fitHintTooltipPosition, type HintTooltipPosition } from './hint-tooltip-position.ts'

interface HintAnchorProps {
  ref?: Ref<HTMLElement>
  onMouseEnter?: MouseEventHandler
  onMouseMove?: MouseEventHandler
  onMouseLeave?: MouseEventHandler
  onFocus?: FocusEventHandler
  onBlur?: FocusEventHandler
  'aria-describedby'?: string
}

/** 统一说明浮窗：只复用宿主视觉 token；定位走 body portal，悬停跟随指针，聚焦跟随控件。 */
export function HintTooltip(props: { label: string; children: ReactElement<HintAnchorProps> }): ReactNode {
  const id = useId()
  const anchor = useRef<HTMLElement | null>(null)
  const bubble = useRef<HTMLSpanElement | null>(null)
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointer = useRef({ x: 0, y: 0 })
  const triggers = useRef({ hover: false, focus: false })
  const [position, setPosition] = useState<HintTooltipPosition | null>(null)
  const childRef = (props.children as ReactElement<HintAnchorProps> & { ref?: Ref<HTMLElement> }).ref
  const mergedRef = useCallback((element: HTMLElement | null) => {
    anchor.current = element
    if (typeof childRef === 'function') childRef(element)
    else if (childRef != null) (childRef as MutableRefObject<HTMLElement | null>).current = element
  }, [childRef])
  const cancelShow = useCallback(() => {
    if (showTimer.current === null) return
    clearTimeout(showTimer.current)
    showTimer.current = null
  }, [])
  const showAtFocus = useCallback(() => {
    const rect = anchor.current?.getBoundingClientRect()
    if (rect === undefined) return
    setPosition({ kind: 'focus', left: rect.left, right: rect.right, centerY: rect.top + rect.height / 2 })
  }, [])
  const hideAfterBlur = useCallback(() => {
    cancelShow()
    setPosition(triggers.current.hover ? { kind: 'pointer', ...pointer.current } : null)
  }, [cancelShow])

  useEffect(() => cancelShow, [cancelShow])
  useEffect(() => {
    if (position?.kind !== 'focus') return
    const update = () => showAtFocus()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [position?.kind, showAtFocus])

  useLayoutEffect(() => {
    if (position === null || bubble.current === null) return
    const element = bubble.current
    const rect = element.getBoundingClientRect()
    const fitted = fitHintTooltipPosition(position, rect, { width: window.innerWidth, height: window.innerHeight })
    element.style.left = `${fitted.left}px`
    element.style.top = `${fitted.top}px`
  }, [position, props.label])

  const child = cloneElement(props.children, {
    ref: mergedRef,
    'aria-describedby': position === null
      ? props.children.props['aria-describedby']
      : [props.children.props['aria-describedby'], id].filter(Boolean).join(' '),
    onMouseEnter: (event) => {
      props.children.props.onMouseEnter?.(event)
      triggers.current.hover = true
      pointer.current = { x: event.clientX, y: event.clientY }
      if (triggers.current.focus) return
      cancelShow()
      showTimer.current = setTimeout(() => {
        showTimer.current = null
        setPosition({ kind: 'pointer', ...pointer.current })
      }, 500)
    },
    onMouseMove: (event) => {
      props.children.props.onMouseMove?.(event)
      pointer.current = { x: event.clientX, y: event.clientY }
      if (position?.kind === 'pointer') setPosition({ kind: 'pointer', ...pointer.current })
    },
    onMouseLeave: (event) => {
      props.children.props.onMouseLeave?.(event)
      triggers.current.hover = false
      cancelShow()
      if (!triggers.current.focus) setPosition(null)
    },
    onFocus: (event) => {
      props.children.props.onFocus?.(event)
      triggers.current.focus = true
      cancelShow()
      showAtFocus()
    },
    onBlur: (event) => {
      props.children.props.onBlur?.(event)
      triggers.current.focus = false
      hideAfterBlur()
    },
  })
  const tooltip = position !== null && typeof document !== 'undefined' && document.body !== null
    ? createPortal(<span ref={bubble} id={id} className={css.bubble} role="tooltip">{props.label}</span>, document.body)
    : null
  return <>{child}{tooltip}</>
}
