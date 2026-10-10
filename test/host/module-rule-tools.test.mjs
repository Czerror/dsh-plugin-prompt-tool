import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Document, parse } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-module-rule-tools-')
const { resolveModuleToolTarget } = await import('../../src/host/module-tool-target.ts')
const tick = () => new Promise(resolve => setImmediate(resolve))
const leaf = (id, text) => ({ id, kind: 'inject-text', config: { text } })
const original = {
  id: 'mixed', name: '完整规则', layer: 'pre-step', if: { scope: { audience: 'main' } },
  then: [{ if: { text: { subject: 'userMessage', keys: ['castle'] } }, then: [{ id: 'lore', kind: 'inject-text', config: {
    text: 'OLD', strategy: 'context-activation', position: 'after-all', order: 250, role: 'user',
    params: { keys: ['castle'], secondaryKeys: ['gate'], caseSensitive: true, selectiveLogic: 'AND_ALL',
      activation: { scan: 'history', scanDepth: 4, selective: true, sticky: 2 }, templateEvaluation: true,
      source: { format: 'sillytavern', original: { role: 2, position: 4 } }, custom: { untouched: true } },
  } }], else: [leaf('nested-else', 'NESTED')] }, { id: 'request', kind: 'request-params', patch: { maxTokens: 512 } }],
  else: [leaf('fallback', 'FALLBACK')],
}

async function setup(t, id, { late = false, rebuild = async () => {} } = {}) {
  const dir = join(moduleRoot, id), file = join(dir, 'module.yml')
  mkdirSync(dir, { recursive: true })
  const doc = new Document({ id, modules: [], rules: [original], configOrder: { mixed: 40 }, variables: { owner: 'KEEP', empty: '' }, customFuture: { keep: true } })
  doc.commentBefore = 'module comment'
  doc.getIn(['rules', 0, 'then', 0, 'then', 0, 'config', 'text'], true).comment = 'leaf comment'
  writeFileSync(file, doc.toString())
  const { registerModuleRuleTools } = await import('../../src/runtime/module-rule-tools.ts')
  const shell = await import('../../engine/module-rule-tools.mjs')
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  t.after(() => root.fiber.dispose())
  const agent = { id: 'agent-' + id, session: { id: 'session-' + id, header: {} } }
  const scope = createScope(root, agent)
  agent.ctx = scope.ctx
  const targets = { ids: [id] }
  const host = { target: exec => resolveModuleToolTarget(exec, moduleRoot, () => targets.ids), rebuild }
  const install = () => root.plugin(ctx => { ctx.provide('pt-module-rule-tools', { mount: context => registerModuleRuleTools(context, host) }) })
  const wrapper = await scope.ctx.plugin(shell)
  if (!late) { await install(); await tick() }
  let calls = 0
  const call = (name, args = {}, signal = new AbortController().signal) => root.tools.execute({ callId: 'call-' + ++calls, name, arguments: args, agent, signal })
  const success = async (name, args) => { const result = await call(name, args); assert.equal(result.isError, false, JSON.stringify(result)); return result.value }
  return { root, scope, agent, targets, wrapper, install, call, success, file, dir }
}

test('规则工具完整往返：嵌套/else/来源参数和注释保留，开关与显式删除只作用目标规则', async t => {
  const rebuilt = []
  const f = await setup(t, 'roundtrip', { rebuild: async id => { rebuilt.push(id) } })
  const before = await f.success('module_rules_read')
  assert.equal(before.moduleId, 'roundtrip')
  f.targets.ids = ['roundtrip', 'unrelated-module']
  assert.equal((await f.success('module_rules_read')).moduleId, 'roundtrip', '多模块配装只取受控记录首项')
  assert.deepEqual(before.rules, [original])
  assert.ok(before.meta.actions.some(action => action.kind === 'inject-text'))
  const changed = structuredClone(before.rules[0])
  changed.then[0].then[0].config.text = 'UPDATED'
  const saved = await f.success('module_rules_edit', { expectedModuleId: before.moduleId, expectedRevisions: before.revisions, edits: [{ previousId: 'mixed', rule: changed }] })
  assert.equal(saved.persisted, true)
  const after = await f.success('module_rules_read')
  assert.deepEqual(after.rules, [changed], '读取原始声明，不写回编译默认值或投影身份')
  const text = readFileSync(f.file, 'utf8')
  for (const comment of ['module comment', 'leaf comment']) assert.ok(text.includes(comment))
  assert.deepEqual(parse(text).configOrder, { mixed: 40 })
  assert.deepEqual(parse(text).variables, { owner: 'KEEP', empty: '' }, '规则保存不覆盖已有变量和空占位')
  assert.deepEqual(parse(text).customFuture, { keep: true })
  const disabled = await f.success('module_rules_edit', { expectedModuleId: before.moduleId, expectedRevisions: after.revisions, edits: [{ previousId: 'mixed', rule: { ...changed, enabled: false }, settingsChanged: true }] })
  assert.equal(disabled.rules[0].enabled, false)
  const activated = await f.success('module_rules_edit', { expectedModuleId: before.moduleId, expectedRevisions: disabled.revisions, activateRuleId: 'mixed' })
  assert.equal(activated.rules[0].enabled, true)
  const deleted = await f.success('module_rules_edit', { expectedModuleId: before.moduleId, expectedRevisions: activated.revisions, edits: [{ previousId: 'mixed', rule: null }] })
  assert.deepEqual(deleted.rules, [])
  assert.equal(parse(readFileSync(f.file, 'utf8')).configOrder, undefined)
  assert.deepEqual(rebuilt, ['roundtrip', 'roundtrip', 'roundtrip', 'roundtrip'])
})

