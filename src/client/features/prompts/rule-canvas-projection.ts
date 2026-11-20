import type { RuleAction, RuleCondition, RuleDefinition, RuleEditorMeta } from '../../../shared/rules.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { actionSummary, conditionSummary, isActionNode, isBranchNode, nodeList, type RuleNode } from './rule-steps.ts'
import type { RuleCanvasEdge, RuleCanvasNode } from './RuleCanvas.tsx'
import { triggerLabel } from './rule-labels.ts'

export type RuleCanvasDescriptor =
  | { kind: 'condition'; path: string; value: RuleCondition }
  | { kind: 'action'; path: string; actionId: string; value: RuleAction }
  | { kind: 'branch'; path: string; value: Record<string, unknown> }
  | { kind: 'unknown'; path: string; value: unknown }
  | { kind: 'group'; path: string; value?: RuleCondition }

export interface RuleCanvasTarget { id: string; label: string; kind: 'condition' | 'then' | 'else'; path: string; executionPoint?: string }
export interface RuleCanvasProjection {
  nodes: RuleCanvasNode[]
  edges: RuleCanvasEdge[]
  descriptors: Map<string, RuleCanvasDescriptor>
  targets: RuleCanvasTarget[]
}
export interface RuleCanvasIdentityRegistry { get(path: string): string; clearPrefix?(path: string): void }
export type ResolveRuleExecution = (action: RuleAction, rule: RuleDefinition) => { channel: string; phase: string; lifecycle?: string } | undefined

function pointKey(point: ReturnType<ResolveRuleExecution>): string {
  return point === undefined ? '' : `${point.channel}\u0000${point.phase}\u0000${point.lifecycle ?? 'event'}`
}

