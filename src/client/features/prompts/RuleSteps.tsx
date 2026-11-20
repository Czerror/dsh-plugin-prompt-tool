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
import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { RuleAction, RuleCondition, RuleDefinition, RuleEditorMeta } from '../../../shared/rules.ts'
import type { FieldDraft } from '../../data/workspace-drafts.ts'
import type { EngineMeta } from '../../prompt-tool-types.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { Button } from '../../ui/Button.tsx'
import { CanvasChoice } from '../../ui/CanvasChoice.tsx'
import { FormField } from '../../ui/FormField.tsx'
import { AutoSaveSelection } from '../../ui/AutoSaveSelection.ts'
import { SearchInput } from '../../ui/SearchInput.tsx'
import { IconChevronDownOutlineRegular, IconCloseFillRegular, IconCopyOutlineRegular } from '../../ui/icons.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { CloseButton, StepAdd, type StepCreation } from './RuleStepCard.tsx'
import { RuleConditionFields, RuleParameterFields, cleared, removeConditionDraft } from './RuleFields.tsx'
import { AssemblyFields, MessageFilterFields, VisibilityFields } from './RuleSurfaceFields.tsx'
import { ModulePersonaCard } from './ModulePersonaCard.tsx'
import { TriggerJsonField, asTriggerRecord } from './RuleJsonField.tsx'
import { triggerLabel } from './rule-labels.ts'
import { ruleExecutionPoint } from '../../data/rule-execution-point.ts'
import { instructionNodes, RuleCanvas, type CanvasInstructionFile, type RuleCanvasView } from './RuleCanvas.tsx'
import { projectRuleCanvas, type RuleCanvasTarget } from './rule-canvas-projection.ts'
import {
  actionSummary, collectActionIds, conditionSummary, nodeList,
} from './rule-steps.ts'
import css from './rules.module.css'

type LibraryKind = 'condition' | 'action' | 'branch'
type LibraryItem = { kind: LibraryKind; name: string; label: string; example?: Record<string, unknown> }

function RuleLibrary({ t, meta, libraryOpen, libraryId, onCloseLibrary, disabled, selected, onSelect, payload, setDragPayload }: {
  t: PromptToolTranslate
  meta: RuleEditorMeta
  libraryOpen: boolean
  libraryId: string
  onCloseLibrary: (restoreFocus: boolean) => void
  disabled: boolean
  selected?: LibraryItem
  onSelect: (item: LibraryItem, trigger: HTMLButtonElement) => void
  payload: (kind: LibraryKind, name: string) => string
  setDragPayload: (data: string) => void
}): ReactNode {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState({ condition: true, action: false })
  const branchLabel = t('rules.steps.branchLabel')
  const groups = useMemo(() => (['condition', 'action'] as const).map(kind => {
    const items: LibraryItem[] = (kind === 'condition' ? meta.predicates : meta.actions).map(entry => ({
      kind, name: entry.kind, label: triggerLabel(t, entry.kind), example: entry.example,
    }))
    if (kind === 'action') items.push({ kind: 'branch', name: 'branch', label: branchLabel })
    return { kind, items: items.map(item => ({ item, search: `${item.name} ${item.label}`.toLowerCase() })) }
  }), [meta, t, branchLabel])
  if (!libraryOpen) return <section id={libraryId} className={css.canvasLibrary} data-canvas-obstacle="left" hidden />
  const filter = query.trim().toLowerCase()
  const visible = groups.map(group => ({
    ...group,
    items: filter ? group.items.filter(item => item.search.includes(filter)) : group.items,
  }))
  return <section id={libraryId} className={css.canvasLibrary} data-canvas-obstacle="left" aria-label={t('rules.nodeLibrary')} onKeyDown={event => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
    event.stopPropagation()
    onCloseLibrary(true)
  }}>
    <header className={css.libraryHeading}>
      <strong>{t('rules.nodeLibrary')}</strong>
      <Button icon aria-label={t('rules.hideLibrary')} onClick={() => onCloseLibrary(true)}><IconCloseFillRegular /></Button>
    </header>
    <SearchInput aria-label={t('rules.librarySearch')} placeholder={t('rules.librarySearch')} value={query} onChange={event => setQuery(event.target.value)} />
    <div className={css.libraryBody}>
      {filter && visible.every(group => group.items.length === 0) && <p role="status">{t('rules.libraryNoMatch')}</p>}
      {visible.map(({ kind, items }) => {
        const open = filter ? items.length > 0 : expanded[kind]
        const label = t(kind === 'condition' ? 'rules.libraryConditions' : 'rules.libraryActions')
        return <section key={kind} className={css.libraryGroup}>
          <h4 className={css.librarySection}>
            <button type="button" aria-expanded={open} aria-controls={`${libraryId}-${kind}`} aria-disabled={filter ? true : undefined}
              onClick={() => { if (!filter) setExpanded({ ...expanded, [kind]: !expanded[kind] }) }}>
              <IconChevronDownOutlineRegular /><span>{label}</span><span className={css.libraryCount}>{items.length}</span>
            </button>
          </h4>
          <div id={`${libraryId}-${kind}`} hidden={!open}>
            {open && items.map(({ item }) => <button key={`${item.kind}:${item.name}`} type="button" className={css.libraryItem}
              data-library-kind={item.kind} draggable={!disabled} aria-pressed={selected?.kind === item.kind && selected.name === item.name}
              onDragStart={event => {
                const data = payload(item.kind, item.name)
                setDragPayload(data)
                event.dataTransfer.effectAllowed = 'copy'
                event.dataTransfer.setData('application/x-prompt-tool-rule-node', data)
              }} onDragEnd={() => setDragPayload('')} onClick={event => onSelect(item, event.currentTarget)}>
              <span className={css.libraryIcon} data-library-kind={kind} aria-hidden="true">{kind === 'condition' ? <span className={css.conditionMark} /> : <IconCopyOutlineRegular />}</span>
              <strong>{item.label}</strong>
            </button>)}
          </div>
        </section>
      })}
    </div>
  </section>
}

