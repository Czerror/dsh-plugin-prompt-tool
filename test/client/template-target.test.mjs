/**
 * T18 页级创建入口回归：一处页级下拉「添加」+ 选完模板**只加一步**选目标。
 *
 * 判据：页级下拉「添加」是创建的唯一入口（每模块横栏 `data-module-create` 形态已随实现删除，
 * 不再断言其缺席）；选完模板**只加一步**选目标，候选只列可写模块、新建分支不接受名字输入。
 * 点击类交互（下拉展开、真机里建出的模块出现在 /meta）SSR 断言不了，交真机。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderElement, withSsr, makeTranslate } from './support/ssr-render.mjs'
import { createWorkspaceDrafts } from '../../src/client/data/workspace-drafts.ts'
import { blankModuleTargetValid, createBlankModule, isWritableTarget, writableModuleTargets } from '../../src/client/data/module-subject.ts'

const t = makeTranslate()
const { RulesWorkspace } = await withSsr([
  new URL('../../src/client/features/prompts/RulesWorkspace.tsx', import.meta.url).href,
])
const { applyCreateWrite, planCreateWrite } = await withSsr([
  new URL('../../src/client/features/prompts/useTemplatePicker.tsx', import.meta.url).href,
])

const facts = (editable = true) => ({ declaredModules: [], effectiveModules: [], rowIds: [], sourceMode: 'explicit', editable })
/**
 * 只有前两个可写；`mod-z` 未启用、`mod-ro` 只读——两者都不该出现在候选里。
 * `blank` 代表「用户根下已有名为 blank 的目录」（历史上被种子化过，或用户从引擎内组装的空白
 * 模板建过模块）：它同样不是候选，但它决定新建 id 的预览（目录名已存在 ⇒ 服务端会加后缀）。
 */
const modules = [
  { id: 'mod-a', name: 'A', enabled: true, facts: facts(), declares: ['rules'] },
  { id: 'mod-b', name: 'B', enabled: true, facts: facts(), declares: ['rules'] },
  { id: 'mod-z', name: 'Z', enabled: false, facts: facts(), declares: ['rules'] },
  { id: 'mod-ro', name: 'RO', enabled: true, facts: facts(false), declares: ['rules'] },
  { id: 'blank', name: '空白模块', enabled: false, facts: facts(), declares: [] },
]

