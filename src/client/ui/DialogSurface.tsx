import { useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Button, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import { useAnchoredPopoverStyle } from './anchored-popover.ts'
import { useDialogFocus } from './dialog-focus.ts'
import styles from './controls.module.css'

/** 共享 picker 表面：缺 anchor 时居中模态；传 anchor 时 body 顶层跟随触发按钮。 */
export function DialogSurface(props: {
  title: string
  ariaLabel?: string
  closeLabel?: string
  anchorRef?: RefObject<HTMLElement | null>
  onClose: () => void
  children: ReactNode
}): ReactNode {
  const { dialogRef, onDialogKeyDown } = useDialogFocus<HTMLDivElement>(true, props.onClose)
  const fallbackAnchorRef = useRef<HTMLElement>(null)
  const anchorRef = props.anchorRef ?? fallbackAnchorRef
  const panelRef = dialogRef as RefObject<HTMLElement | null>
  const anchored = props.anchorRef !== undefined
  const position = useAnchoredPopoverStyle({
    open: anchored,
    anchorRef,
    panelRef,
    gap: 8,
    margin: 12,
  })
  useDismissOnOutsidePointer(anchorRef, anchored, (open) => { if (!open) props.onClose() }, panelRef)

  const panel = (
    <div
      ref={dialogRef}
      className={anchored ? styles.templatePopover : styles.templateModal}
      style={anchored ? position ?? { visibility: 'hidden' } : undefined}
      role="dialog"
      aria-modal={anchored ? undefined : true}
      aria-label={props.ariaLabel ?? props.title}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={onDialogKeyDown}
    >
      <div className={styles.templateModalHead}>
        <strong>{props.title}</strong>
        <Button
          variant="ghost"
          size="sm"
          className={styles.dialogClose}
          aria-label={props.closeLabel ?? '关闭'}
          onClick={props.onClose}
        >
          ×
        </Button>
      </div>
      <div className={styles.templateModalList}>{props.children}</div>
    </div>
  )
  const surface = anchored ? panel : <div className={styles.modalBackdrop} onClick={props.onClose}>{panel}</div>
  return typeof document === 'undefined' || document.body === null ? surface : createPortal(surface, document.body)
}
