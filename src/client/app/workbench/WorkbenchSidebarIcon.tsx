import { useEffect, useRef } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

type WorkbenchSidebarIconProps = Pick<PropsRuntime<'sidebar.panellist'>, 'size'> & InjectFace<{ open: () => void }>

/**
 * 侧栏行图标，同时把整行的点击截下来直接打开常驻抽屉。
 *
 * 行按钮自己的 onClick 会 selectPanel(id)，而官方切 main 要整树卸载对话（实测
 * 2–3s）。行按钮是宿主组件，只能在事件冒泡到 React 根之前用原生监听拦下，因此
 * 依赖「图标位于行 button 内」这一当前结构：结构变化时 closest 取不到，点击退回
 * main 重定向入口（慢但可用）。
 */
export function WorkbenchSidebarIcon({ size, open }: WorkbenchSidebarIconProps) {
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => {
    const row = ref.current?.closest('button')
    if (row === null || row === undefined) return
    const onClick = (event: MouseEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      open()
    }
    row.addEventListener('click', onClick)
    return () => { row.removeEventListener('click', onClick) }
  }, [open])
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
