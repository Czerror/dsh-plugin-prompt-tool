import { useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import type { PromptToolWorkspaceController } from './workspace-controller.ts'
import css from './Workbench.module.css'
/** 左上角悬浮触发器：透过 body portal 落在对话界面层。 */
export function FloatingTrigger(props: { controller: PromptToolWorkspaceController; triggerRef?: RefObject<HTMLButtonElement> }): ReactNode {
  const { controller, triggerRef } = props
  const open = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot).open
  return (
    <div className={css.floatingTriggerLayer} data-dsh-part="floating-trigger-layer">
      <button
        ref={triggerRef}
        type="button"
        className={css.floatingTrigger}
        data-open={open ? '' : undefined}
        data-dsh-plugin="prompt-tool"
        data-dsh-part="floating-trigger"
        aria-label={open ? '关闭提示词工具' : '打开提示词工具'}
        aria-pressed={open}
        title={open ? '关闭提示词工具' : '打开提示词工具'}
        onClick={() => controller.toggle()}
      >
        <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3.5 2.5h6l3 3v8h-9zM9.5 2.5v3h3M6 8.5h4M8 6.5v4" />
        </svg>
      </button>
    </div>
  )
}
