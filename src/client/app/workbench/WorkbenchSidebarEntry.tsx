import { useEffect, useMemo, useRef } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { createWorkbenchHost } from './workbench-host.ts'

type WorkbenchSidebarEntryProps = Pick<PropsRuntime<'sidebar.panellist'>, 'size'> & InjectFace<{ open: () => void }>

/**
 * 侧栏导航入口的图标组件：行点击在冒泡阶段被截获，直接打开常驻抽屉。
 *
 * 行按钮自己的 onClick 会 selectPanel(id)，而官方切 main 会整树卸载对话（本机
 * 单次观测约 2–3s）。行按钮是宿主组件，只能在事件到达 React 根之前用原生监听
 * 拦下，因此依赖「图标位于行 button 内」这一当前结构：结构变化时 closest 取不到，
 * 点击会由宿主 selectPanel 抛 `main panel "prompt-tool" is not registered`。
 */
export function WorkbenchSidebarEntry({ size, open }: WorkbenchSidebarEntryProps) {
  const ref = useRef<SVGSVGElement>(null)
  const host = useMemo(createWorkbenchHost, [])
  useEffect(() => host.interceptSidebarRow(ref.current, open), [host, open])
  return (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-dsh-plugin="prompt-tool"
      data-dsh-part="sidebar-icon"
    >
      <path d="M3.5 2.5h6l3 3v8h-9zM9.5 2.5v3h3M6 8.5h4M8 6.5v4" />
    </svg>
  )
}