test('规则工具拒绝：目标漂移、未配装、旧版本、未知字段、非法空 then 和取消均零提交', async t => {
  const f = await setup(t, 'reject')
  const before = await f.success('module_rules_read')
  const bytes = readFileSync(f.file, 'utf8')
  for (const request of [
    { expectedModuleId: 'other', edits: [] },
    { expectedRevisions: {}, edits: [{ previousId: 'mixed', rule: original }] },
    { edits: [{ previousId: 'mixed', rule: { ...original, then: [] } }] },
    { expectedRevision: 'old', edits: [] },
    { edits: [], path: 'outside' },
    { refreshOnly: true, expectedRevisions: { unexpected: 'bad' } },
  ]) {
    const result = await f.call('module_rules_edit', { expectedModuleId: before.moduleId, expectedRevisions: before.revisions, ...request })
    assert.equal(result.isError, true, JSON.stringify(result))
    assert.equal(readFileSync(f.file, 'utf8'), bytes)
  }
  f.targets.ids = []
  assert.equal((await f.call('module_rules_read')).isError, true)
  f.targets.ids = ['reject']
  const abort = new AbortController()
  abort.abort()
  assert.equal((await f.call('module_rules_edit', { expectedModuleId: 'reject', expectedRevisions: before.revisions, edits: [{ previousId: 'mixed', rule: null }] }, abort.signal)).isError, true)
  assert.equal(readFileSync(f.file, 'utf8'), bytes)
  const saved = await f.success('module_rules_edit', { expectedModuleId: 'reject', expectedRevisions: before.revisions, edits: [{ previousId: 'mixed', rule: { ...original, name: 'NEW' } }] })
  const current = readFileSync(f.file, 'utf8')
  assert.notDeepEqual(saved.revisions, before.revisions)
  assert.equal((await f.call('module_rules_edit', { expectedModuleId: 'reject', expectedRevisions: before.revisions, edits: [{ previousId: 'mixed', rule: original }] })).isError, true)
  assert.equal(readFileSync(f.file, 'utf8'), current)
})

test('规则工具边界：晚到服务挂载，刷新失败报告已保存，重试只发布，卸载后不可调用', async t => {
  let failures = true, refreshes = 0
  const f = await setup(t, 'lifecycle', { late: true, rebuild: async () => { refreshes++; if (failures) throw new Error('refresh failed') } })
  assert.equal(f.root.tools.get('module_rules_read', f.agent), undefined)
  const provider = await f.install()
  await tick()
  const before = await f.success('module_rules_read')
  const changed = { ...original, name: 'COMMITTED' }
  const pending = await f.success('module_rules_edit', { expectedModuleId: before.moduleId, expectedRevisions: before.revisions, edits: [{ previousId: 'mixed', rule: changed }] })
  assert.equal(pending.persisted, true)
  assert.equal(pending.publicationPending, true)
  assert.equal(parse(readFileSync(f.file, 'utf8')).rules[0].name, 'COMMITTED')
  failures = false
  const bytes = readFileSync(f.file, 'utf8')
  const published = await f.success('module_rules_edit', { expectedModuleId: before.moduleId, expectedRevisions: pending.revisions, refreshOnly: true })
  assert.equal(published.publicationPending, false)
  assert.equal(readFileSync(f.file, 'utf8'), bytes)
  assert.equal(refreshes, 2)
  await provider.dispose()
  await tick()
  assert.equal((await f.call('module_rules_read')).isError, true)
  await f.install()
  await tick()
  assert.equal(f.root.tools.schemas(f.agent).filter(tool => tool.name === 'module_rules_read').length, 1)
  await f.wrapper.dispose()
  await tick()
  assert.equal((await f.call('module_rules_edit', { expectedModuleId: before.moduleId, expectedRevisions: pending.revisions, refreshOnly: true })).isError, true)
})
