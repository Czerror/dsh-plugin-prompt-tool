import test from 'node:test'
import assert from 'node:assert/strict'
import { withSsr } from './support/ssr-render.mjs'
import { EDIT_TARGET_HEADER } from '../../src/shared/bridge-contract.ts'

const { createTemplateRule, createTemplateRuleWriter, applyTemplatePublicationState } = await withSsr([
  new URL('../../src/client/features/prompts/useTemplatePicker.tsx', import.meta.url).href,
])
const { createWorkspaceDrafts } = await import('../../src/client/data/workspace-drafts.ts')

const rule = { id: 'budget', enabled: false, then: [] }
const ok = (value) => new Response(JSON.stringify({ ok: true, value }), { status: 200 })
const failure = (code, message) => new Response(JSON.stringify({ ok: false, code, message }), { status: 409 })

async function withFetch(responses, run) {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return Array.isArray(responses) ? responses.shift() : responses
  }
  try { return await run(calls) } finally { globalThis.fetch = originalFetch }
}

test('成功的空白模块首写覆盖陈旧声明快照，后续模板写入省略 absent 前置', async () => {
  const writeTemplateRule = createTemplateRuleWriter()
  const staleMeta = [{ id: 'blank-2', declares: [] }]
  await withFetch([
    ok({ createdRuleId: 'budget', rules: [rule] }),
    ok({ createdRuleId: 'budget-2', rules: [rule] }),
  ], async (calls) => {
    assert.equal((await writeTemplateRule('blank-2', rule, staleMeta)).ok, true)
    assert.equal((await writeTemplateRule('blank-2', rule, staleMeta)).ok, true)
    assert.equal(JSON.parse(calls[0].init.body).expectedRulesAbsent, true)
    assert.equal(Object.hasOwn(JSON.parse(calls[1].init.body), 'expectedRulesAbsent'), false)
  })
})

test('失败的空白模块首写不会记为已声明，重试仍要求 absent 前置', async () => {
  const writeTemplateRule = createTemplateRuleWriter()
  const staleMeta = [{ id: 'blank-2', declares: [] }]
  await withFetch([
    failure('rules-conflict', '规则声明冲突'),
    ok({ createdRuleId: 'budget', rules: [rule] }),
  ], async (calls) => {
    assert.equal((await writeTemplateRule('blank-2', rule, staleMeta)).ok, false)
    assert.equal((await writeTemplateRule('blank-2', rule, staleMeta)).ok, true)
    for (const call of calls) assert.equal(JSON.parse(call.init.body).expectedRulesAbsent, true)
  })
})

test('成功首写更新共享声明快照，另一模板 writer 省略 absent 前置', async () => {
  const modules = [{ id: 'blank-2', declares: [] }]
  const markModuleDeclared = (moduleId, section) => {
    const module = modules.find(candidate => candidate.id === moduleId)
    if (module && !module.declares.includes(section)) module.declares.push(section)
  }
  const firstWriter = createTemplateRuleWriter(markModuleDeclared)
  const secondWriter = createTemplateRuleWriter(markModuleDeclared)
  await withFetch([
    ok({ createdRuleId: 'budget', rules: [rule] }),
    ok({ createdRuleId: 'budget-2', rules: [rule] }),
  ], async (calls) => {
    assert.equal((await firstWriter('blank-2', rule, modules)).ok, true)
    assert.equal((await secondWriter('blank-2', rule, modules)).ok, true)
    assert.equal(Object.hasOwn(JSON.parse(calls[1].init.body), 'expectedRulesAbsent'), false)
  })
})

test('新建模块未出现在旧 meta 时，显式 rulesAbsent 集合仍发送 absent 前置', async () => {
  const createdModuleIds = new Set(['blank-3'])
  const writeTemplateRule = createTemplateRuleWriter(undefined, createdModuleIds)
  await withFetch([
    failure('rules-conflict', '规则声明冲突'),
    ok({ createdRuleId: 'budget', rules: [rule] }),
  ], async (calls) => {
    assert.equal((await writeTemplateRule('blank-3', rule, [])).ok, false)
    assert.equal((await writeTemplateRule('blank-3', rule, [])).ok, true)
    for (const call of calls) assert.equal(JSON.parse(call.init.body).expectedRulesAbsent, true)
    assert.equal(createdModuleIds.has('blank-3'), false)
  })
})

test('模板规则写入按显式 moduleId 发起 createRule，空白模块携带 absent 前置', async () => {
  await withFetch(ok({ createdRuleId: 'budget', rules: [rule] }), async (calls) => {
    const result = await createTemplateRule('blank-2', rule, false)
    assert.equal(result.ok, true)
    assert.equal(result.value.createdRuleId, 'budget')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].init.headers[EDIT_TARGET_HEADER], 'blank-2')
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      expectedModuleId: 'blank-2',
      expectedRulesAbsent: true,
      createRule: rule,
    })
  })
})

test('已有 rules 的模板写入不要求客户端 revisions 或规则读回', async () => {
  await withFetch(ok({ createdRuleId: 'budget-2', rules: [rule] }), async (calls) => {
    const result = await createTemplateRule('module-z', rule, true)
    assert.equal(result.ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].init.headers[EDIT_TARGET_HEADER], 'module-z')
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      expectedModuleId: 'module-z',
      createRule: rule,
    })
  })
})

test('声明快照未知时不伪造 rulesAbsent 前置', async () => {
  await withFetch(ok({ createdRuleId: 'budget', rules: [rule] }), async (calls) => {
    const result = await createTemplateRule('module-z', rule, undefined)
    assert.equal(result.ok, true)
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      expectedModuleId: 'module-z',
      createRule: rule,
    })
  })
})

test('模板规则写入保留目标身份冲突载荷', async () => {
  await withFetch(failure('module-changed', '目标模块已变化'), async (calls) => {
    const result = await createTemplateRule('module-z', rule, true)
    assert.deepEqual(result, { ok: false, code: 'module-changed', message: '目标模块已变化' })
    assert.equal(calls[0].init.headers[EDIT_TARGET_HEADER], 'module-z')
  })
})

test('发布失败为未挂载目标建立共享规则草稿，保留 refreshOnly 状态', () => {
  const drafts = createWorkspaceDrafts()
  const draft = applyTemplatePublicationState(drafts, 'module-z', {
    publicationPending: true,
    publicationError: '运行刷新失败',
  })
  assert.equal(drafts.rules.get('module-z'), draft)
  assert.equal(draft.loaded, false, '未挂载目标仍等待后续规则读回')
  assert.equal(draft.publicationPending, true)
  assert.equal(draft.publicationError, '运行刷新失败')
  assert.equal(draft.error, '运行刷新失败')
})
