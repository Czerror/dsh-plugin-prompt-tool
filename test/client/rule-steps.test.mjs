/**
 * 条件卡视图的回归：分支节点是一等公民（一个条件一张卡对应动作）。
 *
 * 背景（缺陷现场）：`then` 里的分支节点 `{if, then, else}` 没有 `kind`，旧 UI 把它当动作渲染，
 * `MenuSelect` 收到 `value === undefined` 后在 `props.value.length` 抛 TypeError，
 * 整棵插件树卸载 —— 子代理页那张 ponytail 卡一点开就崩。
 * 这里同时锁住「不抛错」与「结构正确」两件事，数据取真实模块与真实编辑器目录。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { withSsr, renderElement, makeTranslate } from './support/ssr-render.mjs'
import { getRuleEditorMeta } from '../../engine/rule-spec.mjs'
import {
  actionSummary, branchSummary, collectActionIds, conditionChain, conditionSummary,
  conditionalActions, countNodes, isActionNode, isBranchNode, isValidNode, nodeList,
} from '../../src/client/features/prompts/rule-steps.ts'

const t = makeTranslate()
const action = (id, text) => ({ id, kind: 'inject-text', config: { id: `${id}-config`, text, layer: 'pre-step', strategy: 'static' } })

/** 真实模块里的那张卡：ponytail 子代理按任务只读/写入分档（modules/ponytail/module.yml）。 */
const moduleYml = parse(readFileSync(new URL('../../modules/ponytail/module.yml', import.meta.url), 'utf8'))
const ponytailRule = moduleYml.rules.find(rule => rule.id === 'ponytail-subagent')

test('rule-steps: 分支与动作的判据只看 kind，未知节点不猜成动作', () => {
  assert.equal(isActionNode(action('a', 'x')), true)
  assert.equal(isBranchNode(action('a', 'x')), false)
  assert.equal(isActionNode({ if: {}, then: [] }), false)
  assert.equal(isBranchNode({ if: {}, then: [] }), true)
  assert.equal(isBranchNode({ kind: 'inject-text' }), false, '带 kind 但没有 then 的节点仍算动作')
  assert.equal(isValidNode({ if: {}, then: [action('a', 'x')] }), true)
  assert.equal(isValidNode({ if: {}, then: [{ kind: 'inject-text' }] }), false, '缺 id 的叶子不是合法节点')
  assert.equal(isValidNode({ if: {}, then: [{ if: {}, then: [] }] }), true, '分支可以嵌套')
})

test('rule-steps: 摘要把多条件写成「且/或/非」，超出上限退化为项数', () => {
  const summary = conditionSummary(t, { all: [{ phase: { promoted: true } }, { scope: { modelScope: 'pro' } }, { count: { of: 'tool/call', min: 1 } }] })
  assert.match(summary, /且/)
  assert.match(summary, /等 3 项/)
  assert.match(conditionSummary(t, { not: { phase: { promoted: true } } }), /^非\(/)
  assert.match(conditionSummary(t, { any: [{ phase: { promoted: true } }, { scope: { modelScope: 'pro' } }] }), /或/)
  assert.equal(conditionSummary(t, undefined), '无条件')
  const text = conditionSummary(t, { text: { keys: ['a', 'b', 'c'], subject: 'userMessage' } })
  assert.match(text, /匹配对象=用户消息/)
  assert.match(text, /等 3 项/)
})

test('rule-steps: 动作摘要取正文首行，分支摘要写成「当 条件 → 动作」', () => {
  assert.match(actionSummary(t, action('a', '# 标题\n\n正文首行之后还有很多')), /注入文本 · 前置步骤 · 固定文本 · 标题/)
  const branch = ponytailRule.then[0]
  const summary = branchSummary(t, branch)
  assert.match(summary, /^当 /)
  assert.match(summary, /PONYTAIL:readonly/)
  assert.match(summary, /→ 1 个动作/, '带 else 的分支在卡头报条数')
  assert.match(branchSummary(t, { if: { phase: { promoted: true } }, then: [action('solo', '只此一个')] }), /→ 注入文本 · 前置步骤 · 固定文本 · 只此一个/, '单个动作且无 else 时卡头直接写该动作')
  assert.match(conditionChain(t, [{ all: [{ phase: { promoted: true } }] }, branch.if]), /^生效条件：/)
})

test('rule-steps: 计数与动作 id 收集递归整棵分支树', () => {
  const totals = countNodes(nodeList(ponytailRule.then))
  assert.equal(totals.branches, 1)
  const ids = collectActionIds(nodeList(ponytailRule.then))
  assert.ok(ids.has('inject-readonly') && ids.has('inject-write'), '嵌套动作 id 都要收进唯一性集合')
  assert.deepEqual([...conditionalActions(nodeList(ponytailRule.then), false)].map(item => item.id).sort(), ['inject-readonly', 'inject-write'])
})

test('rule-steps: 含分支的真实规则渲染不抛错，卡默认收起且摘要可读', async () => {
  const { RuleStepsPanel } = await withSsr([new URL('../../src/client/features/prompts/RuleSteps.tsx', import.meta.url).href])
  const render = (rule) => renderElement(RuleStepsPanel, {
    t, rule, meta: getRuleEditorMeta(), engineMeta: { layerFieldPolicies: {}, layers: [] },
    fields: new Map(), expanded: new Map(), prefix: 'ponytail', fieldKey: 'rule-key', onDraft: () => {}, onChange: () => {},
  })
  const html = render(ponytailRule)
  assert.match(html, /data-step="if"/)
  assert.match(html, /data-step="branch"/, '分支节点成为一等公民，不再落到未知动作')
  assert.match(html, /hidden=""/)
  assert.match(html, /PONYTAIL:readonly/)
  const unsupported = render({ ...ponytailRule, layer: 'system-section' })
  assert.match(unsupported, /不能使用条件分支/, '注册制层禁用条件分支并说明原因')
})
