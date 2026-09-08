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
  const pointer = useRef({ x: 0, y: 0 })
  const pointerDownAt = useRef(0)
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
      }, HOVER_DELAY_MS)
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
    onPointerDown: (event) => {
      props.children.props.onPointerDown?.(event)
      pointerDownAt.current = Date.now()
    },
    onFocus: (event) => {
      props.children.props.onFocus?.(event)
      // 鼠标点击也会触发 focus（checkbox 等控件点击后同样匹配 :focus-visible）：
      // 只有键盘聚焦才锁定聚焦说明，否则点击按钮后它失焦或卸载会让浮窗在旁边闪一次。
      const keyboard = shouldLockFocus({ element: event.currentTarget, pointerDownAt: pointerDownAt.current, now: Date.now() })
      triggers.current.focus = keyboard
      cancelShow()
      if (keyboard) showAtFocus()
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
