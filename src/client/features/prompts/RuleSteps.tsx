/**
 * 规则卡内部的条件卡视图（「一个条件一张卡，对应它的动作」）。
 *
 * 结构对应引擎真值（`engine/branch.mjs#expandActions`）：
 *   IF 卡        = 规则级条件，卡内是它的直属动作；
 *   分支卡       = `then` 里的分支节点 `{if, then, else}`，卡头即「当 ⟨条件⟩ → ⟨动作⟩」；
 *   动作卡       = 叶子动作，可展开改字段；
 *   否则卡       = 规则级 `else`。
 * 每张卡都是 TagInput 式的小卡：卡头单行摘要，展开才编辑，右侧 ↑↓ 与 × 。
 */
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { RuleAction, RuleCondition, RuleDefinition, RuleEditorMeta } from '../../../shared/rules.ts'
import type { FieldDraft } from '../../data/workspace-drafts.ts'
import type { EngineMeta } from '../../prompt-tool-types.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { Button } from '../../ui/Button.tsx'
import { SearchInput } from '../../ui/SearchInput.tsx'
import { IconChevronDownOutlineRegular, IconCopyOutlineRegular } from '../../ui/icons.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { StepCard, CloseButton, StepAdd, type StepCreation } from './RuleStepCard.tsx'
import { RuleConditionFields, RuleParameterFields, cleared } from './RuleFields.tsx'
import { AssemblyFields, MessageFilterFields, VisibilityFields } from './RuleSurfaceFields.tsx'
import { ModulePersonaCard } from './ModulePersonaCard.tsx'
import { TriggerJsonField, asTriggerRecord } from './RuleJsonField.tsx'
import { triggerLabel } from './rule-labels.ts'
import { ruleExecutionPoint } from '../../data/rule-execution-point.ts'
import { RuleCanvas, type RuleCanvasView } from './RuleCanvas.tsx'
import { projectRuleCanvas } from './rule-canvas-projection.ts'
import {
  actionSummary, branchSummary, collectActionIds, conditionChain, conditionSummary, nodeSummary,
  isActionNode, isBranchNode, nodeList, type RuleBranch, type RuleNode,
} from './rule-steps.ts'
import css from './rules.module.css'

// 条件 not 的编辑路径沿用字段 owner 的 :not:0，定义中的 not 本身并非数组。
function definitionPath(path: string): Array<string | number> {
  return path.split(':').filter((part, index, parts) => !(part === '0' && parts[index - 1] === 'not'))
    .map(part => /^\d+$/.test(part) ? Number(part) : part)
}
function valueAt(source: unknown, path: string): unknown {
  return definitionPath(path).reduce<unknown>((value, part) => value !== null && typeof value === 'object'
    ? (value as Record<string | number, unknown>)[part] : undefined, source)
}
function withValue(source: unknown, path: readonly (string | number)[], value: unknown): unknown {
  if (!path.length) return value
  const [key, ...rest] = path
  if (Array.isArray(source)) {
    const next = [...source], index = Number(key)
    const child = withValue(next[index], rest, value)
    if (child === undefined) next.splice(index, 1)
    else next[index] = child
    return next
  }
  const next = { ...asTriggerRecord(source) }
  const child = withValue(next[String(key)], rest, value)
  if (child === undefined) delete next[String(key)]
  else next[String(key)] = child
  return next
}

interface CanvasIdentity {
  next: number
  objects: WeakMap<object, string>
  paths: Map<string, { value: unknown; id: string }>
}
// 不持久化身份；按仍存在的子树引用搬迁，原位字段替换保留旧节点身份。
const canvasIdentities = new WeakMap<Map<string, RuleCanvasView>, Map<string, CanvasIdentity>>()

/** 作用域头：只声明「下面这批动作属于哪个条件」，本身没有可编辑内容。 */
function ScopeHead(props: { kindLabel: string; summary: string; disabled?: boolean; removeLabel?: string; onRemove?: () => void }): ReactNode {
  return <div className={css.scopeHead}>
    <span className={css.stepKind}>{props.kindLabel}</span>
    <span className={css.stepSummary}>{props.summary}</span>
    {props.onRemove !== undefined && props.removeLabel !== undefined && <span className={css.stepActions}>
      <CloseButton label={props.removeLabel} disabled={props.disabled} onClick={props.onRemove} />
    </span>}
  </div>
}

/** 移动 / 删除两个按钮：动作卡与分支卡共用。 */
function NodeActions(props: { t: PromptToolTranslate; id: string; index: number; total: number; disabled?: boolean; onMove: (offset: -1 | 1) => void; onRemove: () => void }): ReactNode {
  const { t } = props
  return <>
    <HintTooltip label={t('rules.moveUp', { id: props.id })}><Button shape="pill" variant="outline" icon aria-label={t('rules.moveUp', { id: props.id })} disabled={props.disabled || props.index === 0} onClick={() => props.onMove(-1)}>↑</Button></HintTooltip>
    <HintTooltip label={t('rules.moveDown', { id: props.id })}><Button shape="pill" variant="outline" icon aria-label={t('rules.moveDown', { id: props.id })} disabled={props.disabled || props.index === props.total - 1} onClick={() => props.onMove(1)}>↓</Button></HintTooltip>
    <CloseButton label={t('rules.steps.remove', { id: props.id })} disabled={props.disabled} onClick={props.onRemove} />
  </>
}

