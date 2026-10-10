import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { compileRules } from '../../engine/rule-spec.mjs'
import { mountRuleSources } from '../../engine/rule-runtime.mjs'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-native-template-')
const { readModuleVariables, editModuleVariables } = await import('../../src/host/module-variables.ts')
const { createModuleVariableAdapter } = await import('../../src/runtime/module-variable-adapter.ts')
const rule = (id, text, extra = {}, config = {}) => ({ id, ...extra, then: [{ id: 'text', kind: 'inject-text', config: { layer: 'system-section', text, params: { templateEvaluation: true }, ...config } }] })
let sequence = 0
async function fixture(t, rules, values = {}) {
  const id = `template-${++sequence}`, dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), JSON.stringify({ id, modules: [], variables: values }))
  const root = new Context()
  await root.plugin(SystemPrompt)
  const store = createModuleVariableAdapter(moduleRoot)
  const warnings = []
  const actors = []
  const make = (depth = 0) => {
    const events = [{ type: 'turn/start', seq: 0, data: { turn: 1 } }]
    const agent = { id: `${id}-${actors.length}`, status: 'running', options: {}, session: { id: `${id}-${actors.length}`, header: { delegationDepth: depth }, snapshotEvents: () => events } }
    agent.ctx = createScope(root, agent).ctx
    const controller = new AbortController(), signal = controller.signal
    let release
    const mount = () => {
      release?.()
      release = mountRuleSources(agent.ctx, [{ moduleId: id, rules: compileRules(rules, { moduleId: id, variables: values }) }], { variableStore: store, warnOnce: text => warnings.push(text) })
    }
    mount()
    actors.push(() => release?.())
    return { agent, signal, controller, events, mount, assemble: () => root.systemPrompt.assemble({ agent, scope: agent, signal }) }
  }
  t.after(async () => { for (const release of actors) release(); await root.fiber.dispose() })
  return { id, dir, root, store, warnings, make }
}
const texts = assembly => assembly.sections.map(entry => entry.text)

