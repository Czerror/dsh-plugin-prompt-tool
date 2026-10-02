import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as ReactMouseEvent, type MutableRefObject, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import type { PromptToolTranslate } from '../../locales.ts'
import type { PromptToolWorkspaceController } from './workspace-controller.ts'
import {
  DEFAULT_TRIGGER,
  clampPoint,
  isDragGesture,
  readStoredTriggerPosition,
  storeTriggerPosition,
  type TriggerPoint,
} from './floating-trigger-position.ts'
import css from './Workbench.module.css'

/**
 * 可拖动悬浮触发器：透过 body portal 落在对话界面层。
 *
 * 位置由本插件自己的 localStorage 偏好 + 视口夹取决定，不读宿主 DOM 几何
 * （不再依赖侧栏 grid-template-columns、祖先爬链或针对宿主的 ResizeObserver）。
 * 位移超过阈值视为拖动并吞掉尾随 click；单击与键盘仍开合工作台。
 */
export function FloatingTrigger(props: { controller: PromptToolWorkspaceController; triggerRef?: MutableRefObject<HTMLButtonElement | null>; t: PromptToolTranslate }): ReactNode {
  const { controller, triggerRef, t } = props
  // 宿主（WorkbenchOverlay）只读地用这个 ref 归还焦点；这里写入自身节点。
  const writableTriggerRef = triggerRef as MutableRefObject<HTMLButtonElement | null> | undefined
  const open = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot).open
  // useRef<T>(null) 在 @types/react 18 走 readonly 的 RefObject 重载：显式标注可变 ref。
  const localRef = useRef<HTMLButtonElement | null>(null) as MutableRefObject<HTMLButtonElement | null>
  const [position, setPosition] = useState<TriggerPoint>(() => readStoredTriggerPosition() ?? DEFAULT_TRIGGER)
  const dragRef = useRef<{ pointerId: number; startPointer: TriggerPoint; startPosition: TriggerPoint; moved: boolean } | null>(null)
  const suppressClickRef = useRef(false)

  // 窗口变化（含窄屏断点改变按钮尺寸）后把按钮夹回可见区域。
  useEffect(() => {
    const clampToViewport = (): void => {
      setPosition((current) => {
        const rect = localRef.current?.getBoundingClientRect()
        const next = clampPoint(
          current,
          { width: window.innerWidth, height: window.innerHeight },
          rect === undefined ? {} : { width: rect.width, height: rect.height },
        )
        return next.x === current.x && next.y === current.y ? current : next
      })
    }
    clampToViewport()
    window.addEventListener('resize', clampToViewport)
    return () => window.removeEventListener('resize', clampToViewport)
  }, [])

  const endDrag = useCallback((event?: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (drag === null || (event !== undefined && drag.pointerId !== event.pointerId)) return
    dragRef.current = null
    // 捕获丢失也可能有尾随 click；下一次按下会重置，取消不会吞掉新点击。
    suppressClickRef.current = drag.moved
    const node = localRef.current
    if (node?.hasPointerCapture(drag.pointerId)) node.releasePointerCapture(drag.pointerId)
    if (drag.moved) setPosition((current) => {
      storeTriggerPosition(current)
      return current
    })
  }, [])

  useEffect(() => {
    const cancelDrag = (): void => endDrag()
    window.addEventListener('blur', cancelDrag)
    return () => window.removeEventListener('blur', cancelDrag)
  }, [endDrag])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !event.isPrimary) return
    suppressClickRef.current = false
    dragRef.current = {
      pointerId: event.pointerId,
      startPointer: { x: event.clientX, y: event.clientY },
      startPosition: position,
      moved: false,
    }
    // 按下即捕获，避免达到拖动阈值前在按钮外释放而漏收 pointerup。
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [position])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    if ((event.buttons & 1) === 0) { endDrag(); return }
    const delta = { x: event.clientX - drag.startPointer.x, y: event.clientY - drag.startPointer.y }
    if (!drag.moved && !isDragGesture(drag.startPointer, { x: event.clientX, y: event.clientY })) return
    drag.moved = true
    setPosition(clampPoint(
      { x: drag.startPosition.x + delta.x, y: drag.startPosition.y + delta.y },
      { width: window.innerWidth, height: window.innerHeight },
      { width: event.currentTarget.offsetWidth, height: event.currentTarget.offsetHeight },
    ))
  }, [endDrag])

  const onClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    // 拖动收尾会派发一次 click：这里吞掉，拖动不触发开合。
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      if (event.detail !== 0) return
    }
    controller.toggle()
  }, [controller])

  const style = { left: `${position.x}px`, top: `${position.y}px` } satisfies CSSProperties
  const label = open ? t('app.close') : t('app.open')
  return (
    <div className={css.floatingTriggerLayer} data-dsh-part="floating-trigger-layer" style={style}>
      <HintTooltip label={label}>
        <button
          ref={(node: HTMLButtonElement | null) => {
            localRef.current = node
            if (writableTriggerRef !== undefined) writableTriggerRef.current = node
          }}
          type="button"
          className={css.floatingTrigger}
          data-open={open ? '' : undefined}
          data-dsh-plugin="prompt-tool"
          data-dsh-part="floating-trigger"
          aria-label={label}
          aria-pressed={open}
          aria-expanded={open}
          aria-controls="pt-workbench-drawer"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onClick={onClick}
        >
          <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3.5 2.5h6l3 3v8h-9zM9.5 2.5v3h3M6 8.5h4M8 6.5v4" />
          </svg>
        </button>
      </HintTooltip>
    </div>
  )
}
