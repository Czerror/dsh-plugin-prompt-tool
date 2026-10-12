/**
 * 指令文件卡的「设置」页签与设置区（**全局层**）回归。
 *
 * 判据（用户裁定 2026-10-12）：指令卡是全局段、没有归属模块，它的「指令路径提示」是
 * **一个全局开关**（写存储根 `config.yml` 的 `layerSettings`）；模块自己写了该参数时模块值
 * 优先（存在即覆盖，判定在服务端）。所以这里钉死两件相反方向的事：
 *  ① 页签必须在场——它与启用模块数量无关（`64a66174` 按启用模块逐个渲染的形态已否掉）；
 *  ② 设置区里 `instructionHint` 控件**恰好一个**，且不再有 `data-instruction-module` 分节。
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

const stubStore = (modules = [moduleA], globalParamsLoaded = true) => {
  const fields = { modulesEnabled: true, promptConfigs: [instructionCard] }
  return {
    fields,
    // 指令卡要渲染正文与页签，必须给齐 `fieldPolicyFor` 读的字段能力表（省了它＝渲染期抛错）。
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
    // 全局层主语：指令卡设置区的读数与写通道都走这里（不是某个模块）。
    globalParams: EMPTY_PARAMS,
    globalParamsLoaded,
    setGlobalParam: () => {},
    persistGlobalParams: async () => {},
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
  assert.equal(typeof slots.renderInstructionSettings, 'function', '指令卡是全局段，设置区不依赖启用模块')
  return renderElement(function Probe() { return slots.renderInstructionSettings(instructionCard) }, {})
}

test('指令卡：展开后有「设置」页签（d86eea76 删掉 renderInstructionSettings 的回归）', () => {
  const html = renderWorkspace(stubStore())
  assert.match(html, /data-config-tab="content"/, '内容页签照旧在场')
  assert.match(html, /data-config-tab="settings"/, '设置页签必须在场（用户报的就是它整块消失）')
})

test('指令卡：设置页签与启用模块数量无关（没有启用模块也有全局开关）', () => {
  const html = renderWorkspace(stubStore([moduleOff]))
  assert.match(html, /data-config-tab="content"/, '内容页签照旧在场')
  assert.match(html, /data-config-tab="settings"/, '全局层不属于任何模块：没有启用模块同样有可设置的内容')
  assert.equal((renderSettings(stubStore([moduleOff])).match(/data-param-key="instructionHint"/g) ?? []).length, 1,
    '没有启用模块时仍是那一个全局开关')
})

test('指令卡设置区：只有**一个**全局开关，没有按模块分节（64a66174 的每模块一份已否掉）', () => {
  const html = renderSettings(stubStore([moduleA, moduleB, moduleOff]))
  assert.match(html, /data-param-key="instructionHint"/, '路径指引控件在场')
  assert.equal((html.match(/data-param-key="instructionHint"/g) ?? []).length, 1, '一个开关，不按模块重复')
  assert.doesNotMatch(html, /data-instruction-module/, '不再有按模块分节的设置区')
  assert.doesNotMatch(html, /data-layer-param-group/, '不再借用按模块的层设置内容')
  assert.doesNotMatch(html, /mod-a/, '没有模块名分节标题（卡片主语是全局层）')
  assert.match(html, /aria-label="指令路径提示"/, 'labels 仍是既有词条')
})

test('指令卡设置区：全局值读回前禁写（不把 UI 默认值固化成全局键）', () => {
  assert.match(renderSettings(stubStore([moduleA], false)), /role="switch"[^>]*disabled/, '未读回时禁写')
  assert.doesNotMatch(renderSettings(stubStore([moduleA], true)), /role="switch"[^>]*disabled/, '读回后可写')
})