function LibraryProperties({ t, item, targets, disabled, onAdd }: {
  t: PromptToolTranslate; item: LibraryItem; targets: readonly RuleCanvasTarget[]; disabled: boolean; onAdd: (targetId: string) => void
}): ReactNode {
  const [targetId, setTargetId] = useState('')
  const options = useMemo(() => {
    const counts = new Map<string, number>()
    for (const target of targets) counts.set(target.label, (counts.get(target.label) ?? 0) + 1)
    return targets.map(target => ({ value: target.id, label: (counts.get(target.label) ?? 0) > 1 ? `${target.label} · ${target.path}` : target.label }))
  }, [targets])
  const target = options.some(option => option.value === targetId) ? targetId : options[0]?.value
  const detail = item.kind === 'branch' ? undefined : item.kind === 'condition'
    ? conditionSummary(t, item.example as RuleCondition)
    : actionSummary(t, { ...item.example, kind: item.name } as RuleAction)
  return <div className={css.inspectorFields}>
    {detail && detail !== item.label && <p className={css.libraryExample}>{detail.startsWith(item.label + ' · ') ? detail.slice(item.label.length + 3) : detail}</p>}
    {options.length > 0 ? <AutoSaveSelection.Provider value={undefined}>
      <FormField label={t('rules.libraryTarget')}><CanvasChoice t={t} ariaLabel={t('rules.libraryTarget')} value={target ?? ''}
        options={options} onChange={setTargetId} disabled={disabled} /></FormField>
    </AutoSaveSelection.Provider> : <p role="status">{t('rules.libraryNoTarget')}</p>}
    <Button shape="pill" variant="primary" disabled={disabled || target === undefined}
      onClick={() => { if (target !== undefined) onAdd(target) }}>{t('rules.libraryAdd')}</Button>
  </div>
}

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
  select: (path: string) => void
}

