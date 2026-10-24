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
 * 左侧栏入口不是独立主面板：它打开常驻的悬浮抽屉（同一工作台实例）并立即回到
 * 对话，在绘制前完成。这样从工作台返回只是关闭抽屉，不切换 main，也不会重建
 * 对话或工作台——独立主面板会在每次切换时整树卸载/重建，正是卡顿的来源。
 */
export function WorkbenchMainPanel({ controller, closePanel }: WorkbenchMainPanelProps): ReactNode {
  useLayoutEffect(() => {
    controller.open()
    closePanel()
  }, [controller, closePanel])
  return null
}