interface StepContext {
  t: PromptToolTranslate
  meta: RuleEditorMeta
  engineMeta: EngineMeta
  fields: Map<string, FieldDraft>
  expanded: Map<string, boolean>
  prefix: string
  disabled: boolean
  onDraft: () => void
  creation: StepCreation
  selected?: string
  property: NonNullable<Parameters<typeof StepCard>[0]['property']>
  select: (path: string) => void
}

const rowOpen = (context: StepContext, path: string): boolean => context.selected === path

/** 叶子动作卡：卡头是动作摘要，展开是该动作的全部字段。 */
function ActionCard(props: {
  context: StepContext
  action: RuleAction
  path: string
  chain: readonly RuleCondition[]
  /** 所处作用域是否带条件：带条件的动作必须是 event 生命周期（引擎 rule-spec.mjs:143）。 */
  scopeConditional: boolean
  index: number
  total: number
  onMove: (offset: -1 | 1) => void
  onRemove: () => void
  onChange: (action: RuleAction) => void
}): ReactNode {
  const { context, action } = props
  const { t } = context
  const entry = context.meta.actions.find(item => item.kind === action.kind)
  const fieldKey = `${props.path}:${action.id}`
  const config = asTriggerRecord(action.config), params = asTriggerRecord(config.params)
  const layer = String(config.layer ?? 'pre-step'), policy = context.engineMeta.layerFieldPolicies[layer]
  const staticAudience = layer === 'system-section' && (params.complete === true || params.suppressRuntimeContext === true)
  const example = action.kind === 'stream-output' ? { ...entry?.example, mode: 'pass', text: '' }
    : action.kind === 'request-params' ? { ...entry?.example, patch: { provider: '', model: '', reasoningEffort: '', temperature: undefined, maxTokens: undefined } }
    : action.kind === 'inject-text' ? { ...entry?.example, config: { strategy: 'static', configKind: 'ordered', ...(policy?.merge ? { mergeMode: 'separate' } : {}), ...(policy?.position ? { position: 'after-user' } : {}), ...(staticAudience ? { audience: '' } : {}), ...asTriggerRecord(entry?.example.config) } }
      : entry?.example
  const chainLabel = props.chain.length > 0 ? conditionChain(t, props.chain) : undefined
  return <StepCard kind="action" kindLabel={triggerLabel(t, String(action.kind))} summary={actionSummary(t, action)} hint={chainLabel}
    level={2} nodeKey={`action:${action.id}`} open={rowOpen(context, `action:${action.id}`)} onToggle={() => context.select(`action:${action.id}`)} property={context.property}
    actions={<NodeActions t={t} id={action.id} index={props.index} total={props.total} disabled={context.disabled} onMove={props.onMove} onRemove={props.onRemove} />}>
    {entry === undefined
      ? <><p role="note">{t('rules.unknown')}</p><TriggerJsonField {...context} label={t('rules.rawAction')} shape="object" value={action} fieldKey={fieldKey}
        onChange={next => props.onChange(asTriggerRecord(next) as unknown as RuleAction)} /></>
      : <>
        {/* 类型切换留在卡内：换类型等于换一份参数骨架，动作 id 不变。 */}
        <div className={css.row}><MenuSelect compact ariaLabel={t('triggers.actionType')} value={action.kind} disabled={context.disabled}
          options={(props.scopeConditional ? context.meta.actions.filter(item => item.supportsWhen) : context.meta.actions).map(item => ({ value: item.kind, label: triggerLabel(t, item.kind) }))}
          onChange={kind => {
            const next = context.meta.actions.find(item => item.kind === kind)
            if (next === undefined) return
            cleared(context.fields, fieldKey)
            props.onChange({ ...structuredClone(next.example), id: action.id, kind } as unknown as RuleAction)
          }} /></div>
        {action.kind === 'persona' ? <ModulePersonaCard t={t} action={action} disabled={context.disabled} context={{ ...context, fieldKey }} onChange={props.onChange} />
          : action.kind === 'assembly' ? <AssemblyFields {...context} fieldKey={fieldKey} value={action} onChange={next => props.onChange(next as RuleAction)} />
          : action.kind === 'tool-visibility' ? <VisibilityFields {...context} fieldKey={fieldKey} value={action} onChange={next => props.onChange(next as RuleAction)} />
          : action.kind === 'pre-step-filter' ? <MessageFilterFields {...context} fieldKey={fieldKey} value={action} onChange={next => props.onChange(next as RuleAction)} />
          : <div className={css.fields}><RuleParameterFields {...context} fieldKey={fieldKey} value={action} requestPatch={action.kind === 'request-params'} example={example}
          omit={['id', 'kind', ...(action.kind === 'request-params' ? ['audience', 'modelScope'] : [])]}
          configOmit={action.kind === 'inject-text' ? ['modelScope', 'promotion', ...staticAudience ? [] : ['audience']] : undefined}
          onChange={next => props.onChange({ ...next, id: action.id, kind: String(next.kind ?? action.kind) } as unknown as RuleAction)} /></div>}
      </>}
  </StepCard>
}

