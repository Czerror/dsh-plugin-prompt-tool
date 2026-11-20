import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { PromptToolTranslate } from '../../locales.ts'
import { EdgeFlow } from './EdgeFlow.tsx'
import css from './rule-canvas.module.css'

export interface CanvasInstructionFile {
  id: string
  name: string
  path: string
  summary: string
  enabled: boolean
}

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
  instruction?: CanvasInstructionFile
}
export interface RuleCanvasEdge { from: string; to: string; label?: string; kind?: 'condition' | 'then' | 'else' | 'order' }
export interface RuleCanvasView { x: number; y: number; scale: number; positions: Record<string, { x: number; y: number }> }
export interface RuleCanvasProps {
  t: PromptToolTranslate
  nodes: readonly RuleCanvasNode[]
  fileNodes?: readonly RuleCanvasNode[]
  instructionFiles?: readonly CanvasInstructionFile[]
  activeInstructionId?: string
  selectedNodeId?: string
  hasStoredView?: boolean
  edges?: readonly RuleCanvasEdge[]
  view: RuleCanvasView
  onViewChange: (view: RuleCanvasView) => void
  onSelect: (id: string) => void
  onSelectInstruction?: (id: string) => void
  onPaneClick: () => void
  onMove?: (id: string, x: number, y: number) => void
  canDropNode?: (targetId: string, data: string) => boolean
  onDropNode?: (targetId: string, data: string) => void
  children?: ReactNode
}

const FILE_WIDTH = 236
const FILE_HEIGHT = 96
const FILE_GAP = 24
const fileStride = FILE_HEIGHT + FILE_GAP
const READABLE_SCALE = .75
const CANVAS_GAP = 12
// Keep all incident edges highlighted. Bound moving marks for high-degree nodes.
const MAX_FLOW_EDGES = 8
const OBSTACLE = '[data-canvas-obstacle], [data-instruction-inspector]'

interface CanvasRect { left: number; right: number; top: number; bottom: number }
interface CanvasArea { stageWidth: number; base: CanvasRect; visible: CanvasRect; spaces: CanvasRect[] }

const areaSize = (rect: CanvasRect) => (rect.right - rect.left) * (rect.bottom - rect.top)
const containsRect = (rect: CanvasRect, other: CanvasRect) =>
  rect.left <= other.left && rect.right >= other.right && rect.top <= other.top && rect.bottom >= other.bottom
const sameRect = (rect: CanvasRect, other: CanvasRect) => containsRect(rect, other) && containsRect(other, rect)

function readCanvasArea(stage: HTMLElement, obstacles: ReadonlySet<HTMLElement>): CanvasArea | undefined {
  const { left, top, width, height } = stage.getBoundingClientRect()
  if (width <= CANVAS_GAP * 2 || height <= CANVAS_GAP * 2 || getComputedStyle(stage).visibility === 'hidden') return
  const base: CanvasRect = { left: CANVAS_GAP, right: width - CANVAS_GAP, top: CANVAS_GAP, bottom: height - CANVAS_GAP }
  const panels: CanvasRect[] = []
  for (const obstacle of obstacles) {
    const rect = obstacle.getBoundingClientRect()
    if (!rect.width || !rect.height || rect.right <= left || rect.left >= left + width
      || rect.bottom <= top || rect.top >= top + height || getComputedStyle(obstacle).visibility === 'hidden') continue
    const edge = obstacle.dataset.canvasObstacle
    if (edge === 'top') base.top = Math.max(base.top, rect.bottom - top + CANVAS_GAP)
    else if (edge === 'bottom') base.bottom = Math.min(base.bottom, rect.top - top - CANVAS_GAP)
    else panels.push({ left: rect.left - left - CANVAS_GAP, right: rect.right - left + CANVAS_GAP,
      top: rect.top - top - CANVAS_GAP, bottom: rect.bottom - top + CANVAS_GAP })
  }
  if (base.bottom <= base.top) return
  // Keep the rectangles around each panel so an already visible node stays in place.
  let spaces = [base]
  for (const panel of panels) {
    const next = spaces.flatMap(rect => {
      if (panel.left >= rect.right || panel.right <= rect.left || panel.top >= rect.bottom || panel.bottom <= rect.top) return [rect]
      const parts = [
        { ...rect, right: panel.left }, { ...rect, left: panel.right },
        { ...rect, bottom: panel.top }, { ...rect, top: panel.bottom },
      ]
      return parts.filter(part => part.right > part.left && part.bottom > part.top)
    })
    spaces = next.filter((rect, index) => !next.some((other, i) =>
      i !== index && containsRect(other, rect) && (i < index || areaSize(other) > areaSize(rect))))
  }
  const visible = spaces.reduce<CanvasRect | undefined>((best, rect) => !best || areaSize(rect) > areaSize(best) ? rect : best, undefined)
  return visible && { stageWidth: width, base, visible, spaces }
}

