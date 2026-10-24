/**
 * 规则事实的页面可见性与世界书筛选回归。
 *
 * 真值源：PLAN 的受众矩阵与手算样例；空集按未知处理，两个页面都显示。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderElement, withSsr, makeTranslate } from './support/ssr-render.mjs'
import { createWorkspaceDrafts } from '../../src/client/data/workspace-drafts.ts'
import { EMPTY_PARAMS } from '../../src/client/data/param-overrides.ts'

const t = makeTranslate()
const { RulesWorkspace } = await withSsr([
  new URL('../../src/client/features/prompts/RulesWorkspace.tsx', import.meta.url).href,
])

const facts = (editable = true) => ({ declaredModules: [], effectiveModules: [], rowIds: [], sourceMode: 'explicit', editable })
const twoModules = [
  { id: 'mod-a', name: 'A', enabled: true, facts: facts() },
  { id: 'mod-b', name: 'B', enabled: true, facts: facts() },
]
const stubStore = (drafts, modules = twoModules) => {
  const fields = { modulesEnabled: true, instructionCards: [] }
  return {
    fields,
    meta: { layers: [], modules },
    editorDrafts: drafts,
    showNotice: () => {},
    getFields: () => fields,
    subscribeFields: () => () => {},
    getDraftRevision: () => 0,
    subscribeDrafts: () => () => {},
    publishDrafts: () => {},
    enqueueRuleTask: (task) => task(),
    moduleParamsOf: () => EMPTY_PARAMS,
  }
}
const rulesDraft = (id) => ({
  entries: [{ key: id, previousId: null, value: { id, name: id, layer: 'tool-pipeline', then: [] } }],
  saved: [], fields: new Map(), loaded: true, validated: true, latest: 1, nextKey: 2,
})

test('受众可见性：else / not / 空集 / 未知受众 / 动作目标', () => {
  const action = { id: 't', kind: 'tool-gate', decision: 'allow' }
  const targetAction = { id: 'target', kind: 'inject-text', config: { layer: 'system-section', audience: 'main', text: 'TARGET' } }
  const cases = [
    {
      id: 'else-rule',
      value: { id: 'else-rule', name: 'else-rule', layer: 'tool-pipeline', if: { scope: { audience: 'main' } }, then: [action], else: [action] },
      visible: { main: true, subagent: true },
    },
    {
      id: 'not-rule',
      value: { id: 'not-rule', name: 'not-rule', layer: 'tool-pipeline', if: { not: { scope: { audience: 'main' } } }, then: [action] },
      visible: { main: false, subagent: true },
    },
    {
      id: 'empty-rule',
      value: { id: 'empty-rule', name: 'empty-rule', layer: 'tool-pipeline', if: { scope: { audience: 'main' } }, then: [{ if: { scope: { audience: 'subagent' } }, then: [action] }] },
      visible: { main: true, subagent: true },
      note: '空集按未知处理，不能把可编辑卡同时藏掉',
    },
    {
      id: 'unknown-rule',
      value: { id: 'unknown-rule', name: 'unknown-rule', layer: 'tool-pipeline', if: { any: [{ scope: { audience: 'main' } }, { anchor: {} }] }, then: [action] },
      visible: { main: true, subagent: true },
    },
    {
      id: 'target-rule',
      value: { id: 'target-rule', name: 'target-rule', layer: 'system-section', then: [targetAction] },
      visible: { main: true, subagent: false },
      note: '动作级 audience 参与收窄',
    },
  ]
  for (const item of cases) {
    const drafts = createWorkspaceDrafts()
    const draft = rulesDraft(item.id)
    draft.entries[0].value = item.value
    drafts.rules.set('mod-a', draft)
    const store = stubStore(drafts, [twoModules[0]])
    for (const scope of ['main', 'subagent']) {
      const html = renderElement(RulesWorkspace, { store, t, scope })
      const message = item.id + ' 在 ' + scope + ' 页' + (item.visible[scope] ? '可见' : '隐藏') + (item.note ? '：' + item.note : '')
      if (item.visible[scope]) assert.match(html, new RegExp(item.id), message)
      else assert.doesNotMatch(html, new RegExp(item.id), message)
    }
  }
})

test('过滤：嵌套 context activation 动作进入世界书筛选', () => {
  const drafts = createWorkspaceDrafts()
  const draft = rulesDraft('world-book')
  draft.entries[0].value = {
    id: 'world-book', name: 'world-book', layer: 'pre-step',
    then: [{
      if: { scope: { audience: 'main' } },
      then: [{ id: 'lore', kind: 'inject-text', config: { layer: 'pre-step', strategy: 'context-activation', text: 'LORE' } }],
    }],
  }
  drafts.rules.set('mod-a', draft)
  const store = stubStore(drafts, [twoModules[0]])
  assert.match(renderElement(RulesWorkspace, { store, t, scope: 'main', viewFilter: 'context-activation' }), /world-book/)
})