export function projectRuleCanvas(input: {
  rule: RuleDefinition
  meta: RuleEditorMeta
  t: PromptToolTranslate
  resolveExecution: ResolveRuleExecution
  identity: RuleCanvasIdentityRegistry
}): RuleCanvasProjection {
  const { rule, t, identity } = input
  const nodes: RuleCanvasNode[] = []
  const edges: RuleCanvasEdge[] = []
  const descriptors = new Map<string, RuleCanvasDescriptor>()
  const targets: RuleCanvasTarget[] = []
  const groupId = (path: string) => `group:${identity.get(path)}`
  const addNode = (node: RuleCanvasNode, descriptor: RuleCanvasDescriptor) => { nodes.push(node); descriptors.set(node.id, descriptor) }
  const executionLanes = new Map<string, number>()
  const laneX = (key: string): number => {
    let index = executionLanes.get(key)
    if (index === undefined) { index = executionLanes.size; executionLanes.set(key, index) }
    return 680 + index * 280
  }
  let y = 48
  const addCondition = (condition: RuleCondition | undefined, path: string, parent?: string, parentKind?: string, depth = 0): string => {
    const keys = Object.keys(condition ?? {})
    const kind = keys.length === 1 ? keys[0]! : undefined
    const value = kind === undefined || condition === undefined ? undefined : (condition as Record<string, unknown>)[kind]
    const validComposite = kind === 'not' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : kind === 'all' || kind === 'any' || kind === 'notAny' ? Array.isArray(value) && value.every(child => child !== null && typeof child === 'object' && !Array.isArray(child)) : false
    const composite = validComposite
    const invalidComposite = (kind === 'not' || kind === 'all' || kind === 'any' || kind === 'notAny') && !validComposite
    const id = composite ? groupId(path) : invalidComposite ? `unknown-condition:${identity.get(path)}` : `condition:${identity.get(path)}`
    const x = 40 - depth * 280
    addNode({ id, title: composite ? (kind === 'all' ? 'AND' : kind === 'any' ? 'OR' : kind === 'notAny' ? 'NOT ANY' : 'NOT') : condition === undefined ? '无条件' : kind ? triggerLabel(t, kind) : t('rules.steps.unknown'),
      value: composite ? undefined : invalidComposite ? '原文保留' : condition === undefined ? undefined : conditionSummary(t, condition), x, y, width: 216, height: 112, kind: composite ? 'group' : 'condition' },
    composite ? { kind: 'group', path, value: condition } : invalidComposite ? { kind: 'unknown', path, value: condition } : { kind: 'condition', path, value: condition ?? {} })
    if (parent) edges.push({ from: id, to: parent, label: parentKind === 'not' ? '否定' : parentKind === 'any' ? '任一' : parentKind === 'notAny' ? '均不' : '全部', kind: 'condition' })
    if (!invalidComposite) targets.push({ id: `${id}:target`, label: composite ? '条件组' : '条件', kind: 'condition', path })
    y += 136
    if (composite && value !== undefined) {
      const children = kind === 'not' ? [value] : value as unknown[]
      children.forEach((child, index) => addCondition(child as RuleCondition, `${path}:${kind}:${index}`, id, kind, depth + 1))
    }
    return id
  }
  const rootCondition = addCondition(rule.if, 'if')
  const addActions = (items: readonly RuleNode[], path: string, branchId: string, branchKind: 'then' | 'else', startY: number): number => {
    const byPoint = new Map<string, Array<{ id: string; index: number }>>()
    const unknowns: Array<{ id: string; index: number }> = []
    const branches: Array<{ node: Record<string, unknown>; path: string; id: string; conditionId: string }> = []
    for (const [index, item] of items.entries()) {
      const nodePath = `${path}:${index}`
      if (isActionNode(item)) {
        const point = input.resolveExecution(item, rule)
        const execution = point === undefined ? `unknown:${nodePath}` : pointKey(point)
        const id = `action:${item.id}`
        const executionLabel = point === undefined ? '执行点未知' : `${point.channel} · ${point.phase}`
        const sequence = byPoint.get(execution) ?? []
        sequence.push({ id, index }); byPoint.set(execution, sequence)
        if (point !== undefined) targets.push({ id: `${id}:target`, label: `${branchKind === 'then' ? '成立' : '否则'} · ${executionLabel}`, kind: branchKind, path, executionPoint: execution })
      } else if (isBranchNode(item)) {
        const branch = item as Record<string, unknown>
        const id = `branch:${identity.get(nodePath)}`
        const conditionId = addCondition(branch.if as RuleCondition | undefined, `${nodePath}:if`)
        branches.push({ node: branch, path: nodePath, id, conditionId })
      } else {
        const id = `unknown:${identity.get(nodePath)}`
        unknowns.push({ id, index })
        descriptors.set(id, { kind: 'unknown', path: nodePath, value: item })
      }
    }
    for (const [execution, sequence] of byPoint) {
      const x = laneX(execution || `unknown:${path}:${sequence[0]!.index}`)
      const laneId = `lane:${identity.get(`${path}:${execution}`)}`
      const laneLabel = execution.startsWith('unknown:') ? '执行点未知' : execution.replaceAll('\u0000', ' · ')
      addNode({ id: laneId, title: `${branchKind.toUpperCase()} · ${laneLabel}`, x: x - 16, y: startY, width: 248, height: 72 + sequence.length * 136, kind: 'group', region: true, members: sequence.map(entry => entry.id) },
        { kind: 'group', path })
      if (!execution.startsWith('unknown:')) targets.push({ id: `${laneId}:target`, label: `${branchKind === 'then' ? '成立' : '否则'} · ${laneLabel}`, kind: branchKind, path, executionPoint: execution })
      sequence.forEach((entry, order) => {
        const item = items[entry.index] as RuleAction
        const nodePath = `${path}:${entry.index}`
        const point = input.resolveExecution(item, rule)
        const id = entry.id
        addNode({ id, title: triggerLabel(t, String(item.kind)), value: actionSummary(t, item),
          x, y: startY + 56 + order * 136, width: 216, height: 112, kind: 'action' },
        { kind: 'action', path: nodePath, actionId: item.id, value: item })
        edges.push({ from: order === 0 ? branchId : sequence[order - 1]!.id, to: id, label: order === 0 ? branchKind.toUpperCase() : '同点内次序', kind: order === 0 ? branchKind : 'order' })
      })
    }
    for (const unknown of unknowns) {
      const x = laneX(`unknown:${path}:${unknown.index}`)
      const id = unknown.id
      addNode({ id, title: t('rules.steps.unknown'), value: '原文保留', x, y: startY, width: 216, height: 112, kind: 'action' }, descriptors.get(id)!)
      edges.push({ from: branchId, to: id, label: '未知结构', kind: branchKind })
    }
    let bottom = startY + 136 + [...byPoint.values()].reduce((height, sequence) => Math.max(height, sequence.length * 136), 0) + (unknowns.length ? 136 : 0)
    for (const branch of branches) {
      const branchY = bottom
      addNode({ id: branch.id, title: conditionSummary(t, branch.node.if as RuleCondition | undefined), value: '条件分支', x: 360, y: branchY, width: 216, height: 112, kind: 'condition' },
        { kind: 'branch', path: branch.path, value: branch.node })
      edges.push({ from: branchId, to: branch.conditionId, label: branchKind === 'then' ? '成立' : '否则', kind: branchKind }, { from: branch.conditionId, to: branch.id, label: '分支', kind: 'then' })
      const branchThenPath = `${branch.path}:then`, branchElsePath = `${branch.path}:else`
      const branchThenId = `scope:${branchThenPath}:${identity.get(branchThenPath)}`
      const branchThenY = branchY + 136
      addNode({ id: branchThenId, title: '成立 THEN', x: 360, y: branchThenY, width: 216, height: 112, kind: 'group' }, { kind: 'group', path: branchThenPath, value: branch.node.if as RuleCondition | undefined })
      targets.push({ id: `${branchThenId}:target`, label: '成立分支', kind: 'then', path: branchThenPath })
      edges.push({ from: branch.id, to: branchThenId, label: '成立', kind: 'then' })
      const childThen = addActions(nodeList(branch.node.then), branchThenPath, branchThenId, 'then', branchThenY + 136)
      let childElse = childThen
      if (Array.isArray(branch.node.else)) {
        const branchElseId = `scope:${branchElsePath}:${identity.get(branchElsePath)}`
        const branchElseY = childThen + 24
        addNode({ id: branchElseId, title: '否则 ELSE', x: 360, y: branchElseY, width: 216, height: 112, kind: 'group' }, { kind: 'group', path: branchElsePath, value: branch.node.if as RuleCondition | undefined })
        targets.push({ id: `${branchElseId}:target`, label: '否则分支', kind: 'else', path: branchElsePath })
        edges.push({ from: branch.id, to: branchElseId, label: '否则', kind: 'else' })
        childElse = addActions(nodeList(branch.node.else), branchElsePath, branchElseId, 'else', branchElseY + 136)
      } else targets.push({ id: `${branchElsePath}:target`, label: '创建否则分支', kind: 'else', path: branchElsePath })
      bottom = Math.max(childThen, childElse) + 32
    }
    return bottom
  }
  const thenRoot = `scope:then:${identity.get('then')}`
  addNode({ id: thenRoot, title: '成立 THEN', x: 360, y: 48, width: 216, height: 112, kind: 'group' }, { kind: 'group', path: 'then', value: rule.if })
  edges.push({ from: rootCondition, to: thenRoot, label: '成立', kind: 'then' })
  targets.push({ id: `${thenRoot}:target`, label: '成立分支', kind: 'then', path: 'then' })
  const thenBottom = addActions(nodeList(rule.then), 'then', thenRoot, 'then', 48)
  if (rule.else !== undefined) {
    const elseRoot = `scope:else:${identity.get('else')}`
    addNode({ id: elseRoot, title: '否则 ELSE', x: 360, y: thenBottom + 32, width: 216, height: 112, kind: 'group' }, { kind: 'group', path: 'else', value: rule.if })
    edges.push({ from: rootCondition, to: elseRoot, label: '否则', kind: 'else' })
    targets.push({ id: `${elseRoot}:target`, label: '否则分支', kind: 'else', path: 'else' })
    addActions(nodeList(rule.else), 'else', elseRoot, 'else', thenBottom + 168)
  } else {
    targets.push({ id: 'else:target', label: '创建否则分支', kind: 'else', path: 'else' })
  }
  const offset = Math.max(0, 40 - Math.min(...nodes.map(node => node.x)))
  if (offset) for (const node of nodes) node.x += offset
  return { nodes, edges, descriptors, targets }
}