function ActionFields(props: {
  context: StepContext
  action: RuleAction
  path: string
  scopeConditional: boolean
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
  return <div className={css.inspectorFields}>
    {entry === undefined
      ? <><p role="note">{t('rules.unknown')}</p><TriggerJsonField {...context} label={t('rules.rawAction')} shape="object" value={action} fieldKey={fieldKey}
        onChange={next => props.onChange(asTriggerRecord(next) as unknown as RuleAction)} /></>
      : <>
        {/* 类型切换留在卡内：换类型等于换一份参数骨架，动作 id 不变。 */}
        <FormField label={t('triggers.actionType')}><MenuSelect ariaLabel={t('triggers.actionType')} value={action.kind} disabled={context.disabled}
          options={(props.scopeConditional ? context.meta.actions.filter(item => item.supportsWhen) : context.meta.actions).map(item => ({ value: item.kind, label: triggerLabel(t, item.kind) }))}
          onChange={kind => {
            const next = context.meta.actions.find(item => item.kind === kind)
            if (next === undefined) return
            cleared(context.fields, fieldKey)
            props.onChange({ ...structuredClone(next.example), id: action.id, kind } as unknown as RuleAction)
          }} /></FormField>
        {action.kind === 'persona' ? <ModulePersonaCard t={t} action={action} disabled={context.disabled} context={{ ...context, fieldKey }} onChange={props.onChange} />
          : action.kind === 'assembly' ? <AssemblyFields {...context} fieldKey={fieldKey} value={action} onChange={next => props.onChange(next as RuleAction)} />
          : action.kind === 'tool-visibility' ? <VisibilityFields {...context} fieldKey={fieldKey} value={action} onChange={next => props.onChange(next as RuleAction)} />
          : action.kind === 'pre-step-filter' ? <MessageFilterFields {...context} fieldKey={fieldKey} value={action} onChange={next => props.onChange(next as RuleAction)} />
          : <div className={css.fields}><RuleParameterFields {...context} fieldKey={fieldKey} value={action} requestPatch={action.kind === 'request-params'} example={example}
          omit={['id', 'kind', ...(action.kind === 'request-params' ? ['audience', 'modelScope'] : [])]}
          configOmit={action.kind === 'inject-text' ? ['modelScope', 'promotion', ...staticAudience ? [] : ['audience']] : undefined}
          onChange={next => props.onChange({ ...next, id: action.id, kind: String(next.kind ?? action.kind) } as unknown as RuleAction)} /></div>}
      </>}
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
  onCanvasInteract: () => void
  instructionFiles: readonly CanvasInstructionFile[]
  activeInstructionId?: string
  hideNodeInspector?: boolean
  onSelectInstruction: (id: string) => void
  diagnosticActionId?: string
  diagnosticFocusToken?: object
  disabled?: boolean
  onDraft: () => void
  onChange: (rule: RuleDefinition) => void
  onMove: (path: string, index: number, offset: -1 | 1) => void
}): ReactNode {
  const { t, rule, meta, libraryOpen } = props
  const structureLabel = t('rules.structure')
  const disabled = props.disabled === true
  const usedIds = useMemo(() => collectActionIds([...nodeList(rule.then), ...nodeList(rule.else)]), [rule])
  const diagnosticNode = props.diagnosticActionId === undefined || !usedIds.has(props.diagnosticActionId) ? undefined : `action:${props.diagnosticActionId}`
  const [addActionKind, setAddActionKind] = useState('inject-text')
  const [addConditionKind, setAddConditionKind] = useState('')
  const [activeCreation, setActiveCreation] = useState(`${props.fieldKey}:then`)
  const [libraryItem, setLibraryItem] = useState<LibraryItem>()
  const libraryTrigger = useRef<HTMLButtonElement>()
  const lastDiagnosticFocus = useRef(props.diagnosticFocusToken)
  const [localSelectedNode, selectNode] = useState(props.nodeBrowse?.get(props.browseKey))
  const selectedNode = props.onBrowseChange ? props.nodeBrowse?.get(props.browseKey) : localSelectedNode
  const [localView, setLocalView] = useState<RuleCanvasView>({ x: 260, y: 110, scale: 0.8, positions: {} })
  const view = props.canvasBrowse?.get(props.browseKey) ?? localView
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
  const { graph, nodeById, idByPath, targetById, top } = useMemo(() => {
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
    return {
      graph,
      nodeById: new Map(graph.nodes.map(node => [node.id, node])),
      idByPath: new Map([...graph.descriptors].filter(([id]) => !id.startsWith('lane:')).map(([id, descriptor]) => [descriptor.path, id])),
      targetById: new Map(graph.targets.map(target => [target.id, target])),
      top: graph.nodes.reduce((min, node) => Math.min(min, node.y), 0),
    }
  }, [rule, meta, t, identityState, structureLabel])
  const [dragPayload, setDragPayload] = useState('')
  const propertyId = useId()
  const structureHeading = useRef<HTMLHeadingElement>(null)
  const propertyHeading = useRef<HTMLHeadingElement>(null)
  const focusPane = useRef<'structure' | 'properties'>()
  const handledDiagnosticNode = useRef<string>()
  const structureRef = useRef<HTMLDivElement>(null)
  const libraryNode = useRef<string>()
  const editedConditionPath = useRef<string>()
  useLayoutEffect(() => {
    const changed = selectedNode !== libraryNode.current
    libraryNode.current = selectedNode
    if (changed && selectedNode && libraryOpen && structureRef.current
      && getComputedStyle(structureRef.current).getPropertyValue('--pt-stacked-panes').trim() === '1') {
      props.onCloseLibrary(false)
    }
  })
  const lastNodeKey = useRef(selectedNode)
  const select = (path: string | undefined): void => {
    if (path === undefined) props.nodeBrowse?.delete(props.browseKey)
    else props.nodeBrowse?.set(props.browseKey, path)
    if (props.onBrowseChange) props.onBrowseChange()
    else selectNode(path)
  }
  useLayoutEffect(() => {
    if (editedConditionPath.current !== undefined) {
      const id = idByPath.get(editedConditionPath.current)
      editedConditionPath.current = undefined
      if (id !== undefined && selectedNode !== id) {
        lastNodeKey.current = id
        focusPane.current = 'properties'
        select(id)
        return
      }
    }
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
  const inspectingOther = props.activeInstructionId !== undefined || props.hideNodeInspector === true
  const libraryDetail = libraryOpen && !inspectingOther && lastDiagnosticFocus.current === props.diagnosticFocusToken ? libraryItem : undefined
  const selectedCanvasNode = selectedNode?.startsWith('action:') && !usedIds.has(selectedNode.slice('action:'.length)) ? undefined : selectedNode
  const shownNode = inspectingOther || libraryDetail ? undefined : selectedCanvasNode
  useLayoutEffect(() => {
    if (inspectingOther || !libraryOpen || lastDiagnosticFocus.current !== props.diagnosticFocusToken) setLibraryItem(undefined)
    lastDiagnosticFocus.current = props.diagnosticFocusToken
  }, [inspectingOther, libraryOpen, props.diagnosticFocusToken])
  const closeLibraryDetail = (restoreFocus: boolean): void => {
    const trigger = libraryTrigger.current
    setLibraryItem(undefined)
    if (restoreFocus) requestAnimationFrame(() => {
      const fallback = structureRef.current?.closest('[data-canvas-workspace]')
        ?.querySelector<HTMLButtonElement>(`[aria-controls="${CSS.escape(props.libraryId)}"]`)
      ;(trigger?.getClientRects().length ? trigger : fallback)?.focus({ preventScroll: true })
    })
    libraryTrigger.current = undefined
  }
  const openLibraryDetail = (item: LibraryItem, trigger: HTMLButtonElement): void => {
    props.onCanvasInteract()
    libraryTrigger.current = trigger
    setLibraryItem(item)
  }
  useLayoutEffect(() => { if (libraryDetail) propertyHeading.current?.focus({ preventScroll: true }) }, [libraryDetail])
  const context: StepContext = {
    t, meta, engineMeta: props.engineMeta, fields: props.fields, expanded: props.expanded,
    prefix: props.prefix, disabled, onDraft: props.onDraft,
    creation: { active: activeCreation, select: setActiveCreation },
    select: path => {
      lastNodeKey.current = path
      focusPane.current = 'properties'
      select(path)
      if (path === shownNode) { propertyHeading.current?.focus(); focusPane.current = undefined }
    },
  }
  const patch = (next: Partial<RuleDefinition>): void => { if (!disabled) props.onChange({ ...rule, ...next }) }
  const changeAt = (path: string, value: unknown): void => {
    if (!disabled) props.onChange(withValue(rule, definitionPath(path), value) as RuleDefinition)
  }

  const nextActionId = (): string => { let number = 1; while (usedIds.has(`action-${number}`)) number++; return `action-${number}` }
  const actionSelectable = (scopeConditional: boolean) =>
    scopeConditional ? meta.actions.filter(action => action.supportsWhen) : meta.actions

  const selectedDescriptor = shownNode === undefined ? undefined : graph.descriptors.get(shownNode)
  const conditionSelection = selectedDescriptor?.path.split(':').includes('if') === true
  const nestedCondition = conditionSelection && /:(?:all|any|notAny|not):\d+$/.test(selectedDescriptor!.path)
  const elseSelection = selectedDescriptor?.kind === 'group' && /(?:^|:)else$/.test(selectedDescriptor.path)
    && shownNode !== undefined && !nodeById.get(shownNode)?.region
  const nodeTitle = shownNode === undefined ? undefined : nodeById.get(shownNode)?.title
  const nodeIdentity = selectedDescriptor?.kind === 'action' ? selectedDescriptor.actionId
    : selectedDescriptor?.kind === 'branch' ? t('rules.steps.branchLabel')
      : selectedDescriptor?.kind === 'condition' ? t('rules.libraryConditions')
        : selectedDescriptor?.kind === 'unknown' ? t('rules.steps.unknown') : selectedDescriptor?.path
  const payload = (kind: LibraryKind, name: string): string => JSON.stringify({ rule: props.browseKey, kind, name })
  const parsePayload = (text: string): { kind: LibraryKind; name: string } | undefined => {
    try {
      const value = JSON.parse(text) as Record<string, unknown>
      return value.rule === props.browseKey && (value.kind === 'condition' || value.kind === 'action' || value.kind === 'branch') && typeof value.name === 'string'
        ? { kind: value.kind, name: value.name } : undefined
    } catch { return undefined }
  }
  const targetFor = (id: string) => targetById.get(id) ?? targetById.get(`${id}:target`)
  const canAdd = (id: string, text: string): boolean => {
    const target = targetFor(id), item = parsePayload(text)
    if (disabled || !target || !item) return false
    if (target.kind === 'condition') return item.kind === 'condition' && meta.predicates.some(entry => entry.kind === item.name)
    if (item.kind === 'branch') return item.name === 'branch' && !target.executionPoint && meta.predicates.some(entry => entry.kind === 'scope')
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
    } else if (item.kind === 'branch') {
      changeAt(target.path, [...nodeList(valueAt(rule, target.path)), { if: { scope: { audience: 'main' } }, then: [], else: [] }])
    } else {
      const example = structuredClone(meta.actions.find(entry => entry.kind === item.name)!.example)
      const action = { ...example, id: nextActionId(), kind: item.name } as RuleAction
      changeAt(target.path, [...nodeList(valueAt(rule, target.path)), action])
      context.select(`action:${action.id}`)
    }
  }
  const dropNode = (id: string, text: string): void => {
    if (canAdd(id, text)) { closeLibraryDetail(false); add(id, text) }
  }

  const removeNodeDrafts = (path: string, index: number): void => {
    const prefix = `${props.fieldKey}:${path}`
    removeConditionDraft(props.fields, prefix, index)
    removeConditionDraft(props.expanded, `${props.prefix}:${prefix}`, index)
  }
  const removeCondition = (path: string): void => {
    const child = /^(.*):(all|any|notAny|not):(\d+)$/.exec(path)
    if (child) {
      const [, parent, kind, index] = child
      const listPath = `${parent}:${kind}`
      if (kind === 'not' || nodeList(valueAt(rule, listPath)).length <= 1) {
        removeCondition(parent!)
        return
      }
      removeNodeDrafts(listPath, Number(index))
      changeAt(path, undefined)
      return
    }
    const key = `${props.fieldKey}:${path}`
    cleared(props.fields, key)
    cleared(props.expanded, `${props.prefix}:${key}`)
    changeAt(path, undefined)
  }

  const nodeLink = (id: string | undefined, actions?: ReactNode): ReactNode => {
    const node = id === undefined ? undefined : nodeById.get(id)
    if (!node) return null
    return <div key={node.id} className={css.inspectorNodeRow}>
      <Button className={css.inspectorNodeLink} onClick={() => context.select(node.id)}>{node.title}</Button>
      {actions}
    </div>
  }

  const renderScope = (path: string, id: string): ReactNode => {
    const scope = nodeList(valueAt(rule, path))
    const members = nodeById.get(id)?.members
    const ids = members ?? scope.map((_, index) => idByPath.get(`${path}:${index}`))
    const conditional = rule.if !== undefined || path.includes(':')
    const target = targetFor(id)
    const candidates = target ? actionSelectable(conditional).filter(entry => canAdd(target.id, payload('action', entry.kind))) : []
    const selected = candidates.find(action => action.kind === addActionKind) ?? candidates[0]
    const addBranch = (): void => {
      const predicate = meta.predicates.find(item => item.kind === addConditionKind)
      const action = selected?.supportsWhen ? selected : candidates.find(item => item.supportsWhen)
      if (disabled || !predicate || !action) return
      changeAt(path, [...scope, { if: structuredClone(predicate.example), then: [{ ...structuredClone(action.example), id: nextActionId(), kind: action.kind }] }])
    }
    return <div className={css.inspectorFields}>
      {ids.map(childId => {
        const child = childId === undefined ? undefined : graph.descriptors.get(childId)
        if (!child) return null
        const index = Number(child.path.split(':').at(-1))
        return nodeLink(childId, <NodeActions t={t} id={child.kind === 'action' ? child.actionId : String(index + 1)} index={index} total={scope.length}
          disabled={disabled} onMove={offset => props.onMove(`${props.fieldKey}:${path}`, index, offset)} onRemove={() => {
            removeNodeDrafts(path, index)
            changeAt(child.path, undefined)
            propertyHeading.current?.focus()
          }} />)
      })}
      {target && candidates.length > 0 && <StepAdd creation={context.creation} path={`${props.fieldKey}:${path}`} label={t('configList.create')} disabled={disabled}>
        <FormField label={t('rules.steps.addActionType')}><MenuSelect compact ariaLabel={t('rules.steps.addActionType')} value={selected?.kind ?? ''} disabled={disabled}
          options={candidates.map(item => ({ value: item.kind, label: triggerLabel(t, item.kind) }))} onChange={setAddActionKind} /></FormField>
        <Button shape="pill" variant="outline" disabled={disabled || !selected}
          onClick={() => { if (selected) add(target.id, payload('action', selected.kind)) }}>{t('rules.addAction')}</Button>
        {!members && <><FormField label={t('rules.steps.addConditionType')}><MenuSelect compact ariaLabel={t('rules.steps.addConditionType')} value={addConditionKind} disabled={disabled}
          options={[{ value: '', label: t('triggers.unconditional') }, ...meta.predicates.map(item => ({ value: item.kind, label: triggerLabel(t, item.kind) }))]}
          onChange={setAddConditionKind} /></FormField>
        <Button shape="pill" variant="outline" disabled={disabled || !addConditionKind || !candidates.some(item => item.supportsWhen)} onClick={addBranch}>{t('rules.steps.addBranch')}</Button></>}
      </StepAdd>}
      {path === 'then' && !members && rule.else === undefined &&
        <Button shape="pill" variant="outline" disabled={disabled} onClick={() => patch({ else: [] })}>{t('rules.steps.addElse')}</Button>}
    </div>
  }

  const renderCondition = (path: string): ReactNode => {
    const value = valueAt(rule, path) as RuleCondition | undefined
    const kind = Object.keys(value ?? {})[0] ?? ''
    const listPath = `${path}:${kind}`
    const children = kind === 'not' ? [0] : meta.composites.includes(kind) ? nodeList(valueAt(rule, listPath)).map((_, index) => index) : []
    return <RuleConditionFields key={path} {...context} value={value} fieldKey={`${props.fieldKey}:${path}`} meta={meta}
      nested={/:(?:all|any|notAny|not):\d+$/.test(path)}
      childrenLinks={children.map(index => {
        const child = `${listPath}:${index}`
        return nodeLink(idByPath.get(child), <CloseButton label={t('rules.removeCondition')} disabled={disabled} onClick={() => {
          removeCondition(child)
          if (kind === 'not' || children.length <= 1) {
            focusPane.current = 'structure'
            select(undefined)
          } else propertyHeading.current?.focus()
        }} />)
      })}
      onChange={next => {
        if (next === undefined) {
          removeCondition(path)
          focusPane.current = 'structure'
          select(undefined)
        } else {
          if (selectedDescriptor?.path === path && !disabled) editedConditionPath.current = path
          changeAt(path, next)
        }
      }} />
  }

  const nodes = useMemo(() => graph.nodes.map(node => ({
    ...node, selected: node.id === selectedCanvasNode, dropTarget: targetById.get(`${node.id}:target`)?.id,
  })), [graph, selectedCanvasNode, targetById])
  const fileNodes = useMemo(() => instructionNodes(props.instructionFiles, props.activeInstructionId, 2, top),
    [props.instructionFiles, props.activeInstructionId, top])

  const libraryPayload = libraryDetail && payload(libraryDetail.kind, libraryDetail.name)
  const libraryTargets = libraryPayload ? graph.targets.filter(target => canAdd(target.id, libraryPayload)) : []
  const inspectorTitle = libraryDetail?.label ?? nodeTitle ?? t('rules.ruleEditor')
  return <div className={css.ruleCanvas} data-node-open={shownNode !== undefined || libraryDetail !== undefined || undefined}
    data-library-detail-open={libraryDetail !== undefined || undefined} data-rule-steps onKeyDown={event => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
    if (!(event.target instanceof Element) ||
      !event.target.closest('[data-node-inspector], [data-rule-stage]')) return
    if (!libraryDetail && shownNode === undefined) return
    event.stopPropagation()
    event.preventDefault()
    if (libraryDetail) { closeLibraryDetail(true); return }
    focusPane.current = 'structure'
    select(undefined)
  }}>
    <div className={css.steps} ref={structureRef}>
    <h3 ref={structureHeading} tabIndex={-1} className={css.canvasAccessibleHeading}>{structureLabel}</h3>
    {props.diagnosticActionId !== undefined && diagnosticNode === undefined && <p role="status">{t('diagnostics.targetUnavailable')}</p>}
    <div className={css.canvasLayout} data-library-open={libraryOpen || undefined}>
    <RuleLibrary t={t} meta={meta} libraryOpen={libraryOpen} libraryId={props.libraryId} onCloseLibrary={props.onCloseLibrary}
      selected={libraryDetail} onSelect={openLibraryDetail} disabled={disabled} payload={payload} setDragPayload={setDragPayload} />
    <RuleCanvas t={t} nodes={nodes} fileNodes={fileNodes} edges={graph.edges} view={view}
      activeInstructionId={props.activeInstructionId} selectedNodeId={selectedCanvasNode} hasStoredView={props.canvasBrowse?.has(props.browseKey)}
      onSelectInstruction={id => { closeLibraryDetail(false); props.onSelectInstruction(id) }}
      onViewChange={changeView} onSelect={id => { closeLibraryDetail(false); props.onCanvasInteract(); context.select(id) }}
      onPaneClick={() => {
        closeLibraryDetail(false)
        props.onCanvasInteract()
        if (shownNode !== undefined) select(undefined)
      }}
      onMove={(id, x, y) => changeView({ ...view, positions: { ...view.positions, [id]: { x, y } } })}
      canDropNode={(id, data) => canAdd(id, data || dragPayload)} onDropNode={dropNode} />
    </div>
    </div>
    <section className={css.ruleProperties} data-node-inspector data-canvas-obstacle="right" aria-labelledby={`${propertyId}-heading`}>
      <header className={css.inspectorHeading}>
        <div><h3 id={`${propertyId}-heading`} ref={propertyHeading} tabIndex={-1} title={inspectorTitle}>{inspectorTitle}</h3>
          {nodeIdentity && <small>{selectedDescriptor?.kind === 'action' && 'ID '}{nodeIdentity}</small>}</div>
        <Button icon aria-label={t('rules.closePanel', { name: inspectorTitle })} onClick={() => {
          if (libraryDetail) closeLibraryDetail(true)
          else { focusPane.current = 'structure'; select(undefined) }
        }}><IconCloseFillRegular /></Button>
      </header>
      <div className={css.inspectorBody}>
      {libraryDetail && libraryPayload && <LibraryProperties key={libraryPayload} t={t} item={libraryDetail} targets={libraryTargets} disabled={disabled}
        onAdd={target => { closeLibraryDetail(false); add(target, libraryPayload) }} />}
      {!libraryDetail && shownNode === undefined && <p>{t('rules.chooseNode')}</p>}
      {selectedDescriptor?.kind === 'action' && <ActionFields key={selectedDescriptor.actionId} context={context} action={selectedDescriptor.value}
        path={`${props.fieldKey}:${selectedDescriptor.path}`} scopeConditional={rule.if !== undefined || selectedDescriptor.path.split(':').length > 2}
        onChange={action => changeAt(selectedDescriptor.path, action)} />}
      {selectedDescriptor?.kind === 'group' && /(?:^|:)(then|else)$/.test(selectedDescriptor.path) &&
        shownNode && renderScope(selectedDescriptor.path, shownNode)}
      {selectedDescriptor && (selectedDescriptor.kind === 'condition' || selectedDescriptor.kind === 'group' && selectedDescriptor.path.includes('if')) &&
        renderCondition(selectedDescriptor.path)}
      {selectedDescriptor?.kind === 'branch' && <div className={css.inspectorFields}>
        {renderCondition(`${selectedDescriptor.path}:if`)}
        {nodeLink(idByPath.get(`${selectedDescriptor.path}:then`))}
        {idByPath.has(`${selectedDescriptor.path}:else`) ? nodeLink(idByPath.get(`${selectedDescriptor.path}:else`))
          : <Button shape="pill" variant="outline" disabled={disabled} onClick={() => changeAt(`${selectedDescriptor.path}:else`, [])}>{t('rules.steps.addElse')}</Button>}
      </div>}
      {selectedDescriptor?.kind === 'unknown' && <><p role="note">{t('rules.unknown')}</p><TriggerJsonField {...context} value={selectedDescriptor.value} shape="object"
        fieldKey={`${props.fieldKey}:${selectedDescriptor.path}`} label={t(conditionSelection ? 'triggers.conditionJson' : 'rules.rawAction')} onChange={value => changeAt(selectedDescriptor.path, value)} /></>}
      {!libraryDetail && <details className={css.propertySummary}><summary>{t('rules.ruleOverview')}</summary><p>{rule.name || rule.id}</p><p>{conditionSummary(t, rule.if)}</p></details>}
      </div>
      {selectedDescriptor && (elseSelection || selectedDescriptor.kind !== 'group'
        || conditionSelection) && (!conditionSelection || valueAt(rule, selectedDescriptor.path) !== undefined) &&
      <footer className={css.propertyFooter}>
        <Button shape="pill" variant="outline" data-danger disabled={disabled} onClick={() => {
          const path = selectedDescriptor.path
          if (conditionSelection) removeCondition(path)
          else {
            const entry = /^(.*):(\d+)$/.exec(path)
            if (entry) removeNodeDrafts(entry[1]!, Number(entry[2]))
            else {
              cleared(props.fields, `${props.fieldKey}:${path}`)
              cleared(props.expanded, `${props.prefix}:${props.fieldKey}:${path}`)
            }
            changeAt(path, undefined)
          }
          focusPane.current = 'structure'
          select(undefined)
        }}>{t(elseSelection ? 'rules.steps.removeElse' : conditionSelection ? nestedCondition ? 'rules.removeCondition' : 'rules.clearCondition'
          : selectedDescriptor.kind === 'action' ? 'rules.removeActionShort' : 'rules.steps.remove', { id: nodeTitle ?? selectedDescriptor.path })}</Button>
      </footer>}
    </section>
  </div>
}
