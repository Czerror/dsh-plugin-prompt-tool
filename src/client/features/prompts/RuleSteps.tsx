/**
 * 规则卡内部的条件卡视图（「一个条件一张卡，对应它的动作」）。
 *
 * 结构对应引擎真值（engine/branch.mjs#expandActions）：
 *   IF 卡        = 规则级条件，卡内是它的直属动作；
 *   分支卡       = `then` 里的分支节点 `{if, then, else}`，卡头即「当 ⟨条件⟩ → ⟨动作⟩」；
 *   动作卡       = 叶子动作，可展开改字段；
 *   否则卡       = 规则级 `else`。
 * 每张卡都是 TagInput 式的小卡：卡头单行摘要，展开才编辑，右侧 ↑↓ 与 × 。
 */
import { useId, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import type { RuleAction, RuleCondition, RuleDefinition, RuleEditorMeta } from '../../../shared/rules.ts'
import type { FieldDraft } from '../../data/workspace-drafts.ts'
import type { EngineMeta } from '../../prompt-tool-types.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { Button } from '../../ui/Button.tsx'
import { HintTooltip } from '../../ui/HintTooltip.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { IconChevronDownOutlineRegular, IconCloseFillRegular } from '../../ui/icons.tsx'
import { RuleConditionFields, RuleParameterFields, cleared } from './RuleFields.tsx'
import { TriggerJsonField, asTriggerRecord } from './RuleJsonField.tsx'
import { triggerLabel } from './rule-labels.ts'
import {
  actionSummary, branchSummary, collectActionIds, conditionChain, conditionSummary, nodeSummary,
  isActionNode, isBranchNode, nodeList, type RuleBranch, type RuleNode,
} from './rule-steps.ts'
import ui from '../../ui/controls.module.css'
import css from './rules.module.css'

/** 注册制层没有逐轮求值时机，引擎拒绝带条件的动作（engine/rule-spec.mjs:79,143）。 */
const REGISTRATION_LAYERS: readonly string[] = ['system-section', 'runtime-context']

/** 关闭按钮：与 TagInput 的 chip 删除同形态，图标是官方 IconClose 的复制件。 */
function CloseButton(props: { label: string; disabled?: boolean; onClick: () => void }): ReactNode {
  return <HintTooltip label={props.label}>
    <button type="button" className={clsx(ui.tagChipRemove, css.stepClose)} aria-label={props.label} disabled={props.disabled} onClick={props.onClick}>
      <IconCloseFillRegular />
    </button>
  </HintTooltip>
}

/** 一张小卡：卡头是一整行摘要（点开才编辑），右侧是这张卡自己的操作。 */
function StepCard(props: {
  kind: string
  kindLabel: string
  summary: string
  hint?: string
  open: boolean
  onToggle: () => void
  actions?: ReactNode
  level: number
  children: ReactNode
}): ReactNode {
  const panelId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const toggle = (
    <button ref={toggleRef} type="button" className={css.stepToggle} aria-expanded={props.open} aria-controls={panelId}
      onClick={() => {
        // 收起会把卡内控件卸载：先把焦点带回卡头，避免焦点掉到 body。
        if (props.open && bodyRef.current !== null && bodyRef.current.contains(document.activeElement)) toggleRef.current?.focus()
        props.onToggle()
      }}>
      <IconChevronDownOutlineRegular className={clsx(ui.chevron, props.open && ui.chevronOpen)} />
      <span className={css.stepKind}>{props.kindLabel}</span>
      <span className={css.stepSummary}>{props.summary}</span>
    </button>
  )
  return <section className={clsx(css.stepCard, props.open && css.stepCardOpen)} data-step={props.kind} data-open={props.open || undefined} data-level={props.level}>
    <div className={css.stepHead}>
      {props.hint === undefined ? toggle : <HintTooltip label={props.hint}>{toggle}</HintTooltip>}
      {props.actions !== undefined && <span className={css.stepActions}>{props.actions}</span>}
    </div>
    <div id={panelId} ref={bodyRef} hidden={!props.open} className={css.stepBody}>{props.open && props.children}</div>
  </section>
}

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
}