/** 分支卡：卡头即「当 ⟨条件⟩ → ⟨动作⟩」，卡内是本层条件 + 它的 then / else 动作。 */
function BranchCard(props: {
  context: StepContext
  branch: RuleBranch
  path: string
  chain: readonly RuleCondition[]
  index: number
  total: number
  onMove: (offset: -1 | 1) => void
  onRemove: () => void
  onChange: (branch: RuleBranch) => void
  renderList: (nodes: RuleNode[], path: string, chain: readonly RuleCondition[], scopeConditional: boolean, onChange: (nodes: RuleNode[]) => void) => ReactNode
}): ReactNode {
  const { context, branch } = props
  const { t } = context
  const branchChain = [...props.chain, ...(branch.if === undefined ? [] : [branch.if])]
  const elseChain: readonly RuleCondition[] = [...props.chain, ...(branch.if === undefined ? [] : [{ not: branch.if }])]
  const patch = (next: Partial<RuleBranch>): void => props.onChange({ ...branch, ...next })
  const ordinal = String(props.index + 1)
  return <div className={css.stepScope}>
    <StepCard kind="branch" kindLabel={t('rules.steps.branchLabel')} summary={branchSummary(t, branch)} hint={conditionChain(t, branchChain)}
    level={1} nodeKey={props.path} open={rowOpen(context, props.path)} onToggle={() => context.select(props.path)} property={context.property}
    actions={<NodeActions t={t} id={ordinal} index={props.index} total={props.total} disabled={context.disabled} onMove={props.onMove} onRemove={props.onRemove} />}>
    <RuleConditionFields {...context} fieldKey={`${props.path}:if`} meta={context.meta} value={branch.if} onChange={condition => patch({ if: condition })} />
    </StepCard>
    <p className={css.stepSlot}>{t('rules.steps.then')}</p>
    <div className={css.stepScope} data-step-scope="then">{props.renderList(nodeList(branch.then), `${props.path}:then`, branchChain, true, nodes => patch({ then: nodes }))}</div>
    <p className={css.stepSlot}>{t('rules.steps.else')}</p>
    {branch.else === undefined
      ? <div className={css.stepAdd}><Button shape="pill" variant="outline" disabled={context.disabled} onClick={() => patch({ else: [] })}>{t('rules.steps.addElse')}</Button></div>
      : <div className={css.stepScope} data-step-scope="else">{props.renderList(nodeList(branch.else), `${props.path}:else`, elseChain, true, nodes => patch({ else: nodes }))}</div>}
  </div>
}

/**
 * 规则卡的条件/动作编辑面：一个条件作用域一张卡，卡内是它对应的动作。
 * 添加沿用「选择后添加」的 tag 式交互；`then` 里的分支节点在这里成为一等公民。
 */
