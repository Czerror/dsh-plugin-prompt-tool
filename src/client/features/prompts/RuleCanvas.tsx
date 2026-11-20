import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { PromptToolTranslate } from '../../locales.ts'
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
  edges?: readonly RuleCanvasEdge[]
  view: RuleCanvasView
  onViewChange: (view: RuleCanvasView) => void
  onSelect: (id: string) => void
  onSelectInstruction?: (id: string) => void
  onPaneClick: () => void
  onMove?: (id: string, x: number, y: number) => void
  onFit?: () => void
  canDropNode?: (targetId: string, data: string) => boolean
  onDropNode?: (targetId: string, data: string) => void
  children?: ReactNode
}

const FILE_WIDTH = 236
const FILE_HEIGHT = 96
const FILE_GAP = 24
const fileStride = FILE_HEIGHT + FILE_GAP

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
  const surface = useRef<HTMLDivElement>(null)
  const initialized = useRef(false)
  const [columns, setColumns] = useState(1)
  const [view, setView] = useState<RuleCanvasView>({ scale: 1, x: 12, y: 72, positions: {} })
  const nodes = useMemo(() => instructionNodes(files, activeId, columns), [files, activeId, columns])
  const fit = () => {
    const stage = surface.current
    if (!stage?.clientWidth || !stage.clientHeight || !files.length) return
    const width = stage.clientWidth, height = stage.clientHeight
    const nextColumns = clamp(Math.floor((width - 24 + FILE_GAP) / (FILE_WIDTH + FILE_GAP)), 1, 3)
    const fitted = nextColumns === columns ? nodes : instructionNodes(files, activeId, nextColumns)
    initialized.current = true
    setColumns(nextColumns)
    setView(current => fitCanvasView(fitted, current, width, height,
      { left: 12, right: 12, top: 72, bottom: 68 }))
  }
  useLayoutEffect(() => {
    if (initialized.current || !surface.current || !files.length) return
    fit()
    if (initialized.current) return
    const observer = new ResizeObserver(() => { fit(); if (initialized.current) observer.disconnect() })
    observer.observe(surface.current)
    return () => observer.disconnect()
  })
  return <div className={css.instructionsOnly} ref={surface}>
    <RuleCanvas t={t} nodes={EMPTY_NODES} fileNodes={nodes} view={view} onViewChange={setView}
      onSelect={onSelect} onSelectInstruction={onSelect} onPaneClick={onPaneClick} onFit={fit} />
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
    props.onViewChange({ ...props.view, scale: next, x: cx - (cx - x) * next / scale, y: cy - (cy - y) * next / scale })
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
  const edges = useMemo(() => {
    if (!props.edges?.length) return null
    const hasSelection = props.nodes.some(node => node.selected)
    return <svg className={css.edges} aria-hidden="true">{props.edges.map(edge => {
      const from = byId.get(edge.from), to = byId.get(edge.to)
      if (!from || !to) return null
      const x1 = from.x + 216, y1 = from.y + 50, x2 = to.x, y2 = to.y + 50
      const path = x2 > x1 ? roundedRoute([[x1, y1], [(x1 + x2) / 2, y1], [(x1 + x2) / 2, y2], [x2, y2]])
        : roundedRoute([[x1, y1], [x1 + 24, y1], [x1 + 24, Math.min(y1, y2) - 24], [x2 - 24, Math.min(y1, y2) - 24], [x2 - 24, y2], [x2, y2]])
      const active = from.selected || to.selected
      const labelX = (x1 + x2) / 2, labelY = (y1 + y2) / 2
      return <g key={`${edge.from}-${edge.to}`} className={edge.kind ? css[edge.kind] : undefined} data-emphasis={active ? 'active' : hasSelection ? 'inactive' : undefined}>
        <path d={path} />
        <circle className={css.outPort} cx={x1} cy={y1} r="5" /><circle className={css.inPort} cx={x2} cy={y2} r="5" />
        {edge.label && <g className={css.edgeLabel}><rect x={labelX - edge.label.length * 3.5 - 8} y={labelY - 10} width={edge.label.length * 7 + 16} height="20" rx="10" /><text x={labelX} y={labelY}>{edge.label}</text></g>}
      </g>
    })}</svg>
  }, [props.edges, props.nodes, byId])
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
    if (current.id) props.onMove?.(current.id, current.baseX + dx, current.baseY + dy)
    else props.onViewChange({ ...props.view, x: current.baseX + event.clientX - current.startX, y: current.baseY + event.clientY - current.startY })
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
      props.onViewChange({ ...props.view, x: props.view.x + offset[0], y: props.view.y + offset[1] })
    }}>
    <div className={css.world} style={{ transform: `translate(${props.view.x}px, ${props.view.y}px) scale(${props.view.scale})` }}>
      {edges}
      {props.fileNodes?.map(node => {
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
          if (offset) { event.preventDefault(); const point = props.view.positions[node.id] ?? node; props.onMove?.(node.id, point.x + offset[0], point.y + offset[1]) }
        }} onPointerDown={event => { event.stopPropagation(); begin(event, node) }}>
          <small>{node.kind === 'action' ? '动作' : node.kind === 'group' ? '分组' : '条件'}</small><strong>{node.title}</strong>{node.value && <span>{node.value}</span>}
        </button>
      })}
      {props.children}
    </div>
    </div>
    <div className={css.dock} onPointerDown={event => event.stopPropagation()}
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
      <button type="button" aria-label={t('canvas.fit')} title={t('canvas.fit')} onClick={props.onFit}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 7V3h4m6 0h4v4m0 6v4h-4m-6 0H3v-4"/></svg></button>
      </div>
      <span className={css.dockSeparator} role="separator" aria-orientation="vertical" />
      <button type="button" ref={keysButton} aria-label={t('canvas.keys')} title={t('canvas.keys')} aria-expanded={keysOpen} aria-controls={keysId} onClick={() => { setKeysOpen(!keysOpen); setLegendOpen(false) }}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 5.5h16v9H2zM5 8.5h1m2 0h1m2 0h1m2 0h1m-9 3h8"/></svg></button>
      {props.edges && <button type="button" ref={legendButton} className={css.legendToggle} aria-controls={legendId} aria-expanded={legendOpen} onClick={() => { setLegendOpen(!legendOpen); setKeysOpen(false) }}>{t('canvas.legend')}</button>}
      </div>
      <div className={css.keysPanel} id={keysId} hidden={!keysOpen}>
        <p><kbd>↑ ↓ ← →</kbd> {t('canvas.pan')}</p><p><kbd>Shift</kbd> {t('canvas.panFast')}</p>
        <button type="button" onClick={() => {
          if (props.edges) props.onViewChange({ scale: .8, x: 260, y: 110, positions: {} })
          else props.onFit?.()
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