const rowKey = (context: StepContext, path: string): string => `${context.prefix}:${path}`
const rowOpen = (context: StepContext, path: string): boolean => context.expanded.get(rowKey(context, path)) === true
function toggleRow(context: StepContext, path: string): void {
  context.expanded.set(rowKey(context, path), !rowOpen(context, path))
  context.onDraft()
}

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
  const example = action.kind === 'request-params' ? { ...entry?.example, patch: { provider: '', model: '', reasoningEffort: '', temperature: undefined, maxTokens: undefined } }
    : action.kind === 'inject-text' ? { ...entry?.example, config: { strategy: 'static', configKind: 'ordered', ...(policy?.merge ? { mergeMode: 'separate' } : {}), ...(policy?.position ? { position: 'after-user' } : {}), ...(staticAudience ? { audience: '' } : {}), ...asTriggerRecord(entry?.example.config) } }
      : entry?.example
  const chainLabel = props.chain.length > 0 ? conditionChain(t, props.chain) : undefined
  return <StepCard kind="action" kindLabel={triggerLabel(t, String(action.kind))} summary={actionSummary(t, action)} hint={chainLabel}
    level={2} open={rowOpen(context, props.path)} onToggle={() => toggleRow(context, props.path)}
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
        <div className={css.fields}><RuleParameterFields {...context} fieldKey={fieldKey} value={action} requestPatch={action.kind === 'request-params'} example={example}
          omit={['id', 'kind', ...(action.kind === 'request-params' ? ['audience', 'modelScope'] : [])]}
          configOmit={action.kind === 'inject-text' ? ['modelScope', 'promotion', 'subject', 'match', ...staticAudience ? [] : ['audience']] : undefined}
          onChange={next => props.onChange({ ...next, id: action.id, kind: String(next.kind ?? action.kind) } as unknown as RuleAction)} /></div>
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
  return <StepCard kind="branch" kindLabel={t('rules.steps.branchLabel')} summary={branchSummary(t, branch)} hint={conditionChain(t, branchChain)}
    level={1} open={rowOpen(context, props.path)} onToggle={() => toggleRow(context, props.path)}
    actions={<NodeActions t={t} id={ordinal} index={props.index} total={props.total} disabled={context.disabled} onMove={props.onMove} onRemove={props.onRemove} />}>
    <RuleConditionFields {...context} fieldKey={`${props.path}:if`} meta={context.meta} value={branch.if} onChange={condition => patch({ if: condition })} />
    <p className={css.stepSlot}>{t('rules.steps.then')}</p>
    <div className={css.stepScope} data-step-scope="then">{props.renderList(nodeList(branch.then), `${props.path}:then`, branchChain, true, nodes => patch({ then: nodes }))}</div>
    <p className={css.stepSlot}>{t('rules.steps.else')}</p>
    {branch.else === undefined
      ? <div className={css.stepAdd}><Button shape="pill" variant="outline" disabled={context.disabled} onClick={() => patch({ else: [] })}>{t('rules.steps.addElse')}</Button></div>
      : <div className={css.stepScope} data-step-scope="else">{props.renderList(nodeList(branch.else), `${props.path}:else`, elseChain, true, nodes => patch({ else: nodes }))}</div>}
  </StepCard>
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
  disabled?: boolean
  onDraft: () => void
  onChange: (rule: RuleDefinition) => void
}): ReactNode {
  const { t, rule, meta } = props
  const [addActionKind, setAddActionKind] = useState('inject-text')
  const [addConditionKind, setAddConditionKind] = useState('')
  const disabled = props.disabled === true
  const then = nodeList(rule.then), otherwise = nodeList(rule.else)
  const usedIds = collectActionIds([...then, ...otherwise])
  const conditional = rule.if !== undefined
  const branchAllowed = !REGISTRATION_LAYERS.includes(rule.layer ?? 'pre-step')
  const context: StepContext = {
    t, meta, engineMeta: props.engineMeta, fields: props.fields, expanded: props.expanded,
    prefix: props.prefix, disabled, onDraft: props.onDraft,
  }
  const patch = (next: Partial<RuleDefinition>): void => { if (!disabled) props.onChange({ ...rule, ...next }) }
  const setNodes = (next: RuleNode[]): void => patch({ then: next as RuleAction[] })

  const nextActionId = (): string => { let number = 1; while (usedIds.has(`action-${number}`)) number++; return `action-${number}` }
  const actionSelectable = (scopeConditional: boolean) =>
    scopeConditional ? meta.actions.filter(action => action.supportsWhen) : meta.actions

  /** 列表渲染器：动作卡与分支卡递归共用（分支内可再嵌分支）。 */
  const renderList = (nodes: RuleNode[], path: string, chain: readonly RuleCondition[], scopeConditional: boolean, onChange: (next: RuleNode[]) => void): ReactNode => {
    const setAt = (index: number, next: RuleNode): void => onChange(nodes.map((node, at) => at === index ? next : node))
    const move = (index: number, offset: -1 | 1): void => {
      const next = [...nodes], target = index + offset
      if (target < 0 || target >= next.length) return
      ;[next[index], next[target]] = [next[target]!, next[index]!]
      onChange(next)
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
          open={rowOpen(context, nodePath)} onToggle={() => toggleRow(context, nodePath)}
          actions={<NodeActions t={t} id={String(index + 1)} index={index} total={nodes.length} disabled={disabled} onMove={offset => move(index, offset)} onRemove={() => onChange(nodes.filter((_, at) => at !== index))} />}>
          <p role="note">{t('rules.unknown')}</p>
          <TriggerJsonField {...context} label={t('rules.rawAction')} shape="object" value={node} fieldKey={nodePath}
            onChange={next => setAt(index, asTriggerRecord(next) as unknown as RuleNode)} />
        </StepCard>
      })}
      <div className={css.stepAdd} data-step-add>
        <MenuSelect compact ariaLabel={t('rules.steps.addConditionType')} value={addConditionKind} disabled={disabled || candidates.length === 0}
          options={[{ value: '', label: t('triggers.unconditional') }, ...meta.predicates.map(item => ({ value: item.kind, label: triggerLabel(t, item.kind) }))]}
          onChange={setAddConditionKind} />
        <MenuSelect compact ariaLabel={t('rules.steps.addActionType')} value={selected?.kind ?? ''} disabled={disabled || candidates.length === 0}
          options={candidates.map(item => ({ value: item.kind, label: triggerLabel(t, item.kind) }))} onChange={setAddActionKind} />
        <Button shape="pill" variant="outline" disabled={disabled || !branchAllowed || addConditionKind.length === 0 || candidates.length === 0} onClick={addBranch}>{t('rules.steps.addBranch')}</Button>
        <Button shape="pill" variant="outline" disabled={disabled || selected === undefined} onClick={addAction}>{t('rules.addAction')}</Button>
        {!branchAllowed && <span className={css.stepHint}>{t('rules.steps.branchUnsupported')}</span>}
      </div>
    </>
  }

  return <div className={css.steps} data-rule-steps>
    {/* IF 卡：规则级条件；下面的节点卡都属于这个条件作用域。 */}
    <StepCard kind="if" kindLabel={t('rules.steps.ifLabel')} summary={conditionSummary(t, rule.if)} level={0}
      open={rowOpen(context, `${props.fieldKey}:if`)} onToggle={() => toggleRow(context, `${props.fieldKey}:if`)}
      actions={rule.if === undefined ? undefined : <CloseButton label={t('rules.clearCondition')} disabled={disabled} onClick={() => patch({ if: undefined })} />}>
      <RuleConditionFields {...context} fieldKey={`${props.fieldKey}:if`} meta={meta} value={rule.if} onChange={condition => patch({ if: condition })} />
    </StepCard>
    {/* then：任务卡与分支卡在顶层并列，收起时就是一张「条件 → 动作」一览。 */}
    <div className={css.stepScope} data-step-scope="then">
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
}
