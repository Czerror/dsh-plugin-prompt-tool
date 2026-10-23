/**
 * T18 页级创建入口回归：一处页级下拉「添加」+ 选完模板**只加一步**选目标。
 *
 * 判据：页级下拉「添加」是创建的唯一入口（每模块横栏 `data-module-create` 形态已随实现删除，
 * 不再断言其缺席）；选完模板**只加一步**选目标，候选列出所有可写用户模块、新建分支不接受名字输入。
 * 点击类交互（下拉展开、真机里建出的模块出现在 /meta）SSR 断言不了，交真机。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderElement, withSsr, makeTranslate } from './support/ssr-render.mjs'
import { createWorkspaceDrafts } from '../../src/client/data/workspace-drafts.ts'
import { isWritableTarget } from '../../src/client/data/module-subject.ts'

const t = makeTranslate()
const { RulesWorkspace } = await withSsr([
  new URL('../../src/client/features/prompts/RulesWorkspace.tsx', import.meta.url).href,
])
const facts = (editable = true) => ({ declaredModules: [], effectiveModules: [], rowIds: [], sourceMode: 'explicit', editable })
/**
 * `mod-z` 与 `blank` 未启用但仍是可写用户目标；`mod-ro`、非用户目录与损坏模块不可选。
 * `blank` 代表模块根下已有名为 blank 的目录（历史上被种子化过，或用户从引擎内组装的空白
 * 模板建过模块）：它仍是有效用户目标，同时决定新建 id 的预览（目录名已存在 ⇒ 服务端会加后缀）。
 */
const modules = [
  { id: 'mod-a', name: 'A', user: true, renderable: true, enabled: true, facts: facts(), declares: ['rules'] },
  { id: 'mod-b', name: 'B', user: true, renderable: true, enabled: true, facts: facts(), declares: ['rules'] },
  { id: 'mod-z', name: 'Z', user: true, renderable: true, enabled: false, facts: facts(), declares: ['rules'] },
  { id: 'mod-ro', name: 'RO', user: true, renderable: true, enabled: true, facts: facts(false), declares: ['rules'] },
  { id: 'blank', name: '空白模块', user: true, renderable: true, enabled: false, facts: facts(), declares: [] },
  { id: 'builtin', name: 'Built in', user: false, renderable: true, enabled: true, facts: facts(), declares: ['rules'] },
  { id: 'broken', name: 'Broken', user: true, renderable: false, enabled: false, broken: 'invalid', declares: ['rules'] },
]

const stubStore = (modulesEnabled = true) => {
  const fields = { modulesEnabled, instructionCards: [] }
  const editorDrafts = createWorkspaceDrafts()
  for (const { id } of modules) {
    editorDrafts.rules.set(id, { entries: [], saved: [], fields: new Map(), loaded: true, validated: false, latest: 0, nextKey: 0 })
  }
  return {
    fields,
    meta: { layers: [], modules },
    editorDrafts,
    showNotice: () => {},
    getFields: () => fields,
    subscribeFields: () => () => {},
    getDraftRevision: () => 0,
    subscribeDrafts: () => () => {},
    publishDrafts: () => {},
    enqueueRuleTask: (task) => task(),
    load: async () => fields,
  }
}

/** 页级「添加」下拉的创建项（与页面接线同形：按注入层一组菜单项）。 */
const createItems = ['pre-step', 'system-section'].map((layer) => ({ id: `tpl:${layer}`, label: t('main.addTemplate', { layer }) }))

test('页级下拉「添加」在工具栏里（入口接线见 module-asset-subject 的页级用例）', () => {
  const html = renderElement(RulesWorkspace, { store: stubStore(), t, createItems })
  assert.match(html, /data-module-toolbar/, '工具栏仍在场')
  assert.match(html, /data-engine-add-menu/, '页级下拉「添加」存在（页级创建的唯一入口）')
})

test('目标候选不受总闸和启用状态影响，但过滤只读、非用户和损坏模块', () => {
  const html = renderElement(RulesWorkspace, { store: stubStore(false), t, addingTarget: true })
  assert.match(html, new RegExp(`aria-label="${t('rules.create.title')}"`), '目标选择对话框在场')
  for (const id of ['mod-a', 'mod-b']) {
    assert.match(html, new RegExp(`data-template-target="${id}"`), `列出可写模块 ${id}`)
  }
  for (const id of ['mod-z', 'blank']) {
    assert.match(html, new RegExp(`data-template-target="${id}"`), `未启用的可写用户模块 ${id} 可作为目标`)
  }
  assert.doesNotMatch(html, /data-template-target="mod-ro"/, '只读模块不作为候选（存不下去＝不许列）')
  assert.doesNotMatch(html, /data-template-target="builtin"/, '非用户目录模块不作为目标')
  assert.doesNotMatch(html, /data-template-target="broken"/, '损坏模块不作为目标')
  assert.match(html, /data-template-new-module/, '新建空白模块分支存在')
  // 工具栏的搜索框不算：只看「新建空白模块」那一段里有没有输入框。
  assert.doesNotMatch(html.slice(html.indexOf('data-template-new-module')), /<input/, '新建分支没有任何输入框（名字由服务端定）')
  // 预览文案的期望值取自 locales 词条（独立真值源）：blank-2 是场景事实，不在测试里重算预览算法。
  assert.match(html, new RegExp(t('rules.create.newHint', { id: 'blank-2' })), '预览按「已存在目录」判定：用户根下已有 blank → blank-2')
})

test('目标写判据（候选过滤与写前第二道闸共用同一实现）', () => {
  assert.equal(isWritableTarget(modules, 'mod-a'), true)
  assert.equal(isWritableTarget(modules, 'mod-z'), true, '未启用模块仍可显式写入准备定义')
  assert.equal(isWritableTarget(modules, 'blank'), true, '尚无 rules 声明的空白模块仍是合法目标')
  assert.equal(isWritableTarget(modules, 'mod-ro'), false, '只读不可写')
  assert.equal(isWritableTarget(modules, 'builtin'), false, '非用户目录模块不可写')
  assert.equal(isWritableTarget(modules, 'broken'), false, '损坏模块不可写')
  assert.equal(isWritableTarget(modules, 'mod-missing'), false)
})
