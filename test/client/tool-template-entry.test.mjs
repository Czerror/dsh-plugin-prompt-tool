/**
 * T18 追加：自定义工具卡的「添加工具模板…」入口仍在（原形态就是卡内，不是页级菜单）。
 *
 * 重点路径：**未声明 `customTools`** 的模块 → 添加入口 → 创建模式渲染该卡 →
 * 卡内入口必须在（否则这条路是死的）。主语＝该卡所属模块，由入口回调回传。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderElement, withSsr, makeTranslate } from './support/ssr-render.mjs'
import { createWorkspaceDrafts } from '../../src/client/data/workspace-drafts.ts'

const t = makeTranslate()
const { LayerSettingsContent } = await withSsr([
  new URL('../../src/client/app/workspace/pages/InjectionPointsPanel.tsx', import.meta.url).href,
])

const facts = (editable = true) => ({ declaredModules: [], effectiveModules: [], rowIds: [], sourceMode: 'explicit', editable })

/** 声明面未下发（老载荷／未知）＝照旧出卡；这里给「已声明 customTools」的对照用。 */
const stubStore = (declares) => {
  const fields = { modulesEnabled: true, promptConfigs: [] }
  return {
    fields,
    meta: { layers: [], modules: [{ id: 'mod-a', name: 'A', enabled: true, facts: facts(), declares }] },
    editorDrafts: createWorkspaceDrafts(),
    showNotice: () => {},
    getFields: () => fields,
    subscribeFields: () => () => {},
    getDraftRevision: () => 0,
    subscribeDrafts: () => () => {},
    publishDrafts: () => {},
    enqueueRuleTask: (task) => task(),
    moduleParamsOf: () => ({ values: {}, baseline: {} }),
    moduleVariables: () => ({ scope: 'module', values: {}, inherited: {}, enabled: true, loading: false, error: '', publicationPending: false }),
    ensureModuleParams: () => {},
    ensureModuleVariables: () => {},
  }
}

test('未声明 customTools 的模块：创建模式卡内仍有「添加工具模板…」入口', () => {
  const store = stubStore(['rules'])
  const seen = []
  const html = renderElement(LayerSettingsContent, {
    store, t, layer: 'tool-pipeline', moduleId: 'mod-a',
    creatingSections: ['custom-tools'],
    onChooseToolTemplate: (moduleId, anchor) => { seen.push([moduleId, anchor]) },
  })
  assert.match(html, /data-layer-asset="custom-tools"/, '创建模式渲染该卡')
  assert.match(html, new RegExp(`>${t('main.addToolTemplate')}<`), '卡内「添加工具模板…」入口在场')
  assert.match(html, new RegExp(`>${t('main.newBlankTool')}<`), '同一排的「新建空白工具」也在（入口成对）')
  assert.deepEqual(seen, [], '没有点击就不触发回调')
})

test('入口缺席（没有编排时）不渲染死按钮；回调在时不缺', () => {
  const store = stubStore(['rules'])
  const without = renderElement(LayerSettingsContent, {
    store, t, layer: 'tool-pipeline', moduleId: 'mod-a', creatingSections: ['custom-tools'],
  })
  assert.match(without, /data-layer-asset="custom-tools"/, '卡仍在场')
  assert.doesNotMatch(without, new RegExp(`>${t('main.addToolTemplate')}<`), '没有入口绑定时不渲染这个按钮（不是死按钮）')
})
