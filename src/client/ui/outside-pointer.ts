import { useEffect, type RefObject } from 'react'

/** 触发器和 body portal 都属于弹层；仅在两者之外点击时关闭。 */
export function useDismissOnOutsidePointer(root: RefObject<HTMLElement | null>, open: boolean,
  setOpen: (open: boolean) => void, portal: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target) && !portal.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [root, portal, open, setOpen])
}
