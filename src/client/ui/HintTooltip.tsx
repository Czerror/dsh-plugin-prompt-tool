import { cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEventHandler, type MouseEventHandler, type MutableRefObject, type PointerEventHandler, type ReactElement, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'
import css from './HintTooltip.module.css'
import { fitHintTooltipPosition, type HintTooltipPosition } from './hint-tooltip-position.ts'
import { shouldLockFocus } from './hint-tooltip-focus.ts'

/** 悬停延迟：与 pointer 模式保持一致，失焦回到悬停时复用同一节奏。 */
const HOVER_DELAY_MS = 500

interface HintAnchorProps {
  ref?: Ref<HTMLElement>
  onMouseEnter?: MouseEventHandler
  onMouseMove?: MouseEventHandler
  onMouseLeave?: MouseEventHandler
  onPointerDown?: PointerEventHandler
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
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointer = useRef({ x: 0, y: 0 })
  const pointerDownAt = useRef(0)
  const triggers = useRef({ hover: false, focus: false })
  const [position, setPosition] = useState<HintTooltipPosition | null>(null)
  // 官方 Switch 等函数组件不透传 ref/焦点事件；只为这种锚点补一个可冒泡的 DOM owner。
  const source: ReactElement<HintAnchorProps> = typeof props.children.type === 'string'
    ? props.children : <span>{props.children}</span>
  const childRef = (source as ReactElement<HintAnchorProps> & { ref?: Ref<HTMLElement> }).ref
  const focusTarget = useRef<HTMLElement | null>(null)
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
  const cancelHide = useCallback(() => {
    if (hideTimer.current !== null) clearTimeout(hideTimer.current)
    hideTimer.current = null
  }, [])
  const hide = useCallback(() => {
    cancelHide()
    hideTimer.current = setTimeout(() => { if (!triggers.current.focus) setPosition(null) }, 160)
  }, [cancelHide])
  const showAtFocus = useCallback(() => {
    const rect = anchor.current?.getBoundingClientRect()
    if (rect === undefined) return
    setPosition({ kind: 'focus', left: rect.left, right: rect.right, centerY: rect.top + rect.height / 2 })
  }, [])
  const hideAfterBlur = useCallback(() => {
    cancelShow()
    if (!triggers.current.hover) {
      setPosition(null)
      return
    }
    // 鼠标仍悬停时不要立刻弹出：点击后按钮失焦会瞬间闪一次；回到悬停延迟。
    showTimer.current = setTimeout(() => {
      showTimer.current = null
      setPosition({ kind: 'pointer', ...pointer.current })
    }, HOVER_DELAY_MS)
  }, [cancelShow])

  useEffect(() => () => { cancelShow(); cancelHide() }, [cancelShow, cancelHide])
  useEffect(() => {
    if (position === null) return
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      cancelShow()
      cancelHide()
      setPosition(null)
    }
    document.addEventListener('keydown', dismiss, true)
    return () => document.removeEventListener('keydown', dismiss, true)
  }, [position !== null, cancelShow, cancelHide])
  useEffect(() => {
    if (position?.kind !== 'focus') return
    const target = focusTarget.current
    const previous = target?.getAttribute('aria-describedby')
    if (target !== null) target.setAttribute('aria-describedby', [...new Set([...(previous ?? '').split(' '), id].filter(Boolean))].join(' '))
    const update = () => showAtFocus()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      if (target !== null) {
        const remaining = (target.getAttribute('aria-describedby') ?? '').split(' ').filter((value) => value !== id && value.length > 0).join(' ')
        if (remaining) target.setAttribute('aria-describedby', remaining)
        else target.removeAttribute('aria-describedby')
      }
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

  const child = cloneElement(source, {
    ref: mergedRef,
    'aria-describedby': position === null
      ? source.props['aria-describedby']
      : [source.props['aria-describedby'], id].filter(Boolean).join(' '),
    onMouseEnter: (event) => {
      source.props.onMouseEnter?.(event)
      triggers.current.hover = true
      cancelHide()
      pointer.current = { x: event.clientX, y: event.clientY }
      if (triggers.current.focus) return
      cancelShow()
      showTimer.current = setTimeout(() => {
        showTimer.current = null
        setPosition({ kind: 'pointer', ...pointer.current })
      }, HOVER_DELAY_MS)
    },
    onMouseMove: (event) => {
      source.props.onMouseMove?.(event)
      pointer.current = { x: event.clientX, y: event.clientY }
      if (position?.kind === 'pointer') setPosition({ kind: 'pointer', ...pointer.current })
    },
    onMouseLeave: (event) => {
      source.props.onMouseLeave?.(event)
      triggers.current.hover = false
      cancelShow()
      if (!triggers.current.focus) hide()
    },
    onPointerDown: (event) => {
      source.props.onPointerDown?.(event)
      pointerDownAt.current = Date.now()
      cancelShow()
      cancelHide()
      setPosition(null)
    },
    onFocus: (event) => {
      source.props.onFocus?.(event)
      if (event.target instanceof Node && !event.currentTarget.contains(event.target)) {
        triggers.current.focus = false
        cancelShow()
        setPosition(null)
        return
      }
      focusTarget.current = event.target instanceof HTMLElement ? event.target : null
      // 鼠标点击也会触发 focus（checkbox 等控件点击后同样匹配 :focus-visible）：
      // 只有键盘聚焦才锁定聚焦说明，否则点击按钮后它失焦或卸载会让浮窗在旁边闪一次。
      const keyboard = shouldLockFocus({ element: focusTarget.current ?? event.currentTarget, pointerDownAt: pointerDownAt.current, now: Date.now() })
      triggers.current.focus = keyboard
      cancelShow()
      if (keyboard) showAtFocus()
    },
    onBlur: (event) => {
      source.props.onBlur?.(event)
      triggers.current.focus = false
      hideAfterBlur()
    },
  })
  const tooltip = position !== null && typeof document !== 'undefined' && document.body !== null
    ? createPortal(<span ref={bubble} id={id} className={css.bubble} role="tooltip"
      onMouseEnter={cancelHide} onMouseLeave={hide}>{props.label}</span>, document.body)
    : null
  return <>{child}{tooltip}</>
}
