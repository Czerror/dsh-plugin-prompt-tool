import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import css from './rule-canvas.module.css'

export interface RuleCanvasNode {
  id: string
  title: string
  value?: string
  x: number
  y: number
  width?: number
  height?: number
  kind?: 'condition' | 'group' | 'action'
  selected?: boolean
  dropTarget?: string
  region?: boolean
  members?: readonly string[]
}
export interface RuleCanvasEdge { from: string; to: string; label?: string; kind?: 'condition' | 'then' | 'else' | 'order' }
export interface RuleCanvasView { x: number; y: number; scale: number; positions: Record<string, { x: number; y: number }> }
export interface RuleCanvasProps {
  nodes: readonly RuleCanvasNode[]
  edges?: readonly RuleCanvasEdge[]
  view: RuleCanvasView
  onViewChange: (view: RuleCanvasView) => void
  onSelect: (id: string) => void
  onMove?: (id: string, x: number, y: number) => void
  onFit?: () => void
  canDropNode?: (targetId: string, data: string) => boolean
  onDropNode?: (targetId: string, data: string) => void
  children?: ReactNode
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const roundedRoute = (points: Array<[number, number]>): string => {
  let path = `M ${points[0]![0]} ${points[0]![1]}`
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1]!, b = points[i]!, c = points[i + 1]!
    const incoming = Math.hypot(b[0] - a[0], b[1] - a[1]), outgoing = Math.hypot(c[0] - b[0], c[1] - b[1])
    if (!incoming || !outgoing) continue
    const radius = Math.min(12, incoming / 2, outgoing / 2)
    const before: [number, number] = [b[0] - (b[0] - a[0]) * radius / incoming, b[1] - (b[1] - a[1]) * radius / incoming]
    const after: [number, number] = [b[0] + (c[0] - b[0]) * radius / outgoing, b[1] + (c[1] - b[1]) * radius / outgoing]
    path += ` L ${before[0]} ${before[1]} Q ${b[0]} ${b[1]} ${after[0]} ${after[1]}`
  }
  const last = points.at(-1)!
  return path + ` L ${last[0]} ${last[1]}`
}