const stubStore = () => {
  const fields = { modulesEnabled: true, promptConfigs: [] }
  const editorDrafts = createWorkspaceDrafts()
  for (const { id } of modules) {
    editorDrafts.rules.set(id, { entries: [], saved: [], fields: new Map(), loaded: true, validated: false, sequence: 0, nextKey: 0 })
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

test('目标候选只列**可写**模块：未启用与只读都不提供（不是可选后静默丢弃）', () => {
  const html = renderElement(RulesWorkspace, { store: stubStore(), t, addingTarget: true })
  assert.match(html, new RegExp(`aria-label="${t('rules.create.title')}"`), '目标选择对话框在场')
  for (const id of ['mod-a', 'mod-b']) {
    assert.match(html, new RegExp(`data-template-target="${id}"`), `列出可写模块 ${id}`)
  }
  assert.doesNotMatch(html, /data-template-target="mod-z"/, '未启用模块不作为候选（写不进去＝不许列）')
  assert.doesNotMatch(html, /data-template-target="mod-ro"/, '只读模块不作为候选（存不下去＝不许列）')
  assert.doesNotMatch(html, /data-template-target="blank"/, '复制源不是候选（它未启用，也不是新建出来的模块）')
  assert.match(html, /data-template-new-module/, '新建空白模块分支存在')
  // 工具栏的搜索框不算：只看「新建空白模块」那一段里有没有输入框。
  assert.doesNotMatch(html.slice(html.indexOf('data-template-new-module')), /<input/, '新建分支没有任何输入框（名字由服务端定）')
  // 预览文案的期望值取自 locales 词条（独立真值源）：blank-2 是场景事实，不在测试里重算预览算法。
  assert.match(html, new RegExp(t('rules.create.newHint', { id: 'blank-2' })), '预览按「已存在目录」判定：用户根下已有 blank → blank-2')
})

test('可写判据（候选过滤与写前第二道闸共用同一实现）', () => {
  const fields = { modulesEnabled: true }
  const ids = writableModuleTargets(fields, modules).map((module) => module.id)
  assert.deepEqual(ids, ['mod-a', 'mod-b'], '候选＝启用 + 可编辑 + 可渲染')
  assert.equal(isWritableTarget(fields, modules, 'mod-a'), true)
  assert.equal(isWritableTarget(fields, modules, 'mod-z'), false, '未启用不可写（它的编辑器不在装配集合里）')
  assert.equal(isWritableTarget(fields, modules, 'mod-ro'), false, '只读不可写')
  assert.equal(isWritableTarget(fields, modules, 'mod-missing'), false)
  assert.equal(isWritableTarget({ modulesEnabled: false }, modules, 'mod-a'), false, '总闸关闭时谁都不写')
})

test('写判定：不可写＝拒绝（先判可写再判读回），可写但未读回才允许等', () => {
  assert.equal(planCreateWrite({ writable: false, ownerFound: false, ownerLoaded: false }), 'reject')
  assert.equal(planCreateWrite({ writable: false, ownerFound: true, ownerLoaded: true }), 'reject', '就算编辑器碰巧在场，不可写仍然拒绝')
  assert.equal(planCreateWrite({ writable: true, ownerFound: false, ownerLoaded: false }), 'pending', '新建模块要等下一帧的编辑器')
  assert.equal(planCreateWrite({ writable: true, ownerFound: true, ownerLoaded: false }), 'pending')
  assert.equal(planCreateWrite({ writable: true, ownerFound: true, ownerLoaded: true }), 'write')
})

test('写不进去时只报失败：不落草稿、不报成功、不静默挂起', () => {
  const events = []
  const outcome = applyCreateWrite({
    plan: 'reject',
    add: () => events.push('add'),
    onOk: () => events.push('ok'),
    onError: () => events.push('error'),
  })
  assert.equal(outcome, 'rejected')
  assert.deepEqual(events, ['error'], '只有失败提示：既不写草稿，也不先弹成功')
  // 对照：可写且已读回＝先落草稿再报成功（顺序固定）；pending＝什么都不报。
  const order = []
  assert.equal(applyCreateWrite({ plan: 'write', add: () => order.push('add'), onOk: () => order.push('ok'), onError: () => order.push('error') }), 'written')
  assert.deepEqual(order, ['add', 'ok'], '成功提示必须在写入之后')
  const silent = []
  assert.equal(applyCreateWrite({ plan: 'pending', add: () => silent.push('add'), onOk: () => silent.push('ok'), onError: () => silent.push('error') }), 'pending')
  assert.deepEqual(silent, [], '等读回期间不报任何结果')
})

test('新建空白模块复用既有动作：只走 clone + enable，id 由服务端返回', async () => {
  const calls = []
  const call = async (endpoint, body) => {
    calls.push({ endpoint, body })
    return endpoint === 'moduleClone' ? { ok: true, value: { id: 'blank-2' } } : { ok: true, value: { enabled: ['blank-2'] } }
  }
  assert.equal(await createBlankModule(call), 'blank-2', '返回服务端定的新模块 id')
  assert.deepEqual(calls, [
    { endpoint: 'moduleClone', body: { id: 'blank', autoSuffix: true } },
    { endpoint: 'moduleEnable', body: { id: 'blank-2', enabled: true } },
  ], '只复用既有 clone + enable，不新增创建通道')
  const failing = async () => ({ ok: false, message: 'nope' })
  assert.equal(await createBlankModule(failing), undefined, '新建失败不上报成功')
  assert.equal(blankModuleTargetValid(), true, '复制源模板 id 自己是合法模块 id（唯一进路径的值）')
})
