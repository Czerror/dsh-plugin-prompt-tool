import { useLayoutEffect, useRef, type ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './Workbench.module.css'

type SidebarGeometryProps = PropsRuntime<'sidebar.footer.action'>
/** 悬浮触发器（28px 按钮）左缘与侧栏轨道右缘的设计间距（px）= 0：按钮圆缘
 *  与侧栏边缘线相切（真·边缘贴靠，不留空隙）。可见图标（18px 居中）因此与
 *  侧栏保持 5px 微呼吸——命中区贴线、笔画不压线。 */
const FLOATING_TRIGGER_GAP = 0
const FLOATING_TRIGGER_LEFT_PROPERTY = '--pt-sidebar-edge'

/**
 * Official sidebar geometry bridge. The visible trigger is portaled to body
 * from the frame-wide overlay; this probe reads the sidebar track width
 * straight from the layout frame's inline grid-template-columns — the single
 * live truth covering every form: collapsed 56px rail, 264–420px drag range,
 * mid-drag pointer cadence, and the <1024px auto-collapse breakpoint.
 */
export function SidebarGeometryProbe(props: SidebarGeometryProps): ReactNode {
  const { wide } = props
  const probeRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const probe = probeRef.current
    if (probe === null) return
    const setLeft = (left: number): void => {
      document.documentElement.style.setProperty(FLOATING_TRIGGER_LEFT_PROPERTY, String(Math.round(left)) + 'px')
    }
    // 官方 AppFrame 布局根的恒定特征：inline grid-template-columns（折叠 56 /
    // 展开 264–420 / 拖拽 pointer cadence 全形态都写，永不缺省）。注意不得用
    // 官方折叠标记属性作锚点——它是条件属性（展开态被 React 移除），展开后
    // 爬链落空、按钮不跟随（上一版 bug 的根因）。从探针向上爬链找到它（只
    // 消费自身 DOM 位置关系，不选择宿主节点、不假设层级），侧栏轨道宽度就
    // 在同一元素的 computed grid-template-columns 第一段。
    const frameAnchor = (): HTMLElement | undefined => {
      let node = probe.parentElement
      while (node !== null) {
        if (node.style.gridTemplateColumns !== '') return node
        node = node.parentElement
      }
      return undefined
    }
    // 侧栏轨道实时宽（px）：computed grid-template-columns 的第一段 used value
    // （折叠 56 / 展开 264–420 / 拖拽与轨道过渡中的中间值）。解析失败保持旧值。
    const sidebarTrack = (frame: HTMLElement): number | undefined => {
      const first = getComputedStyle(frame).gridTemplateColumns.split(' ')[0] ?? ''
      const px = Number.parseFloat(first)
      return Number.isFinite(px) && px > 0 ? px : undefined
    }
    const update = (): void => {
      const frame = frameAnchor()
      if (frame === undefined) return
      const track = sidebarTrack(frame)
      if (track !== undefined) setLeft(track + FLOATING_TRIGGER_GAP)
    }
    update()
    // 向上查找第一个有实际布局尺寸的祖先：渲染锚点是 display:contents（0 尺寸），
    // 不假设宿主父节点层级（SidebarRoot footerActions 容器位置随版本变化）。
    const measuredAncestor = (): HTMLElement | undefined => {
      let node = probe.parentElement
      while (node !== null) {
        const rect = node.getBoundingClientRect()
        if (rect.width > 0 || rect.height > 0) return node
        node = node.parentElement
      }
      return undefined
    }
    // 轨道变化跟随三路：① footerActions 容器尺寸随轨道变（展开态 width:100%
    // 跟随拖拽 pointer cadence、折叠 settle 时跳变）→ ResizeObserver 重读轨道；
    // ② 轨道自身 transition（slow 曲线）结束时容器未必再变 → transitionend 兜底；
    // ③ 窗口尺寸变化（断点自动折叠）→ resize 兜底。全部幂等重读。
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    const measured = measuredAncestor()
    if (measured !== undefined) observer?.observe(measured)
    const frame = frameAnchor()
    frame?.addEventListener('transitionend', update)
    window.addEventListener('resize', update)
    return () => {
      observer?.disconnect()
      frame?.removeEventListener('transitionend', update)
      window.removeEventListener('resize', update)
      document.documentElement.style.removeProperty(FLOATING_TRIGGER_LEFT_PROPERTY)
    }
  }, [wide])
  return (
    <div
      ref={probeRef}
      className={css.sidebarEdgeProbe}
      aria-hidden="true"
    />
  )
}
