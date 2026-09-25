import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MutableRefObject, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
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

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    dragRef.current = {
      pointerId: event.pointerId,
      startPointer: { x: event.clientX, y: event.clientY },
      startPosition: position,
      moved: false,
    }
  }, [position])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const delta = { x: event.clientX - drag.startPointer.x, y: event.clientY - drag.startPointer.y }
    if (!drag.moved && !isDragGesture(drag.startPointer, { x: event.clientX, y: event.clientY })) return
    if (!drag.moved) {
      drag.moved = true
      // 指针捕获：拖出按钮范围仍持续收到 move/up，也避免拖动选中文本。
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    setPosition(clampPoint(
      { x: drag.startPosition.x + delta.x, y: drag.startPosition.y + delta.y },
      { width: window.innerWidth, height: window.innerHeight },
      { width: event.currentTarget.offsetWidth, height: event.currentTarget.offsetHeight },
    ))
  }, [])

  const endDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    if (!drag.moved) return
    suppressClickRef.current = true
    // 拖动后解除捕获，并把最终位置写成偏好。
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    setPosition((current) => {
      storeTriggerPosition(current)
      return current
    })
  }, [])

  const onClick = useCallback(() => {
    // 拖动收尾会派发一次 click：这里吞掉，拖动不触发开合。
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
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