export function RuleStepsPanel(props: {
  t: PromptToolTranslate
  rule: RuleDefinition
  meta: RuleEditorMeta
  engineMeta: EngineMeta
  fields: Map<string, FieldDraft>
  expanded: Map<string, boolean>
  prefix: string
  fieldKey: string
  nodeBrowse?: Map<string, string>
  canvasBrowse?: Map<string, RuleCanvasView>
  browseKey: string
  libraryOpen: boolean
  libraryId: string
  onCloseLibrary: (restoreFocus: boolean) => void
  onBrowseChange?: () => void
  diagnosticActionId?: string
  disabled?: boolean
  onDraft: () => void
  onChange: (rule: RuleDefinition) => void
  onMove: (path: string, index: number, offset: -1 | 1) => void
}): ReactNode {
  const { t, rule, meta, libraryOpen, libraryId } = props
  const disabled = props.disabled === true
  const then = nodeList(rule.then), otherwise = nodeList(rule.else)
  const usedIds = collectActionIds([...then, ...otherwise])
  const diagnosticNode = props.diagnosticActionId === undefined || !usedIds.has(props.diagnosticActionId) ? undefined : `action:${props.diagnosticActionId}`
  const [addActionKind, setAddActionKind] = useState('inject-text')
  const [addConditionKind, setAddConditionKind] = useState('')
  const [activeCreation, setActiveCreation] = useState(`${props.fieldKey}:then`)
  const [localSelectedNode, selectNode] = useState(props.nodeBrowse?.get(props.browseKey))
  const selectedNode = props.onBrowseChange ? props.nodeBrowse?.get(props.browseKey) : localSelectedNode
  const [propertyTarget, setPropertyTarget] = useState<HTMLDivElement | null>(null)
  const [localView, setLocalView] = useState<RuleCanvasView>({ x: 260, y: 110, scale: 0.8, positions: {} })
  const view = props.canvasBrowse?.get(props.browseKey) ?? localView
  const needsInitialFit = useRef(!props.canvasBrowse?.has(props.browseKey))
  const changeView = (next: RuleCanvasView): void => {
    props.canvasBrowse?.set(props.browseKey, next)
    if (props.onBrowseChange) props.onBrowseChange()
    else setLocalView(next)
  }
  const localIdentity = useRef<CanvasIdentity>({ next: 0, objects: new WeakMap(), paths: new Map() })
  let identityState = localIdentity.current
  if (props.canvasBrowse) {
    let owners = canvasIdentities.get(props.canvasBrowse)
    if (!owners) { owners = new Map(); canvasIdentities.set(props.canvasBrowse, owners) }
    const existing = owners.get(props.browseKey)
    if (existing) identityState = existing
    else owners.set(props.browseKey, identityState)
  }
  const present = new WeakSet<object>()
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || present.has(value)) return
    present.add(value)
    for (const child of Object.values(value)) visit(child)
  }
  visit(rule)
  const nextPaths = new Map<string, { value: unknown; id: string }>()
  const graph = projectRuleCanvas({ rule, meta, t, resolveExecution: (action, current) => ruleExecutionPoint(action, current, meta), identity: { get: path => {
    const value = valueAt(rule, path), previous = identityState.paths.get(path)
    let id = value !== null && typeof value === 'object' ? identityState.objects.get(value) : undefined
    if (!id && previous && (previous.value === value || previous.value === null || typeof previous.value !== 'object' || !present.has(previous.value))) id = previous.id
    id ??= `node-${++identityState.next}`
    if (value !== null && typeof value === 'object') identityState.objects.set(value, id)
    nextPaths.set(path, { value, id })
    return id
  } } })
  identityState.paths = nextPaths
  const [targetId, setTargetId] = useState('')
  const [libraryItem, setLibraryItem] = useState('')
  const [libraryQuery, setLibraryQuery] = useState('')
  const [libraryCategory, setLibraryCategory] = useState<'condition' | 'action'>('condition')
  const [dragPayload, setDragPayload] = useState('')
  const propertyId = useId()
  const structureHeading = useRef<HTMLHeadingElement>(null)
  const propertyHeading = useRef<HTMLHeadingElement>(null)
  const nodeButton = useRef<HTMLButtonElement | null>(null)
  const focusPane = useRef<'structure' | 'properties'>()
  const handledDiagnosticNode = useRef<string>()
  const structureRef = useRef<HTMLDivElement>(null)
  const libraryNode = useRef<string>()
  useLayoutEffect(() => {
    const changed = selectedNode !== libraryNode.current
    libraryNode.current = selectedNode
    if (changed && selectedNode && libraryOpen && structureRef.current
      && getComputedStyle(structureRef.current).getPropertyValue('--pt-stacked-panes').trim() === '1') {
      props.onCloseLibrary(false)
    }
  })
  const revealedNode = useRef<string>()
  useLayoutEffect(() => {
    if (!selectedNode) { revealedNode.current = undefined; return }
    if (revealedNode.current === selectedNode) return
    const node = graph.nodes.find(item => item.id === selectedNode)
    const stage = structureRef.current?.querySelector<HTMLElement>('[data-rule-stage]')
    if (!node || !stage || stage.clientWidth < 896) return
    revealedNode.current = selectedNode
    const point = view.positions[node.id] ?? node
    const left = libraryOpen ? 256 : 24, right = stage.clientWidth - 356
    const top = 110, bottom = stage.clientHeight - 100
    const x = point.x * view.scale + view.x, y = point.y * view.scale + view.y
    const dx = x + 216 * view.scale > right ? right - x - 216 * view.scale : x < left ? left - x : 0
    const dy = y + 112 * view.scale > bottom ? bottom - y - 112 * view.scale : y < top ? top - y : 0
    if (dx || dy) changeView({ ...view, x: view.x + dx, y: view.y + dy })
  })
  const lastNodeKey = useRef(selectedNode)
  const select = (path: string | undefined): void => {
    if (path === undefined) props.nodeBrowse?.delete(props.browseKey)
    else props.nodeBrowse?.set(props.browseKey, path)
    if (props.onBrowseChange) props.onBrowseChange()
    else selectNode(path)
  }
  useLayoutEffect(() => {
    if (diagnosticNode !== handledDiagnosticNode.current) {
      handledDiagnosticNode.current = diagnosticNode
      if (diagnosticNode !== undefined) {
        lastNodeKey.current = diagnosticNode
        focusPane.current = 'properties'
        if (diagnosticNode !== selectedNode) { select(diagnosticNode); return }
      }
    }
    if (focusPane.current === 'properties') propertyHeading.current?.focus()
    if (focusPane.current === 'structure') {
      const previous = lastNodeKey.current === undefined ? undefined
        : structureRef.current?.querySelector<HTMLButtonElement>(`[data-rule-node="${CSS.escape(lastNodeKey.current)}"]`)
      const returnFocus = previous ?? structureHeading.current
      returnFocus?.focus()
    }
    focusPane.current = undefined
  })
  const shownNode = selectedNode?.startsWith('action:') && !usedIds.has(selectedNode.slice('action:'.length)) ? undefined : selectedNode
  const conditional = rule.if !== undefined
  const context: StepContext = {
    t, meta, engineMeta: props.engineMeta, fields: props.fields, expanded: props.expanded,
    prefix: props.prefix, disabled, onDraft: props.onDraft,
    creation: { active: activeCreation, select: setActiveCreation },
    selected: shownNode,
    select: path => {
      lastNodeKey.current = path
      focusPane.current = 'properties'
      select(path)
      if (path === selectedNode) { propertyHeading.current?.focus(); focusPane.current = undefined }
    },
    property: { target: propertyTarget, id: propertyId, focus: button => { nodeButton.current = button } },
  }
  const patch = (next: Partial<RuleDefinition>): void => { if (!disabled) props.onChange({ ...rule, ...next }) }
  const changeAt = (path: string, value: unknown): void => {
    if (!disabled) props.onChange(withValue(rule, definitionPath(path), value) as RuleDefinition)
  }
  const setNodes = (next: RuleNode[]): void => patch({ then: next as RuleAction[] })

  const nextActionId = (): string => { let number = 1; while (usedIds.has(`action-${number}`)) number++; return `action-${number}` }
  const actionSelectable = (scopeConditional: boolean) =>
    scopeConditional ? meta.actions.filter(action => action.supportsWhen) : meta.actions

  const activeTarget = graph.targets.find(target => target.id === targetId) ?? graph.targets[0]
  const selectedDescriptor = shownNode === undefined ? undefined : graph.descriptors.get(shownNode)
  const libraryKind = libraryCategory
  const libraryEntries = libraryKind === 'condition' ? meta.predicates : meta.actions
  const selectedLibraryEntry = libraryEntries.find(entry => entry.kind === libraryItem)
  const payload = (kind: 'condition' | 'action', name: string): string => JSON.stringify({ rule: props.browseKey, kind, name })
  const parsePayload = (text: string): { kind: 'condition' | 'action'; name: string } | undefined => {
    try {
      const value = JSON.parse(text) as Record<string, unknown>
      return value.rule === props.browseKey && (value.kind === 'condition' || value.kind === 'action') && typeof value.name === 'string'
        ? { kind: value.kind, name: value.name } : undefined
    } catch { return undefined }
  }
  const targetFor = (id: string) => graph.targets.find(target => target.id === id || target.id === `${id}:target`)
  const canAdd = (id: string, text: string): boolean => {
    const target = targetFor(id), item = parsePayload(text)
    if (disabled || !target || !item) return false
    if (target.kind === 'condition') return item.kind === 'condition' && meta.predicates.some(entry => entry.kind === item.name)
    if (item.kind !== 'action') return false
    const entry = meta.actions.find(entry => entry.kind === item.name)
    if (!entry || ((rule.if !== undefined || target.path.includes(':')) && !entry.supportsWhen)) return false
    if (!target.executionPoint) return true
    const point = ruleExecutionPoint({ ...entry.example, id: 'candidate', kind: entry.kind } as RuleAction, rule, meta)
    return !!point && `${point.channel}\u0000${point.phase}\u0000${point.lifecycle ?? 'event'}` === target.executionPoint
  }
  const add = (id: string, text: string): void => {
    if (!canAdd(id, text)) return
    const target = targetFor(id)!, item = parsePayload(text)!
    if (item.kind === 'condition') {
      const example = structuredClone(meta.predicates.find(entry => entry.kind === item.name)!.example)
      const previous = valueAt(rule, target.path)
      const current = asTriggerRecord(previous), kind = Object.keys(current)[0]
      changeAt(target.path, previous === undefined ? example
        : (kind === 'all' || kind === 'any' || kind === 'notAny') && Array.isArray(current[kind])
          ? { ...current, [kind]: [...current[kind] as unknown[], example] } : { all: [previous, example] })
    } else {
      const example = structuredClone(meta.actions.find(entry => entry.kind === item.name)!.example)
      const action = { ...example, id: nextActionId(), kind: item.name } as RuleAction
      changeAt(target.path, [...nodeList(valueAt(rule, target.path)), action])
      context.select(`action:${action.id}`)
    }
  }
  const dropNode = (id: string, text: string): void => {
    if (canAdd(id, text)) add(id, text)
  }

  /** 列表渲染器：动作卡与分支卡递归共用（分支内可再嵌分支）。 */
  const renderList = (nodes: RuleNode[], path: string, chain: readonly RuleCondition[], scopeConditional: boolean, onChange: (next: RuleNode[]) => void): ReactNode => {
    const setAt = (index: number, next: RuleNode): void => onChange(nodes.map((node, at) => at === index ? next : node))
    const move = (index: number, offset: -1 | 1): void => {
      if (!disabled) props.onMove(path, index, offset)
      if (!selectedNode?.startsWith('action:')) select(undefined)
    }
    const candidates = actionSelectable(scopeConditional)
    const selected = candidates.find(action => action.kind === addActionKind) ?? candidates[0]
    const addAction = (): void => { if (selected !== undefined) onChange([...nodes, { ...structuredClone(selected.example), id: nextActionId(), kind: selected.kind } as unknown as RuleNode]) }
    const addBranch = (): void => {
      const predicate = meta.predicates.find(item => item.kind === addConditionKind) ?? meta.predicates.find(item => !meta.composites.includes(item.kind))
      const action = actionSelectable(true).find(item => item.kind === addActionKind) ?? actionSelectable(true)[0]
      if (predicate === undefined || action === undefined) return
      onChange([...nodes, { if: structuredClone(predicate.example), then: [{ ...structuredClone(action.example), id: nextActionId(), kind: action.kind }] } as unknown as RuleNode])
    }
    return <>
      {nodes.map((node, index) => {
        const nodePath = `${path}:${index}`
        if (isActionNode(node)) return <ActionCard key={nodePath} context={context} action={node} path={nodePath} chain={chain} scopeConditional={scopeConditional}
          index={index} total={nodes.length} onMove={offset => move(index, offset)} onRemove={() => { cleared(props.fields, nodePath); onChange(nodes.filter((_, at) => at !== index)) }}
          onChange={next => setAt(index, next)} />
        if (isBranchNode(node)) return <BranchCard key={nodePath} context={context} branch={node} path={nodePath} chain={chain}
          index={index} total={nodes.length} onMove={offset => move(index, offset)} onRemove={() => { cleared(props.fields, nodePath); onChange(nodes.filter((_, at) => at !== index)) }}
          onChange={next => setAt(index, next)} renderList={renderList} />
        return <StepCard key={nodePath} kind="unknown" kindLabel={t('rules.steps.unknown')} summary={nodeSummary(t, node)} level={1}
          nodeKey={nodePath} open={rowOpen(context, nodePath)} onToggle={() => context.select(nodePath)} property={context.property}
          actions={<NodeActions t={t} id={String(index + 1)} index={index} total={nodes.length} disabled={disabled} onMove={offset => move(index, offset)} onRemove={() => onChange(nodes.filter((_, at) => at !== index))} />}>
          <p role="note">{t('rules.unknown')}</p>
          <TriggerJsonField {...context} label={t('rules.rawAction')} shape="object" value={node} fieldKey={nodePath}
            onChange={next => setAt(index, asTriggerRecord(next) as unknown as RuleNode)} />
        </StepCard>
      })}
      <StepAdd creation={context.creation} path={path} label={t('configList.create')} disabled={disabled}>
        <MenuSelect compact ariaLabel={t('rules.steps.addConditionType')} value={addConditionKind} disabled={disabled || candidates.length === 0}
          options={[{ value: '', label: t('triggers.unconditional') }, ...meta.predicates.map(item => ({ value: item.kind, label: triggerLabel(t, item.kind) }))]}
          onChange={setAddConditionKind} />
        <MenuSelect compact ariaLabel={t('rules.steps.addActionType')} value={selected?.kind ?? ''} disabled={disabled || candidates.length === 0}
          options={candidates.map(item => ({ value: item.kind, label: triggerLabel(t, item.kind) }))} onChange={setAddActionKind} />
        <Button shape="pill" variant="outline" disabled={disabled || addConditionKind.length === 0 || candidates.length === 0} onClick={addBranch}>{t('rules.steps.addBranch')}</Button>
        <Button shape="pill" variant="outline" disabled={disabled || selected === undefined} onClick={addAction}>{t('rules.addAction')}</Button>
      </StepAdd>
    </>
  }

  const fit = (): void => {
    const element = structureRef.current?.querySelector<HTMLElement>('[data-rule-stage]')
    if (!element?.clientWidth || !element.clientHeight) return
    const width = element.clientWidth, height = element.clientHeight
    const positions = graph.nodes.map(node => ({ ...node, ...view.positions[node.id] }))
    const left = Math.min(0, ...positions.map(node => node.x)), top = Math.min(0, ...positions.map(node => node.y))
    const right = Math.max(216, ...positions.map(node => node.x + (node.width ?? 216))), bottom = Math.max(112, ...positions.map(node => node.y + (node.height ?? 112)))
    const wide = width >= 900, safeLeft = wide && libraryOpen ? 256 : 24, safeRight = wide && shownNode ? 344 : 24
    const scale = Math.min(1, Math.max(1, width - safeLeft - safeRight) / (right - left), Math.max(1, height - 180) / (bottom - top))
    needsInitialFit.current = false
    const remainingWidth = width - safeLeft - safeRight - (right - left) * scale
    const remainingHeight = height - 180 - (bottom - top) * scale
    changeView({ ...view, scale, x: safeLeft + Math.max(0, remainingWidth / 2) - left * scale,
      y: 100 + Math.max(0, remainingHeight / 2) - top * scale })
  }
  useLayoutEffect(() => {
    if (!needsInitialFit.current) return
    const element = structureRef.current?.querySelector<HTMLElement>('[data-rule-stage]')
    if (!element) return
    const observer = new ResizeObserver(() => { if (needsInitialFit.current) fit() })
    observer.observe(element)
    fit()
    return () => observer.disconnect()
  })

  return <div className={css.ruleCanvas} data-node-open={shownNode !== undefined || undefined} data-rule-steps>
    <div className={css.steps} ref={structureRef}>
    <h3 ref={structureHeading} tabIndex={-1} className={css.canvasAccessibleHeading}>{t('rules.structure')}</h3>
    {props.diagnosticActionId !== undefined && diagnosticNode === undefined && <p role="status">{t('diagnostics.targetUnavailable')}</p>}
    <div className={css.canvasLayout} data-library-open={libraryOpen || undefined}>
    <section id={libraryId} className={css.canvasLibrary} hidden={!libraryOpen} aria-label={t('rules.nodeLibrary')} onKeyDown={event => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
      event.stopPropagation()
      props.onCloseLibrary(true)
    }}>
      <header className={css.libraryHeading}><strong>{t('rules.nodeLibrary')}</strong></header>
      <div className={css.libraryBody}>
      <SearchInput aria-label={t('rules.librarySearch')} placeholder={t('rules.librarySearch')} value={libraryQuery} onChange={event => setLibraryQuery(event.target.value)} />
      <div className={css.libraryCategories}>
        {(['condition', 'action'] as const).map(kind => <button key={kind} type="button" aria-pressed={libraryCategory === kind} onClick={() => {
          setLibraryCategory(kind); setLibraryItem('')
          const target = graph.targets.find(item => kind === 'condition' ? item.kind === 'condition' : item.kind !== 'condition')
          if (target) setTargetId(target.id)
        }}><span className={css.categoryIcon} data-category={kind} aria-hidden="true" />{t(kind === 'condition' ? 'rules.libraryConditions' : 'rules.libraryActions')}</button>)}
      </div>
      {libraryKind === 'action' && <Button variant="outline" disabled={disabled || !activeTarget || activeTarget.kind === 'condition'} onClick={() => {
        if (!activeTarget || activeTarget.kind === 'condition') return
        changeAt(activeTarget.path, [...nodeList(valueAt(rule, activeTarget.path)), { if: { scope: { audience: 'main' } }, then: [], else: [] }])
      }}>{t('rules.steps.addBranch')}</Button>}
      <MenuSelect ariaLabel={t('rules.structure')} value={activeTarget?.id ?? ''} options={graph.targets.map(target => ({ value: target.id, label: target.label }))} onChange={setTargetId} />
      <div className={css.libraryItems}>
      {libraryEntries.filter(entry => `${entry.kind} ${triggerLabel(t, entry.kind)}`.toLowerCase().includes(libraryQuery.toLowerCase())).map(entry => {
        const kind = libraryKind
        const data = payload(kind, entry.kind)
        const detail = kind === 'condition' ? conditionSummary(t, entry.example as RuleCondition) : actionSummary(t, { ...entry.example, kind: entry.kind } as RuleAction)
        return <button key={entry.kind} type="button" className={css.libraryItem} data-library-kind={kind} draggable={!disabled}
            onDragStart={event => { setDragPayload(data); event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData('application/x-prompt-tool-rule-node', data) }} onDragEnd={() => setDragPayload('')}
          aria-pressed={libraryItem === entry.kind} onClick={() => setLibraryItem(entry.kind)}><span className={css.libraryIcon} aria-hidden="true">{kind === 'condition' ? <IconCopyOutlineRegular /> : <IconChevronDownOutlineRegular />}</span><span><strong>{triggerLabel(t, entry.kind)}</strong><small>{detail === triggerLabel(t, entry.kind) ? entry.kind : detail}</small></span></button>
      })}
      </div>
      {selectedLibraryEntry && <section className={css.libraryDetail} aria-label={triggerLabel(t, selectedLibraryEntry.kind)}>
        <strong>{triggerLabel(t, selectedLibraryEntry.kind)}</strong>
        <p>{libraryKind === 'condition' ? conditionSummary(t, selectedLibraryEntry.example as RuleCondition)
          : actionSummary(t, { ...selectedLibraryEntry.example, kind: selectedLibraryEntry.kind } as RuleAction)}</p>
        <p>{t('rules.libraryAddHint')}</p>
        <Button shape="pill" variant="primary" disabled={!activeTarget || !canAdd(activeTarget.id, payload(libraryKind, selectedLibraryEntry.kind))}
          onClick={() => { if (activeTarget) add(activeTarget.id, payload(libraryKind, selectedLibraryEntry.kind)) }}>{t('configList.create')}</Button>
      </section>}
      </div>
    </section>
    <RuleCanvas t={t} nodes={graph.nodes.map(node => {
      return { ...node, selected: node.id === shownNode,
          dropTarget: graph.targets.find(target => target.id === `${node.id}:target`)?.id }
    })} edges={graph.edges} view={view}
      onViewChange={changeView} onSelect={context.select} onMove={(id, x, y) => changeView({ ...view, positions: { ...view.positions, [id]: { x, y } } })}
      canDropNode={(id, data) => canAdd(id, data || dragPayload)} onDropNode={dropNode} onFit={fit} />
    </div>
    <div hidden>
    {/* IF 卡：规则级条件；下面的节点卡都属于这个条件作用域。 */}
    <StepCard kind="if" kindLabel={t('rules.steps.ifLabel')} summary={conditionSummary(t, rule.if)} level={0}
      nodeKey={`${props.fieldKey}:if`} open={rowOpen(context, `${props.fieldKey}:if`)} onToggle={() => context.select(`${props.fieldKey}:if`)} property={context.property}
      actions={rule.if === undefined ? undefined : <CloseButton label={t('rules.clearCondition')} disabled={disabled} onClick={() => patch({ if: undefined })} />}>
      <RuleConditionFields {...context} fieldKey={`${props.fieldKey}:if`} meta={meta} value={rule.if} onChange={condition => patch({ if: condition })} />
    </StepCard>
    {/* then：任务卡与分支卡在顶层并列，收起时就是一张「条件 → 动作」一览。 */}
    <div className={css.stepScope} data-step-scope="then">
      <p className={css.stepSlot}>{t('rules.steps.then')}</p>
      {renderList(then, `${props.fieldKey}:then`, rule.if === undefined ? [] : [rule.if], conditional, setNodes)}
    </div>
    {/* 规则级 else：`if` 不命中时执行，条件自带 not(if)。 */}
    {rule.else === undefined
      ? <div className={css.stepAdd}><Button shape="pill" variant="outline" disabled={disabled} onClick={() => patch({ else: [] })}>{t('rules.steps.addElse')}</Button></div>
      : <div className={css.stepScope} data-step-scope="else">
        <ScopeHead kindLabel={t('rules.steps.elseLabel')} summary={t('rules.steps.actionCount', { count: otherwise.length })} disabled={disabled}
          removeLabel={t('rules.steps.removeElse')} onRemove={() => patch({ else: undefined })} />
        {renderList(otherwise, `${props.fieldKey}:else`, rule.if === undefined ? [] : [{ not: rule.if }], rule.if !== undefined, nodes => patch({ else: nodes as RuleAction[] }))}
      </div>}
    </div>
    </div>
    <section className={css.ruleProperties}>
      <header className={css.inspectorHeading}>
        <div><h3 ref={propertyHeading} tabIndex={-1}>{t('rules.ruleEditor')}</h3><small>{graph.nodes.find(node => node.id === shownNode)?.title}{selectedDescriptor?.kind === 'action' ? ` · ${selectedDescriptor.actionId}` : ''}</small></div>
        <button type="button" aria-label={t('rules.backToStructure')} onClick={() => { focusPane.current = 'structure'; select(undefined) }}>×</button>
      </header>
      <div className={css.inspectorBody}>
      {shownNode === undefined && <p>{t('rules.chooseNode')}</p>}
      <div id={propertyId} ref={setPropertyTarget} />
      {selectedDescriptor?.kind === 'group' && (selectedDescriptor.path === 'then' || selectedDescriptor.path === 'else' || selectedDescriptor.path.endsWith(':then') || selectedDescriptor.path.endsWith(':else')) && <>
        {renderList(nodeList(valueAt(rule, selectedDescriptor.path)), `${props.fieldKey}:${selectedDescriptor.path}`, rule.if === undefined ? [] : [rule.if], conditional, nodes => changeAt(selectedDescriptor.path, nodes))}
      </>}
      {selectedDescriptor && (selectedDescriptor.kind === 'condition' || selectedDescriptor.kind === 'group') && selectedDescriptor.path.includes('if') &&
        <RuleConditionFields {...context} value={valueAt(rule, selectedDescriptor.path) as RuleCondition | undefined} fieldKey={`${props.fieldKey}:${selectedDescriptor.path}`} meta={meta}
          onChange={value => changeAt(selectedDescriptor.path, value)} />}
      {selectedDescriptor?.kind === 'branch' && <RuleConditionFields {...context} value={selectedDescriptor.value.if as RuleCondition | undefined}
        fieldKey={`${props.fieldKey}:${selectedDescriptor.path}:if`} meta={meta} onChange={value => changeAt(`${selectedDescriptor.path}:if`, value)} />}
      {selectedDescriptor?.kind === 'unknown' && <><p role="note">{t('rules.unknown')}</p><TriggerJsonField {...context} value={selectedDescriptor.value} shape="object"
        fieldKey={`${props.fieldKey}:${selectedDescriptor.path}`} label={t('rules.rawAction')} onChange={value => changeAt(selectedDescriptor.path, value)} /></>}
      <details className={css.propertySummary}><summary>{t('rules.ruleOverview')}</summary><p>{rule.name || rule.id}</p><p>{conditionSummary(t, rule.if)}</p></details>
      </div>
      {selectedDescriptor?.kind === 'group' && selectedDescriptor.path === 'else' && <footer className={css.propertyFooter}>
        <Button shape="pill" variant="outline" data-danger disabled={disabled} onClick={() => patch({ else: undefined })}>{t('rules.steps.removeElse')}</Button>
      </footer>}
      {selectedDescriptor && (selectedDescriptor.kind !== 'group' || selectedDescriptor.path.includes('if')) && <footer className={css.propertyFooter}>
        <Button shape="pill" variant="outline" data-danger disabled={disabled} onClick={() => {
          const path = selectedDescriptor.path
          cleared(props.fields, `${props.fieldKey}:${path}`)
          // not 的唯一子条件删除时一并删除包装，避免留下非法的空 not。
          changeAt(path.replace(/(?::not:0)+$/, ''), undefined)
          select(undefined)
        }}>{t(selectedDescriptor.kind === 'action' ? 'rules.removeActionShort' : 'rules.clearCondition')}</Button>
      </footer>}
    </section>
  </div>
}
