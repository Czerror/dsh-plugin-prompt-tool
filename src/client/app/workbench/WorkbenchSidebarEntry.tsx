import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
type WorkbenchSidebarEntryProps = Pick<PropsRuntime<'sidebar.panellist'>, 'size'>

/** 左侧导航入口图标；行选择由宿主 sidebar.panellist 负责。 */
export function WorkbenchSidebarEntry({ size }: WorkbenchSidebarEntryProps) {
  return (
    <svg
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
