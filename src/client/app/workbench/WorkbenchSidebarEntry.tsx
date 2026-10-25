import { useEffect, useRef } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { workbenchHostConventions } from './workbench-host-conventions.ts'

type WorkbenchSidebarEntryProps = Pick<PropsRuntime<'sidebar.panellist'>, 'size'> & InjectFace<{ open: () => void }>

/**
 * 侧栏导航入口的图标组件：渲染图标，并在 effect 里让 adapter 把行点击接到 open。
 *
 * 宿主行结构与事件名归 `workbench-host-conventions.ts`；本组件只提供图标 ref 与 open，
 * 不解释「图标位于哪个宿主按钮内」。
 */
export function WorkbenchSidebarEntry({ size, open }: WorkbenchSidebarEntryProps) {
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => workbenchHostConventions.interceptSidebarRow(ref.current, open), [open])
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
