import { useEffect, useRef, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PromptWorkspace } from '../workspace/PromptWorkspace.tsx'
import { FloatingTrigger } from './FloatingTrigger.tsx'
import type { PromptToolWorkbenchFace } from './workbench-face.ts'
import { FOCUSABLE, nextDialogFocusIndex } from '../../ui/dialog-focus.ts'
import css from './Workbench.module.css'

type OverlayProps = PropsRuntime<'shell.overlay'> & InjectFace<PromptToolWorkbenchFace> & PropsLocale<'prompt-tool'>
/** shell.overlay：顶层触发器 + 右侧抽屉工作台；store 状态跨开关保留。 */
export function WorkbenchOverlay(props: OverlayProps): ReactNode {
  const { controller, api, settings, t } = props
  const open = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot).open
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); controller.close() }
    }
    // 与其他面板互斥：兼容仍在 DOM 面板上的 taskboard / ssh 事件总线。
    const onOther = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail
      if (detail === 'taskboard' || detail === 'ssh') controller.close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('dsh-panel-activate', onOther)
    document.dispatchEvent(new CustomEvent('dsh-panel-activate', { detail: 'prompt-tool' }))
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('dsh-panel-activate', onOther)
    }
  }, [open, controller])
  // 关闭后焦点还给触发器（可访问性：焦点不得悬空在 body 上；经 ref 拿自己的按钮，
  // 只拿自己的按钮 ref，不触达宿主 DOM 结构。
  const triggerRef = useRef<HTMLButtonElement>(null)
  const drawerRef = useRef<HTMLElement>(null)
  const prevOpenRef = useRef(open)
  useEffect(() => {
    const wasOpen = prevOpenRef.current
    prevOpenRef.current = open
    if (!wasOpen && open) drawerRef.current?.focus()
    if (wasOpen && !open) triggerRef.current?.focus()
  }, [open])
  /** aria-modal 抽屉的首尾 Tab 循环：焦点不得越过抽屉进入宿主页面。
   *  弹窗（DialogSurface/TemplatePicker）是 body portal，不在抽屉 DOM 内——
   *  焦点在弹窗内时交给弹窗自己的循环管理，这里不拦截。 */
  const onDrawerKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Tab' || drawerRef.current === null) return
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !drawerRef.current.contains(active)) return
    const focusables = [...drawerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
      .filter((element) => !element.hasAttribute('disabled') && element.getClientRects().length > 0)
    const next = nextDialogFocusIndex(focusables.length, focusables.indexOf(active), event.shiftKey)
    if (next === undefined) return
    event.preventDefault()
    focusables[next]?.focus()
  }
  const trigger = <FloatingTrigger controller={controller} triggerRef={triggerRef} t={t} />
  // 抽屉同样 body portal + fixed 顶层：宿主「对话/轨迹」顶部导航栏处于更高层级，
  // 只挂在 shell.overlay slot 内会被导航栏遮挡（不是最顶层）；portal 到 body 后
  // 用高 z-index 保证抽屉背板/面板与悬浮按钮始终在导航栏之上。
  const drawer = (
    <div className={css.drawerLayer} data-open={open ? '' : undefined}>
      <div className={css.drawerBackdrop} onClick={() => controller.close()} aria-hidden="true" />
      <section id="pt-workbench-drawer" ref={drawerRef} className={css.drawerPanel} data-dsh-part="workspace-drawer" role="dialog" aria-modal="true" aria-label={t('app.panelAria')} tabIndex={-1} onKeyDown={onDrawerKeyDown}>
        <PromptWorkspace api={api} settings={settings} controller={controller} t={t} onClose={() => controller.close()} />
      </section>
    </div>
  )
  return (
    <>
      {typeof document === 'undefined' || document.body === null ? trigger : createPortal(trigger, document.body)}
      {typeof document === 'undefined' || document.body === null ? drawer : createPortal(drawer, document.body)}
    </>
  )
}