export function RuleCanvas(props: RuleCanvasProps) {
  const stage = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id?: string; pointerId: number; startX: number; startY: number; baseX: number; baseY: number; moved: boolean }>()
  const suppressClick = useRef(false)
  const [dropTarget, setDropTarget] = useState<string>()
  useEffect(() => {
    const element = stage.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      const oldScale = props.view.scale
      const next = clamp(oldScale * Math.exp(-event.deltaY * 0.001), 0.35, 2.5)
      const localX = event.clientX - rect.left, localY = event.clientY - rect.top
      const worldX = (localX - props.view.x) / oldScale, worldY = (localY - props.view.y) / oldScale
      props.onViewChange({ ...props.view, scale: next, x: localX - worldX * next, y: localY - worldY * next })
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [props.view, props.onViewChange])
  const byId = new Map(props.nodes.map(node => [node.id, node]))
  const begin = (event: ReactPointerEvent<HTMLElement>, node?: RuleCanvasNode) => {
    if (event.button !== 0) return
    const point = node ? props.view.positions[node.id] ?? node : undefined
    drag.current = { id: node?.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, baseX: point?.x ?? props.view.x, baseY: point?.y ?? props.view.y, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    if (!current.moved && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 4) return
    current.moved = true
    const dx = (event.clientX - current.startX) / props.view.scale
    const dy = (event.clientY - current.startY) / props.view.scale
    if (current.id) props.onMove?.(current.id, current.baseX + dx, current.baseY + dy)
    else props.onViewChange({ ...props.view, x: current.baseX + event.clientX - current.startX, y: current.baseY + event.clientY - current.startY })
  }
  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return
    suppressClick.current = drag.current.moved
    drag.current = undefined
  }
  const cancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return
    const current = drag.current
    if (current.id) props.onMove?.(current.id, current.baseX, current.baseY)
    else props.onViewChange({ ...props.view, x: current.baseX, y: current.baseY })
    drag.current = undefined
  }
  return <div className={css.canvas} data-rule-canvas onKeyDown={event => {
    if (event.nativeEvent.isComposing || event.key !== 'Escape' || !drag.current) return
    event.preventDefault()
    const current = drag.current
    if (current.id) props.onMove?.(current.id, current.baseX, current.baseY)
    else props.onViewChange({ ...props.view, x: current.baseX, y: current.baseY })
    drag.current = undefined
  }} onPointerDown={event => begin(event)} onPointerMove={move} onPointerUp={end} onPointerCancel={cancel} onLostPointerCapture={cancel}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(undefined) }}
    onDragOver={event => { const id = (event.target as HTMLElement).closest<HTMLElement>('[data-canvas-target]')?.dataset.canvasTarget; const valid = id && event.dataTransfer.types.includes('application/x-prompt-tool-rule-node') && props.canDropNode?.(id, ''); setDropTarget(valid ? id : undefined); if (valid) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' } }}
    onDrop={event => { setDropTarget(undefined); const target = (event.target as HTMLElement).closest<HTMLElement>('[data-canvas-target]')?.dataset.canvasTarget; const data = event.dataTransfer.getData('application/x-prompt-tool-rule-node'); if (target && props.canDropNode?.(target, data)) { event.preventDefault(); props.onDropNode?.(target, data) } }}>
    <div ref={stage} className={css.stage} data-rule-stage>
    <div className={css.world} style={{ transform: `translate(${props.view.x}px, ${props.view.y}px) scale(${props.view.scale})` }}>
      <svg className={css.edges} aria-hidden="true">
        {props.edges?.map(edge => {
          const from = byId.get(edge.from), to = byId.get(edge.to)
          if (!from || !to) return null
          const a = { ...from, ...(props.view.positions[from.id] ?? {}) }, b = { ...to, ...(props.view.positions[to.id] ?? {}) }
          const x1 = a.x + 216, y1 = a.y + 50, x2 = b.x, y2 = b.y + 50
          const path = x2 > x1 ? roundedRoute([[x1, y1], [(x1 + x2) / 2, y1], [(x1 + x2) / 2, y2], [x2, y2]])
            : roundedRoute([[x1, y1], [x1 + 24, y1], [x1 + 24, Math.min(y1, y2) - 24], [x2 - 24, Math.min(y1, y2) - 24], [x2 - 24, y2], [x2, y2]])
          const active = props.nodes.some(node => node.selected && (node.id === edge.from || node.id === edge.to))
          const labelX = (x1 + x2) / 2, labelY = (y1 + y2) / 2
          return <g key={`${edge.from}-${edge.to}`} className={active ? css.activeEdge : css.inactiveEdge}>
            <path className={edge.kind ? css[edge.kind] : undefined} d={path} />
            <circle className={css.inPort} cx={x1} cy={y1} r="5" /><circle className={css.outPort} cx={x2} cy={y2} r="5" />
            {edge.label && <g className={css.edgeLabel}><rect x={labelX - edge.label.length * 3.5 - 8} y={labelY - 10} width={edge.label.length * 7 + 16} height="20" rx="10" /><text x={labelX} y={labelY}>{edge.label}</text></g>}
          </g>
        })}
      </svg>
      {props.nodes.map(node => {
        const position = props.view.positions[node.id] ?? node
        const members = node.members?.flatMap(id => { const member = byId.get(id); return member ? [{ ...member, ...props.view.positions[id] }] : [] })
        const region = members?.length ? {
          left: Math.min(...members.map(item => item.x)) - 16,
          top: Math.min(...members.map(item => item.y)) - 56,
          width: Math.max(...members.map(item => item.x + (item.width ?? 216))) - Math.min(...members.map(item => item.x)) + 32,
          height: Math.max(...members.map(item => item.y + (item.height ?? 112))) - Math.min(...members.map(item => item.y)) + 72,
        } : { left: position.x, top: position.y, width: node.width, height: node.height }
        if (node.region) return <button key={node.id} type="button" className={css.region} data-rule-node={node.id} data-canvas-target={node.dropTarget}
          data-drop-ready={node.dropTarget === dropTarget || undefined} aria-pressed={node.selected} onClick={() => props.onSelect(node.id)}
          onPointerDown={event => event.stopPropagation()} style={region}><strong>{node.title}</strong></button>
        return <button key={node.id} type="button" className={css.node} data-rule-node={node.id} data-canvas-target={node.dropTarget} data-drop-ready={node.dropTarget !== undefined && node.dropTarget === dropTarget || undefined} aria-pressed={node.selected} aria-description="方向键移动节点；Enter 编辑属性" style={{ left: position.x, top: position.y, width: node.width ?? 216 }} onClick={event => { if (event.detail === 0 || !suppressClick.current) props.onSelect(node.id); suppressClick.current = false }} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          const delta = event.shiftKey ? 40 : 16
          const offsets: Record<string, [number, number]> = { ArrowLeft: [-delta, 0], ArrowRight: [delta, 0], ArrowUp: [0, -delta], ArrowDown: [0, delta] }
          const offset = offsets[event.key]
          if (offset) { event.preventDefault(); const point = props.view.positions[node.id] ?? node; props.onMove?.(node.id, point.x + offset[0], point.y + offset[1]) }
        }} onPointerDown={event => { event.stopPropagation(); begin(event, node) }}>
          <small>{node.kind ?? 'condition'}</small><strong>{node.title}</strong><span>{node.value}</span>
        </button>
      })}
      {props.children}
    </div>
    </div>
    <div className={css.dock} onPointerDown={event => event.stopPropagation()}>
      <button type="button" aria-label="缩小" onClick={() => props.onViewChange({ ...props.view, scale: clamp(props.view.scale - 0.1, 0.35, 2.5) })}>−</button>
      <span>{Math.round(props.view.scale * 100)}%</span>
      <button type="button" aria-label="放大" onClick={() => props.onViewChange({ ...props.view, scale: clamp(props.view.scale + 0.1, 0.35, 2.5) })}>+</button>
      <button type="button" onClick={props.onFit}>适应</button>
      <button type="button" onClick={() => props.onViewChange({ scale: 0.8, x: 260, y: 110, positions: {} })}>复位</button>
      {([[40, 0, '向右平移', '→'], [-40, 0, '向左平移', '←'], [0, -40, '向上平移', '↑'], [0, 40, '向下平移', '↓']] as const).map(([x, y, label, icon]) => <button key={label} type="button" aria-label={label} onClick={() => props.onViewChange({ ...props.view, x: props.view.x + x, y: props.view.y + y })}>{icon}</button>)}
    </div>
    <div className={css.legend} aria-label="连线语义"><span>条件组成</span><span>THEN 命中</span><span>ELSE 未命中</span><span>次序仅限同一执行点</span></div>
  </div>
}
