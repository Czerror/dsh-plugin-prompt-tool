import { useLayoutEffect, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PromptToolWorkspaceController } from './workspace-controller.ts'

/** Face the sidebar-entry redirect needs; the translation comes from the slot locale. */
export interface WorkbenchMainPanelFace {
  /** 常驻的悬浮抽屉控制器：入口直接打开同一个工作台实例。 */
  controller: PromptToolWorkspaceController
  /** 回到对话（官方 selectPanel(null)）。 */
  closePanel: () => void
}

type WorkbenchMainPanelProps = PropsRuntime<'main'> & InjectFace<WorkbenchMainPanelFace> & PropsLocale<'prompt-tool'>

/**
 * 左侧栏入口不是独立主面板：它打开常驻的悬浮抽屉（同一工作台实例）。抽屉先在
 * 绘制前上屏，下一帧再回对话——官方切回 conversation 会整树重建，同步执行会把
 * 入口的首次绘制一起堵住（实测 2–3s）。返回只关抽屉，不重建对话或工作台。
 */
export function WorkbenchMainPanel({ controller, closePanel }: WorkbenchMainPanelProps): ReactNode {
  useLayoutEffect(() => {
    controller.open()
    // 绘制前打开抽屉（layout effect 中的外部 store 更新同步 flush），对话重建让到下一帧。
    const frame = requestAnimationFrame(() => closePanel())
    return () => cancelAnimationFrame(frame)
  }, [controller, closePanel])
  return null
}