function revealCanvasNode(node: RuleCanvasNode, view: RuleCanvasView, spaces: readonly CanvasRect[]): RuleCanvasView {
  const point = view.positions[node.id] ?? node
  const width = node.width ?? 216, height = node.height ?? 112
  const left = point.x * view.scale + view.x, top = point.y * view.scale + view.y
  let nearest: RuleCanvasView | undefined, distance = Infinity
  for (const rect of spaces) {
    const scale = Math.min(view.scale, (rect.right - rect.left) / width, (rect.bottom - rect.top) / height)
    if (scale < Math.min(view.scale, READABLE_SCALE) || (nearest && scale < nearest.scale)) continue
    const dx = clamp(left, rect.left, Math.max(rect.left, rect.right - width * scale)) - left
    const dy = clamp(top, rect.top, Math.max(rect.top, rect.bottom - height * scale)) - top
    const offset = Math.hypot(dx, dy)
    if (scale === view.scale && offset === 0) return view
    if (nearest && scale === nearest.scale && offset >= distance) continue
    nearest = { ...view, scale, x: left + dx - point.x * scale, y: top + dy - point.y * scale }
    distance = offset
  }
  return nearest ?? view
}

export function instructionNodes(files: readonly CanvasInstructionFile[], activeId: string | undefined, columns: number, beforeY?: number): RuleCanvasNode[] {
  const top = beforeY === undefined ? 0 : beforeY - Math.ceil(files.length / columns) * fileStride - FILE_GAP
  return files.map((instruction, index) => ({
    id: `instruction:${instruction.id}`, title: instruction.name, instruction,
    selected: instruction.id === activeId,
    x: index % columns * (FILE_WIDTH + FILE_GAP), y: top + Math.floor(index / columns) * fileStride,
    width: FILE_WIDTH, height: FILE_HEIGHT,
  }))
}

export function fitCanvasView(nodes: readonly RuleCanvasNode[], view: RuleCanvasView, width: number, height: number,
  padding: { left: number; right: number; top: number; bottom: number }): RuleCanvasView {
  let left = 0, top = 0, right = 216, bottom = 112
  for (const node of nodes) {
    const point = view.positions[node.id] ?? node
    left = Math.min(left, point.x)
    top = Math.min(top, point.y)
    right = Math.max(right, point.x + (node.width ?? 216))
    bottom = Math.max(bottom, point.y + (node.height ?? 112))
  }
  const horizontal = Math.max(1, width - padding.left - padding.right), vertical = Math.max(1, height - padding.top - padding.bottom)
  const scale = Math.min(1, horizontal / (right - left), vertical / (bottom - top))
  return { ...view, scale, x: padding.left + (horizontal - (right - left) * scale) / 2 - left * scale,
    y: padding.top + (vertical - (bottom - top) * scale) / 2 - top * scale }
}