test('原生模板资格与空占位：禁用和不匹配受众不赋值，后卡读新值，普通变量动态更新无需重挂', async t => {
  const h = await fixture(t, [
    rule('disabled', '{{module.set::leak::DISABLED}}', { enabled: false }),
    rule('child', '{{module.set::leak::CHILD}}', { if: { scope: { audience: 'subagent' } } }),
    rule('counter', '{{module.inc::n}}'),
    rule('module-ops', '{{module.set::total::2}}{{module.add::total::3}}NUM={{module.inc::total}},{{module.dec::total}},{{module.get::total}}'
      + '|{{module.set::list::["a",{"close":"}","items":[1]}]}}{{module.add::list::{{module.get::piece}}}}LIST={{module.get::list}}'
      + '|{{module.set::{{module.get::destination}}::{{module.get::piece}}}}{{module.add::label::-done}}TEXT={{module.get::label}}'
      + '|{{module.set::blank::}}EMPTY={{module.get::blank::DEFAULT}}'),
    rule('global-ops', '{{global.set::globalTotal::8}}{{global.add::globalTotal::2}}GLOBAL={{global.dec::globalTotal}},{{global.inc::globalTotal}},{{global.get::globalTotal}}'
      + '|{{global.set::blank::GLOBAL}}{{global.set::globalBlank::}}EMPTY={{global.get::globalBlank::FALLBACK}}'
      + '|DEFAULT={{global.get::globalDefault::seed}}'),
    rule('reader', 'READ={{module.get::n}}|{{module.get::leak}}|{{placeholder}}'),
    rule('ordinary', 'PLAIN={{later}}|{{placeholder}}', {}, { params: {} }),
    rule('empty-step', '{{placeholder}}', {}, { layer: 'pre-step', position: 'after-all', params: {} }),
    rule('anchored-step', '{{module.inc::anchored}}', {}, { layer: 'pre-step', position: 'after-user' }),
  ], { placeholder: '', n: '0', piece: 'b', destination: 'label' })
  const initialGlobal = readModuleVariables(h.dir).global
  const main = h.make()
  const step = messages => h.root.waterfall(scopeTarget(main.agent, main.agent), 'agent/pre-step', { agent: main.agent, signal: main.signal }, async () => ({ kind: 'enter', messages }))
  assert.deepEqual((await step([])).messages, [], '纯空占位不泄漏原模板正文')
  assert.equal(readModuleVariables(h.dir).module.anchored, undefined, '没有真实用户锚点时模板不写变量')
  const first = texts(await main.assemble())
  assert.ok(first.includes('READ=1||'), first.join('\n'))
  assert.ok(first.includes('PLAIN=|'), first.join('\n'))
  assert.ok(first.includes('NUM=6,5,5|LIST=["a",{"close":"}","items":[1]},"b"]|TEXT=b-done|EMPTY='), first.join('\n'))
  assert.ok(first.includes('GLOBAL=9,10,10|EMPTY=|DEFAULT=seed'), first.join('\n'))
  assert.deepEqual(readModuleVariables(h.dir).module, { placeholder: '', n: '1', piece: 'b', destination: 'label',
    total: '5', list: '["a",{"close":"}","items":[1]},"b"]', label: 'b-done', blank: '' })
  assert.deepEqual(readModuleVariables(h.dir).global, { ...initialGlobal, globalTotal: '10', blank: 'GLOBAL', globalBlank: '', globalDefault: 'seed' })
  assert.equal(readModuleVariables(h.dir).effective.blank, '', '模块空串覆盖全局，get 默认值不能覆写已有空串')
  const snapshot = readModuleVariables(h.dir)
  editModuleVariables(h.dir, { scope: 'module', changes: { later: 'NEW', placeholder: '' }, expectedRevisions: { module: snapshot.revisions.module } })
  assert.ok(texts(await main.assemble()).includes('PLAIN=NEW|'), '普通引用读到新键，不需要重挂或删除空占位')
  assert.equal(readModuleVariables(h.dir).module.n, '1', '版本更新不重放本次执行的自增')
  const child = h.make(1)
  assert.ok(texts(await child.assemble()).includes('READ=2|CHILD|'))
  const latest = readModuleVariables(h.dir)
  editModuleVariables(h.dir, { scope: 'module', enabled: false, expectedRevisions: { settings: latest.revisions.settings } })
  await h.make().assemble()
  assert.deepEqual(readModuleVariables(h.dir).module, latest.module, '关闭变量求值后，新 Agent 的模板不写持久值')
  assert.deepEqual(readModuleVariables(h.dir).global, latest.global)
})

test('原生模板重入：装配、重挂和已保存发布失败不重复提交，另一个 Agent 独立执行', async t => {
  const rules = [rule('counter', '{{module.inc::n}}'), rule('pick', 'PICK={{pick::A::B::C::D::E}}')]
  const h = await fixture(t, rules, { n: '0' })
  const realCommit = h.store.commit
  let commits = 0, publishes = 0
  h.store.commit = (...args) => { commits++; return { ...realCommit(...args), publicationPending: true } }
  h.store.publish = () => { publishes++; if (publishes === 1) throw new Error('publication unavailable') }
  const main = h.make()
  const first = texts(await main.assemble())
  assert.ok(first.includes('1'))
  const picked = first.find(text => /^PICK=[A-E]$/.test(text))
  assert.ok(picked)
  main.mount()
  assert.ok(texts(await main.assemble()).includes('1'))
  assert.ok(texts(await main.assemble()).includes('1'))
  assert.equal(commits, 1)
  assert.equal(publishes, 2)
  assert.equal(readModuleVariables(h.dir).module.n, '1')
  assert.ok(texts(await h.make().assemble()).includes('2'))
  assert.equal(commits, 2)
  main.events.push({ type: 'step/start', seq: 1, data: {} }, { type: 'step/end', seq: 2, data: {} })
  rules[1].then[0].config.text = '普通前缀 PICK={{pick::A::B::C::D::E}} 普通后缀'
  main.mount()
  const next = texts(await main.assemble())
  assert.ok(next.includes('3'))
  assert.ok(next.includes(`普通前缀 ${picked} 普通后缀`), '新执行重算同一位置的 pick，普通前后缀不改变选择')
  assert.equal(commits, 3)
  main.events.push({ type: 'compaction/end', seq: 3, data: {} }, { type: 'step/start', seq: 4, data: {} }, { type: 'step/end', seq: 5, data: {} })
  assert.ok(texts(await main.assemble()).includes('4'))
  assert.equal(readModuleVariables(h.dir).module.n, '4', '压缩后的新执行延续持久值，不重置计数')
  const cancelled = h.make()
  cancelled.controller.abort()
  await cancelled.assemble().catch(error => assert.equal(error.name, 'AbortError'))
  assert.equal(commits, 4, '取消的执行不进入变量提交')
  assert.equal(readModuleVariables(h.dir).module.n, '4')
})

