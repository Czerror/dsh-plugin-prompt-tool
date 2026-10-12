/**
 * 指令文件卡的「设置」页签回归（T22）：展开指令卡必须有设置页签，里面的
 * 「指令路径提示」（`param.instructionHint`）必须照旧可读写。
 *
 * 判据（RED 现场，浏览器实测复核）：d86eea76 删掉 `renderInstructionSettings`
 * 后，`RulesWorkspace` 渲染指令卡时不再传 `renderLayerSettings`，
 * `PromptConfigNavigation` 因此不 push `settings` 页签 —— 用户只剩「内容」页签。
 * 本机实例里四个模块都没有 pre-step 规则卡，所以指令卡是该参数组**唯一**的落点。
 *
 * 断言分两层：① `RulesWorkspace` 层——页签本身在不在（调用方观察到的行为）；
 * ② `injectionPointSlots.renderInstructionSettings` 层——主语按启用模块逐个给出
 * （阶段 4 删掉全局「当前模块」后，指令卡没有唯一主语，不能只渲染一份）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderElement, withSsr, makeTranslate } from './support/ssr-render.mjs'
import { createWorkspaceDrafts } from '../../src/client/data/workspace-drafts.ts'
import { EMPTY_PARAMS } from '../../src/client/data/param-overrides.ts'

const t = makeTranslate()
const { RulesWorkspace } = await withSsr([
  new URL('../../src/client/features/prompts/RulesWorkspace.tsx', import.meta.url).href,
])
const { injectionPointSlots } = await withSsr([
  new URL('../../src/client/app/workspace/pages/InjectionPointsPanel.tsx', import.meta.url).href,
])

const facts = (editable = true) => ({ declaredModules: [], effectiveModules: [], rowIds: [], sourceMode: 'explicit', editable, subagentToolPolicyEnabled: false })
const moduleA = { id: 'mod-a', name: 'A', enabled: true, declares: ['rules'], facts: facts() }
const moduleB = { id: 'mod-b', name: 'B', enabled: true, declares: ['rules'], facts: facts() }
const moduleOff = { id: 'mod-off', name: 'off', enabled: false, declares: ['rules'], facts: facts() }

/** 指令文件卡：`origin.kind = 'instruction-file'` 即 `instructionFileIdOf` 认得的形态。 */
const instructionCard = {
  id: 'agents-md',
  name: 'AGENTS: ~/dsh/AGENTS.md',
  layer: 'pre-step',
  origin: { kind: 'instruction-file', fileId: 'agents-md', displayPath: '~/.dsh/AGENTS.md' },
  contentStatus: 'ready',
  text: '# 全局入口',
}

const stubStore = (modules = [moduleA]) => {
  const fields = { modulesEnabled: true, promptConfigs: [instructionCard] }
  return {
    fields,
    // 指令卡要渲染正文与页签，必须给齐 `fieldPolicyFor` 读的字段能力表（省了它＝渲染期抛错，不是本次回归）。
    meta: { layers: ['pre-step'], modules, layerFieldPolicies: {}, fills: [] },
    editorDrafts: createWorkspaceDrafts(),
    instructionPolicy: { error: undefined },
    showNotice: () => {},
    getFields: () => fields,
    subscribeFields: () => () => {},
    getDraftRevision: () => 0,
    subscribeDrafts: () => () => {},
    publishDrafts: () => {},
    enqueueModuleTask: (_moduleId, task) => task(),
    enqueueRuleTask: (task) => task(),
    moduleParamsOf: () => EMPTY_PARAMS,
    ensureModuleParams: () => {},
    persistInstructionFiles: async () => true,
    reloadInstructionFile: async () => {},
    updateInstructionPolicy: async () => {},
    patch: () => {},
  }
}

const renderWorkspace = (store) => renderElement(RulesWorkspace, {
  store, t,
  browse: { filter: '', expanded: instructionCard.id, viewFilter: 'all', variablesExpanded: false },
  ...injectionPointSlots({ store, t, viewFilter: 'all', audience: 'main' }),
})

/** 直接渲染设置区内容（页签内容首次点击才挂载，SSR 看不到 tabpanel 里那一层）。 */
const renderSettings = (store) => {
  const slots = injectionPointSlots({ store, t, viewFilter: 'all', audience: 'main' })
  assert.equal(typeof slots.renderInstructionSettings, 'function', '有启用模块就该有指令卡设置区')
  return renderElement(function Probe() { return slots.renderInstructionSettings(instructionCard) }, {})
}

test('指令卡：展开后有「设置」页签（d86eea76 删掉 renderInstructionSettings 的回归）', () => {
  const html = renderWorkspace(stubStore())
  assert.match(html, /data-config-tab="content"/, '内容页签照旧在场')
  assert.match(html, /data-config-tab="settings"/, '设置页签必须在场（用户报的就是它整块消失）')
})

test('指令卡：没有启用模块时不生成空设置页签', () => {
  const html = renderWorkspace(stubStore([moduleOff]))
  assert.match(html, /data-config-tab="content"/, '内容页签照旧在场')
  assert.doesNotMatch(html, /data-config-tab="settings"/, '没有主语就没有可设置的内容，不留空页签')
})

test('指令卡设置区：参数组与路径指引控件在场，主语逐个启用模块（不是「唯一模块」回落）', () => {
  const html = renderSettings(stubStore([moduleA, moduleB, moduleOff]))
  assert.match(html, /data-layer-param-group="prompt-defaults"/, '提示词默认值＝路径指引设置所属参数组')
  assert.match(html, /data-layer-param-fields="prompt-defaults"/, '参数控件渲染出来（不是空壳）')
  assert.match(html, /data-param-key="instructionHint"/, '路径指引控件＝既有 instructionHint')
  assert.match(html, /data-instruction-module="mod-a"/, '每个启用模块各一份，主语＝该模块')
  assert.match(html, /data-instruction-module="mod-b"/, '第二个启用模块同样在场')
  assert.doesNotMatch(html, /data-instruction-module="mod-off"/, '未启用模块不进设置区')
  assert.equal((html.match(/data-layer-param-group="prompt-defaults"/g) ?? []).length, 2, '一份／模块，不合并成一份')
  assert.match(html, new RegExp(t('rules.source', { module: 'mod-a' })), '模块名可见，两份控件能分辨')
})