export function InstructionCanvas({ t, files, activeId, onSelect, onPaneClick }: {
  t: PromptToolTranslate
  files: readonly CanvasInstructionFile[]
  activeId?: string
  onSelect: (id: string) => void
  onPaneClick: () => void
}): ReactNode {
  const [view, setView] = useState<RuleCanvasView>({ scale: 1, x: 12, y: 72, positions: {} })
  return <div className={css.instructionsOnly}>
    <RuleCanvas t={t} nodes={EMPTY_NODES} instructionFiles={files} activeInstructionId={activeId} view={view} onViewChange={setView}
      onSelect={onSelect} onSelectInstruction={onSelect} onPaneClick={onPaneClick} />
  </div>
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const EMPTY_NODES: readonly RuleCanvasNode[] = []
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
  const dock = useRef<HTMLDivElement>(null)
  const [area, setArea] = useState<CanvasArea>()
  const firstFit = useRef(!props.hasStoredView)
  const userAdjustedView = useRef(Boolean(props.hasStoredView))
  const fitIncludedFiles = useRef(false)
  const previousTarget = useRef<{ id?: string; ruleId?: string; area?: CanvasArea }>({})
  const [instructionColumns, setInstructionColumns] = useState<number>()
  const columns = instructionColumns ?? clamp(Math.floor(((area?.stageWidth ?? 0) - 2 * CANVAS_GAP + FILE_GAP) / (FILE_WIDTH + FILE_GAP)), 1, 3)
  const fileNodes = useMemo(() => props.instructionFiles
    ? instructionNodes(props.instructionFiles, props.activeInstructionId, columns) : props.fileNodes ?? EMPTY_NODES,
  [props.instructionFiles, props.activeInstructionId, props.fileNodes, columns])
  const adjustView = (view: RuleCanvasView) => {
    userAdjustedView.current = true
    props.onViewChange(view)
  }
  useLayoutEffect(() => {
    const element = stage.current, controls = dock.current
    if (!element || !controls) return
    const root = element.closest('[data-canvas-workspace]') ?? element.parentElement
    if (!root) return
    let obstacles = new Set<HTMLElement>()
    const measure = () => {
      const next = readCanvasArea(element, obstacles)
      setArea(current => current && next && current.stageWidth === next.stageWidth && sameRect(current.base, next.base)
        && current.spaces.length === next.spaces.length
        && current.spaces.every((rect, index) => sameRect(rect, next.spaces[index]!)) ? current : next)
    }
    const resize = new ResizeObserver(measure)
    const observeObstacles = () => {
      const next = new Set([controls, ...root.querySelectorAll<HTMLElement>(OBSTACLE)])
      for (const item of obstacles) if (!next.has(item)) resize.unobserve(item)
      for (const item of next) if (!obstacles.has(item)) resize.observe(item)
      obstacles = next
    }
    const mutation = new MutationObserver(records => {
      const changed = records.some(({ target, addedNodes, removedNodes, type }) => {
        if (!(target instanceof Element) || element.contains(target)) return false
        if (type === 'attributes') return target.matches(OBSTACLE)
        if (target.closest(OBSTACLE)) return false
        return [...addedNodes, ...removedNodes].some(node => node instanceof Element && (node.matches(OBSTACLE) || node.querySelector(OBSTACLE)))
      })
      if (!changed) return
      observeObstacles()
      measure()
    })
    observeObstacles()
    resize.observe(element)
    mutation.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] })
    measure()
    return () => { resize.disconnect(); mutation.disconnect() }
  }, [])
  const drag = useRef<{ id?: string; pointerId: number; startX: number; startY: number; baseX: number; baseY: number; moved: boolean; dismissOnClick: boolean }>()
  const suppressClick = useRef(false)
  const paneClick = useRef(false)
  const [dropTarget, setDropTarget] = useState<string>()
  const [legendOpen, setLegendOpen] = useState(false)
  const [keysOpen, setKeysOpen] = useState(false)
  const keysId = useId(), legendId = useId()
  const keysButton = useRef<HTMLButtonElement>(null)
  const legendButton = useRef<HTMLButtonElement>(null)
  const toolbar = useRef<HTMLDivElement>(null)
  const activeControl = useRef<HTMLButtonElement>()
  const nativeFocusGroup = typeof HTMLElement !== 'undefined' && 'focusGroup' in HTMLElement.prototype
  const visibleControls = (bar: HTMLDivElement) => Array.from(bar.querySelectorAll('button'))
    .filter(button => button.getClientRects().length > 0)
  const setActiveControl = (bar: HTMLDivElement, target?: HTMLButtonElement) => {
    const buttons = visibleControls(bar)
    const next = target && buttons.includes(target) ? target : buttons[0]
    activeControl.current = next
    for (const button of bar.querySelectorAll('button')) button.tabIndex = button === next ? 0 : -1
  }
  useLayoutEffect(() => {
    const bar = toolbar.current
    if (nativeFocusGroup || !bar) return
    const sync = () => setActiveControl(bar, activeControl.current)
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(bar)
    return () => observer.disconnect()
  }, [nativeFocusGroup])
  const { t } = props
  const zoom = (delta: number) => {
    const viewport = stage.current
    if (!viewport) return
    const { x, y, scale } = props.view
    const next = clamp(scale + delta, Math.min(scale, 0.35), 2.5)
    const cx = viewport.clientWidth / 2, cy = viewport.clientHeight / 2
    adjustView({ ...props.view, scale: next, x: cx - (cx - x) * next / scale, y: cy - (cy - y) * next / scale })
  }
  useEffect(() => {
    const element = stage.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      const oldScale = props.view.scale
      const next = clamp(oldScale * Math.exp(-event.deltaY * 0.001), Math.min(oldScale, 0.35), 2.5)
      const localX = event.clientX - rect.left, localY = event.clientY - rect.top
      const worldX = (localX - props.view.x) / oldScale, worldY = (localY - props.view.y) / oldScale
      userAdjustedView.current = true
      props.onViewChange({ ...props.view, scale: next, x: localX - worldX * next, y: localY - worldY * next })
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [props.view, props.onViewChange])
  const byId = useMemo(() => new Map(props.nodes.map(node => {
    const position = props.view.positions[node.id]
    return [node.id, position ? { ...node, ...position } : node]
  })), [props.nodes, props.view.positions])
  const regions = useMemo(() => new Map(props.nodes.flatMap(node => {
    if (!node.region) return []
    const position = byId.get(node.id) ?? node
    const members = node.members?.flatMap(id => { const member = byId.get(id); return member ? [member] : [] })
    if (!members?.length) return [[node.id, { left: position.x, top: position.y, width: node.width, height: node.height }]] as const
    const left = Math.min(...members.map(item => item.x)), top = Math.min(...members.map(item => item.y))
    return [[node.id, {
      left: left - 16, top: top - 56,
      width: Math.max(...members.map(item => item.x + (item.width ?? 216))) - left + 32,
      height: Math.max(...members.map(item => item.y + (item.height ?? 112))) - top + 72,
    }]] as const
  })), [props.nodes, byId])
  const fit = (area: CanvasArea, automatic: boolean) => {
    const { visible, base, stageWidth } = area
    const nodes = props.nodes.map(node => {
      const region = regions.get(node.id)
      return region ? { ...node, x: region.left, y: region.top, width: region.width, height: region.height } : node
    })
    const view = fitCanvasView([...nodes, ...fileNodes], props.view, visible.right, visible.bottom,
      { left: visible.left, right: 0, top: visible.top, bottom: 0 })
    if (!automatic || stageWidth > 480 || view.scale >= READABLE_SCALE) return view
    const anchor = fileNodes.find(node => node.selected) ?? nodes.find(node => node.id === props.selectedNodeId && !node.region)
      ?? nodes.find(node => !node.region) ?? fileNodes[0]
    if (!anchor) return view
    const point = props.view.positions[anchor.id] ?? anchor
    const rect = (visible.right - visible.left) >= READABLE_SCALE * (anchor.width ?? 216)
      && (visible.bottom - visible.top) >= READABLE_SCALE * (anchor.height ?? 112) ? visible : base
    return { ...view, scale: READABLE_SCALE,
      x: (rect.left + rect.right - (anchor.width ?? 216) * READABLE_SCALE) / 2 - point.x * READABLE_SCALE,
      y: (rect.top + rect.bottom - (anchor.height ?? 112) * READABLE_SCALE) / 2 - point.y * READABLE_SCALE }
  }
  const fitManually = () => {
    if (area) adjustView(fit(area, false))
  }
  useLayoutEffect(() => {
    if (!area || drag.current) return
    if (!userAdjustedView.current && (firstFit.current || (!fitIncludedFiles.current && fileNodes.length))
      && (props.nodes.length || fileNodes.length)) {
      firstFit.current = false
      fitIncludedFiles.current = fileNodes.length > 0
      if (props.instructionFiles) setInstructionColumns(columns)
      props.onViewChange(fit(area, true))
      return
    }
    const id = props.activeInstructionId !== undefined ? `instruction:${props.activeInstructionId}` : props.selectedNodeId
    const previous = previousTarget.current
    if (id === previous.id && props.selectedNodeId === previous.ruleId && area === previous.area) return
    previousTarget.current = { id, ruleId: props.selectedNodeId, area }
    if (props.activeInstructionId === undefined && previous.id?.startsWith('instruction:') && previous.ruleId === id) return
    if (!id || (id === previous.id && previous.area?.spaces.every(old => area.spaces.some(rect => containsRect(rect, old))))) return
    const node = props.activeInstructionId !== undefined ? fileNodes.find(item => item.id === id) : byId.get(id)
    if (!node) return
    const next = revealCanvasNode(node, props.view, area.spaces)
    if (next !== props.view) props.onViewChange(next)
  })
  const inspectingInstruction = props.activeInstructionId !== undefined
  const edges = useMemo(() => {
    if (!props.edges?.length) return null
    const hasSelection = !inspectingInstruction && props.nodes.some(node => node.selected)
    let flowCount = 0
    return <svg className={css.edges} aria-hidden="true">{props.edges.map(edge => {
      const from = byId.get(edge.from), to = byId.get(edge.to)
      if (!from || !to) return null
      const x1 = from.x + 216, y1 = from.y + 50, x2 = to.x, y2 = to.y + 50
      const path = x2 > x1 ? roundedRoute([[x1, y1], [(x1 + x2) / 2, y1], [(x1 + x2) / 2, y2], [x2, y2]])
        : roundedRoute([[x1, y1], [x1 + 24, y1], [x1 + 24, Math.min(y1, y2) - 24], [x2 - 24, Math.min(y1, y2) - 24], [x2 - 24, y2], [x2, y2]])
      const active = hasSelection && (from.selected || to.selected)
      const showFlow = active && flowCount < MAX_FLOW_EDGES
      if (showFlow) flowCount++
      const labelX = (x1 + x2) / 2, labelY = (y1 + y2) / 2
      return <g key={`${edge.from}-${edge.to}`} className={edge.kind ? css[edge.kind] : undefined} data-emphasis={active ? 'active' : hasSelection ? 'inactive' : undefined}>
        <path d={path} />
        {showFlow && <EdgeFlow key={from.selected ? from.id : to.id} path={path} />}
        <circle className={css.outPort} cx={x1} cy={y1} r="5" /><circle className={css.inPort} cx={x2} cy={y2} r="5" />
        {edge.label && <g className={css.edgeLabel}><rect x={labelX - edge.label.length * 3.5 - 8} y={labelY - 10} width={edge.label.length * 7 + 16} height="20" rx="10" /><text x={labelX} y={labelY}>{edge.label}</text></g>}
      </g>
    })}</svg>
  }, [props.edges, props.nodes, byId, inspectingInstruction])
  const begin = (event: ReactPointerEvent<HTMLElement>, node?: RuleCanvasNode) => {
    if (event.button !== 0) return
    paneClick.current = false
    const point = node ? props.view.positions[node.id] ?? node : undefined
    const dismissOnClick = !node && !document.activeElement?.closest('[role="menu"], [popover]')
    drag.current = { id: node?.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, baseX: point?.x ?? props.view.x, baseY: point?.y ?? props.view.y, moved: false, dismissOnClick }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    if (!current.moved && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 4) return
    current.moved = true
    const dx = (event.clientX - current.startX) / props.view.scale
    const dy = (event.clientY - current.startY) / props.view.scale
    if (current.id) {
      userAdjustedView.current = true
      props.onMove?.(current.id, current.baseX + dx, current.baseY + dy)
    } else adjustView({ ...props.view, x: current.baseX + event.clientX - current.startX, y: current.baseY + event.clientY - current.startY })
  }
  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (current?.pointerId !== event.pointerId) return
    suppressClick.current = current.moved
    paneClick.current = current.dismissOnClick && !current.moved
      && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 4
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
    onClick={event => {
      if (!paneClick.current) return
      paneClick.current = false
      if (event.detail === 0) return
      // 捕获指针会把点击重定向到画布，检查松手处是否仍是背景。
      const hit = document.elementFromPoint(event.clientX, event.clientY)
      if (hit && stage.current?.contains(hit) && !hit.closest('[data-rule-node]')) props.onPaneClick()
    }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(undefined) }}
    onDragOver={event => { const id = (event.target as HTMLElement).closest<HTMLElement>('[data-canvas-target]')?.dataset.canvasTarget; const valid = id && event.dataTransfer.types.includes('application/x-prompt-tool-rule-node') && props.canDropNode?.(id, ''); setDropTarget(valid ? id : undefined); if (valid) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' } }}
    onDrop={event => { setDropTarget(undefined); const target = (event.target as HTMLElement).closest<HTMLElement>('[data-canvas-target]')?.dataset.canvasTarget; const data = event.dataTransfer.getData('application/x-prompt-tool-rule-node'); if (target && props.canDropNode?.(target, data)) { event.preventDefault(); props.onDropNode?.(target, data) } }}>
    <div ref={stage} className={css.stage} data-rule-stage tabIndex={0} role="group" aria-label={t('canvas.pan')} onKeyDown={event => {
      if (event.target !== event.currentTarget || event.nativeEvent.isComposing) return
      const distance = event.shiftKey ? 120 : 40
      const offsets: Record<string, [number, number]> = { ArrowLeft: [-distance, 0], ArrowRight: [distance, 0], ArrowUp: [0, -distance], ArrowDown: [0, distance] }
      const offset = offsets[event.key]
      if (!offset) return
      event.preventDefault()
      adjustView({ ...props.view, x: props.view.x + offset[0], y: props.view.y + offset[1] })
    }}>
    <div className={css.world} style={{ transform: `translate(${props.view.x}px, ${props.view.y}px) scale(${props.view.scale})` }}>
      {edges}
      {fileNodes.map(node => {
          const file = node.instruction
          if (!file) return null
          return <button key={node.id} type="button" className={css.instructionCard} data-rule-node={node.id}
            data-instruction-file-id={file.id} data-enabled={file.enabled} aria-pressed={node.selected}
            style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
            onPointerDown={event => event.stopPropagation()} onClick={() => props.onSelectInstruction?.(file.id)}>
            <span className={css.fileMark} aria-hidden="true">MD</span>
            <span className={css.fileCopy}><strong>{file.name}</strong><small>{file.path}</small>
              {file.summary && <span>{file.summary}</span>}</span>
          </button>
      })}
      {props.nodes.map(node => {
        const position = byId.get(node.id) ?? node
        if (node.region) return <button key={node.id} type="button" className={css.region} data-rule-node={node.id} data-canvas-target={node.dropTarget}
          data-drop-ready={node.dropTarget === dropTarget || undefined} aria-pressed={node.selected} onClick={() => props.onSelect(node.id)}
          onPointerDown={event => event.stopPropagation()} style={regions.get(node.id)}><strong>{node.title}</strong></button>
        return <button key={node.id} type="button" className={css.node} data-rule-node={node.id} data-node-kind={node.kind ?? 'condition'} data-canvas-target={node.dropTarget} data-drop-ready={node.dropTarget !== undefined && node.dropTarget === dropTarget || undefined} aria-pressed={node.selected} aria-description="方向键移动节点；Enter 编辑属性" style={{ left: position.x, top: position.y, width: node.width ?? 216 }} onClick={event => { if (event.detail === 0 || !suppressClick.current) props.onSelect(node.id); suppressClick.current = false }} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          const delta = event.shiftKey ? 40 : 16
          const offsets: Record<string, [number, number]> = { ArrowLeft: [-delta, 0], ArrowRight: [delta, 0], ArrowUp: [0, -delta], ArrowDown: [0, delta] }
          const offset = offsets[event.key]
          if (offset && props.onMove) { event.preventDefault(); userAdjustedView.current = true; const point = props.view.positions[node.id] ?? node; props.onMove(node.id, point.x + offset[0], point.y + offset[1]) }
        }} onPointerDown={event => { event.stopPropagation(); begin(event, node) }}>
          <small>{node.kind === 'action' ? '动作' : node.kind === 'group' ? '分组' : '条件'}</small><strong>{node.title}</strong>{node.value && <span>{node.value}</span>}
        </button>
      })}
      {props.children}
    </div>
    </div>
    <div ref={dock} className={css.dock} data-canvas-obstacle="bottom" onPointerDown={event => event.stopPropagation()}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { setKeysOpen(false); setLegendOpen(false) } }}
      onKeyDown={event => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing || (!keysOpen && !legendOpen)) return
        event.stopPropagation()
        ;(keysOpen ? keysButton : legendButton).current?.focus()
        setKeysOpen(false); setLegendOpen(false)
      }}>
      <div ref={toolbar} className={css.dockToolbar} role="toolbar" aria-label={t('canvas.controls')}
        {...{ focusgroup: 'toolbar wrap' }} onFocus={event => {
          if (!nativeFocusGroup && event.target instanceof HTMLButtonElement) setActiveControl(event.currentTarget, event.target)
        }} onKeyDown={event => {
          if (nativeFocusGroup || event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
          const { key, currentTarget, target } = event
          if (key !== 'Home' && key !== 'End' && key !== 'ArrowLeft' && key !== 'ArrowRight') return
          const buttons = visibleControls(currentTarget)
          if (!(target instanceof HTMLButtonElement) || buttons.length === 0) return
          const direction = getComputedStyle(currentTarget).direction === 'rtl' ? -1 : 1
          const index = buttons.indexOf(target)
          const next = key === 'Home' ? 0 : key === 'End' ? buttons.length - 1
            : (index + (key === 'ArrowRight' ? direction : -direction) + buttons.length) % buttons.length
          event.preventDefault()
          buttons[next]?.focus()
        }}>
      <div className={css.dockGroup} role="group" aria-label={t('canvas.zoom')}>
      <button type="button" aria-label={t('canvas.zoomOut')} title={t('canvas.zoomOut')} aria-disabled={props.view.scale <= .35} onClick={() => { if (props.view.scale > .35) zoom(-.1) }}>−</button>
      <span className={css.percent}>{props.view.scale < .01 ? '<1' : Math.round(props.view.scale * 100)}%</span>
      <button type="button" aria-label={t('canvas.zoomIn')} title={t('canvas.zoomIn')} aria-disabled={props.view.scale >= 2.5} onClick={() => { if (props.view.scale < 2.5) zoom(.1) }}>+</button>
      <button type="button" aria-label={t('canvas.fit')} title={t('canvas.fit')} onClick={event => { event.stopPropagation(); fitManually() }}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 7V3h4m6 0h4v4m0 6v4h-4m-6 0H3v-4"/></svg></button>
      </div>
      <span className={css.dockSeparator} role="separator" aria-orientation="vertical" />
      <button type="button" ref={keysButton} aria-label={t('canvas.keys')} title={t('canvas.keys')} aria-expanded={keysOpen} aria-controls={keysId} onClick={() => { setKeysOpen(!keysOpen); setLegendOpen(false) }}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 5.5h16v9H2zM5 8.5h1m2 0h1m2 0h1m2 0h1m-9 3h8"/></svg></button>
      {props.edges && <button type="button" ref={legendButton} className={css.legendToggle} aria-controls={legendId} aria-expanded={legendOpen} onClick={() => { setLegendOpen(!legendOpen); setKeysOpen(false) }}>{t('canvas.legend')}</button>}
      </div>
      <div className={css.keysPanel} id={keysId} hidden={!keysOpen}>
        <p><kbd>↑ ↓ ← →</kbd> {t('canvas.pan')}</p><p><kbd>Shift</kbd> {t('canvas.panFast')}</p>
        <button type="button" onClick={() => {
          if (props.edges) adjustView({ scale: .8, x: 260, y: 110, positions: {} })
          else fitManually()
          setKeysOpen(false); keysButton.current?.focus()
        }}>{t('canvas.reset')}</button>
      </div>
      {props.edges && <div className={css.legend} id={legendId} data-open={legendOpen || undefined} aria-label={t('canvas.legend')}>
        <span className={css.condition}><i />{t('canvas.condition')}</span><span className={css.then}><i />THEN</span><span className={css.else}><i />ELSE</span>
        <span className={css.order} title={t('canvas.orderHint')}><i />{t('canvas.order')}</span>
        <span className={css.inKey}>{t('canvas.in')}</span><span className={css.outKey}>{t('canvas.out')}</span>
      </div>}
    </div>
  </div>
}