test('原生模板拒绝与冲突：双域写和预览零提交，全局回落变化后有界重算只提交新值', async t => {
  const unchanged = { cycle: '{{module.get::cycle}}', block: 'Z'.repeat(512 * 1024 + 1) }
  const h = await fixture(t, [
    rule('dual', '{{module.set::bad::x}}{{global.set::bad::y}}'),
    rule('dangerous-key', '{{module.set::rollback::DIRTY}}{{module.set::__proto__::x}}'),
    rule('reserved-key', '{{global.set::rollback::DIRTY}}{{global.set::TIME::x}}'),
    rule('cycle', '{{module.set::rollback::DIRTY}}{{module.get::cycle}}'),
    rule('depth', '{{module.set::rollback::DIRTY}}' + '{{module.get::'.repeat(33) + 'missing' + '}}'.repeat(33)),
    rule('input-budget', '{{module.set::rollback::DIRTY}}' + 'X'.repeat(1024 * 1024)),
    rule('output-budget', '{{module.set::rollback::DIRTY}}{{block}}{{block}}'),
    rule('counter', '{{module.inc::n}}'),
  ], unchanged)
  let snapshot = readModuleVariables(h.dir)
  editModuleVariables(h.dir, { scope: 'global', changes: { n: '10' }, expectedRevisions: { global: snapshot.revisions.global } })
  const commit = h.store.commit
  let attempts = 0
  h.store.commit = (id, request) => {
    if (++attempts === 1) {
      snapshot = readModuleVariables(h.dir)
      editModuleVariables(h.dir, { scope: 'global', changes: { n: '20' }, expectedRevisions: { global: snapshot.revisions.global } })
    }
    return commit(id, request)
  }
  const main = h.make()
  const beforePreview = readFileSync(join(h.dir, 'module.yml'), 'utf8')
  const preview = await h.root.systemPrompt.assemble({ agent: main.agent, scope: main.agent })
  assert.ok(!texts(preview).includes('11'))
  assert.equal(readFileSync(join(h.dir, 'module.yml'), 'utf8'), beforePreview, '预览不提交前缀暂存赋值')
  assert.deepEqual(readModuleVariables(h.dir).module, unchanged)
  assert.ok(texts(await main.assemble()).includes('21'))
  assert.equal(attempts, 2)
  assert.deepEqual(readModuleVariables(h.dir).module, { ...unchanged, n: '21' })
  assert.equal(Object.hasOwn(readModuleVariables(h.dir).global, 'bad'), false)
  assert.equal(Object.hasOwn(readModuleVariables(h.dir).global, 'rollback'), false)
  for (const reason of ['one variable scope', 'key blocked: __proto__', 'key blocked: TIME', 'variable cycle', 'depth exceeds 32', 'text exceeds 1 MiB', 'output exceeds 1 MiB']) {
    assert.ok(h.warnings.some(message => message.includes(reason)), reason)
  }
})
