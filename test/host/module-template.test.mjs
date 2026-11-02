import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openSessionVariables } from '../../src/host/session-variables.ts'
import { compileRules } from '../../engine/rule-spec.mjs'
import { mountRuleSources } from '../../engine/rule-runtime.mjs'
import { renderTemplate, renderTemplateAsync } from '../../engine/template-frame.mjs'
import { evaluateTemplate } from '../../engine/template-evaluation.mjs'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-native-template-')
const { readModuleVariables, editModuleVariables } = await import('../../src/host/module-variables.ts')
const { createModuleVariableAdapter } = await import('../../src/runtime/module-variable-adapter.ts')
const { prepareStText } = await import('../../src/host/st-template.ts')
const rule = (id, text, extra = {}, config = {}) => ({ id, ...extra, then: [{ id: 'text', kind: 'inject-text', config: { layer: 'system-section', text, params: { templateEvaluation: true }, ...config } }] })
let sequence = 0
async function fixture(t, rules, values = {}, options = {}) {
  const id = `template-${++sequence}`, dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), JSON.stringify({ id, modules: [], variables: values }))
  const root = new Context()
  await root.plugin(SystemPrompt)
  const store = createModuleVariableAdapter(moduleRoot, options)
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

test('会话变量注入按真实Agent覆盖并等待单次异步提交，运行事实不可被持久值伪造', async t => {
  const h = await fixture(t, [
    rule('counter', '{{session.inc::n}}'),
    rule('reader', 'READ={{n}}|{{module.get::n}}|{{global.get::n}}|{{runtime.get::clock}}'),
    rule('ordinary', 'PLAIN={{n}}', {}, { params: {} }),
    rule('ordinary-step', 'STEP={{n}}', {}, { layer: 'pre-step', position: 'after-all', params: {} }),
  ], { n: 'MODULE' })
  const states = new Map(), commits = []
  h.store.read = (_id, { agent } = {}) => {
    const session = states.get(agent?.session.id) ?? { n: '0' }
    return { module: { n: 'MODULE', clock: 'FAKE' }, global: { n: 'GLOBAL' }, session, effective: { n: session.n }, revisions: { module: 'm', global: 'g', session: String(session.n) } }
  }
  h.store.readRuntime = (_id, key) => key === 'clock' ? 'CURRENT' : undefined
  h.store.commit = async (_id, request, { agent }) => {
    commits.push(request)
    await Promise.resolve()
    states.set(agent.session.id, request.changes)
    return {}
  }
  const main = h.make()
  const results = await Promise.all([main.assemble(), main.assemble()])
  for (const result of results) assert.ok(texts(result).includes('READ=1|MODULE|GLOBAL|CURRENT'), texts(result).join('\n'))
  assert.equal(commits.length, 1, '并发装配共享进行中提交凭据')
  assert.equal(commits[0].scope, 'session')
  states.set(main.agent.session.id, { n: '8' })
  assert.ok(texts(await main.assemble()).includes('READ=8|MODULE|GLOBAL|CURRENT'), '无赋值的模板不冻结事实')
  assert.ok(texts(await main.assemble()).includes('PLAIN=8'))
  states.set(main.agent.session.id, { n: '{{date}}' })
  assert.ok(!texts(await main.assemble()).some(text => /^PLAIN=\d{4}-/.test(text)), '普通正文不得执行会话值中的时间宏')
  const step = await h.root.waterfall(scopeTarget(main.agent, main.agent), 'agent/pre-step', { agent: main.agent, signal: main.signal }, async () => ({ kind: 'enter', messages: [] }))
  assert.ok(step.messages.some(message => message.content.some(block => block.text === 'STEP={{date}}')), 'pre-step保留会话值字面')
  assert.ok(texts(await h.make(1).assemble()).includes('READ=1|MODULE|GLOBAL|CURRENT'))
})

test('运行事实只作字面数据且不可赋值，缺失事实与会话条件保持不可用', async t => {
  const h = await fixture(t, [
    rule('literal', 'FACT={{runtime.get::literal}}'),
    rule('bad', '{{module.set::leak::DIRTY}}{{runtime.get::missing}}'),
    rule('write-runtime', '{{runtime.set::clock::FAKE}}'),
    rule('session-condition', 'SESSION', { if: { variable: { scope: 'session', key: 'status', value: 'READY' } } }),
    rule('unavailable-not', 'LEAK', { if: { not: { variable: { scope: 'runtime', key: 'missing', op: 'present' } } } }),
  ])
  h.store.read = () => ({ module: {}, global: {}, session: { status: 'READY' }, effective: { status: 'READY' }, revisions: { module: 'm', global: null, session: null } })
  h.store.readRuntime = (_id, key) => key === 'literal' ? '{{module.set::leak::DIRTY}}' : undefined
  let commits = 0
  h.store.commit = () => { commits++; return {} }
  const result = texts(await h.make().assemble())
  assert.ok(result.includes('SESSION'))
  assert.ok(!result.includes('LEAK'))
  assert.equal(commits, 0)
  assert.equal(evaluateTemplate('{{runtime.get::literal}}', { readRuntime: () => '{{module.set::leak::DIRTY}}' }).text, '{{module.set::leak::DIRTY}}')
  const literal = '{{module.set::leak::DIRTY}}'
  assert.deepEqual(evaluateTemplate('{{status}}|{{session.get::status}}', { sessionVariables: { status: literal } }), { text: `${literal}|${literal}`, reads: ['session'] })
  assert.throws(() => evaluateTemplate('{{runtime.get::clock::fallback}}'), /read-only/)
  assert.throws(() => evaluateTemplate('{{module.set::leak::DIRTY}}{{runtime.delete::clock}}'), /Unknown template operation/)
})

test('同步人设出口拒绝session赋值且零提交，异步已提交取消不重放，冲突重试保留单域CAS', async () => {
  const events = [{ type: 'turn/start', seq: 0, data: {} }]
  const agent = { status: 'running', session: { id: 'template-cancel', snapshotEvents: () => events } }
  const control = new AbortController(), context = { agent, signal: control.signal }
  let values = { n: '0' }, attempts = 0
  let finish
  const store = {
    read: () => ({ module: { old: 'M' }, global: {}, session: values, revisions: { module: 'm', global: null, session: values.n } }),
    commit: async (_id, request) => {
      attempts++
      if (attempts === 1) { values = { n: '9' }; throw Object.assign(new Error('conflict'), { status: 409 }) }
      assert.equal(request.expectedRevisions.session, '9')
      await new Promise(resolve => { finish = resolve })
      values = request.changes
      return {}
    },
    publish() {},
  }
  const config = { sourceModuleId: 'module', id: 'session', texts: ['{{session.inc::n}}'], variableStore: store }
  assert.throws(() => renderTemplate(config, context), /asynchronous rule or tool/)
  assert.equal(attempts, 0)
  const pending = renderTemplateAsync(config, context)
  await Promise.resolve()
  control.abort()
  finish()
  await assert.rejects(pending, /abort/i)
  const next = { agent, signal: new AbortController().signal }
  assert.equal(await renderTemplateAsync(config, next), '10')
  assert.equal(attempts, 2, '已提交后取消不能删除成功凭据')
  assert.equal(values.n, '10')
  assert.equal(renderTemplate({ ...config, id: 'reader', texts: ['{{session.get::old}}|{{module.get::old}}'] }, next), 'M|M')
})

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
    rule('st-edit-fragment', prepareStText('{{s}')),
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
  assert.ok(first.includes('{{s}'), '启用的 ST 编辑残片经过原生模板与官方装配后仍保留原文')
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
  assert.ok(!texts(await main.assemble()).some(text => text.startsWith('NUM=6,5,5')), '同执行缓存不能绕过动态变量总闸')
  await h.make().assemble()
  assert.deepEqual(readModuleVariables(h.dir).module, latest.module, '关闭变量求值后，新 Agent 的模板不写持久值')
  assert.deepEqual(readModuleVariables(h.dir).global, latest.global)
})

test('异步提交期间关闭变量时首调用与并发均抑制正文，重新开启不重放', async t => {
  const h = await fixture(t, [rule('counter', 'SENSITIVE={{session.inc::n}}')])
  let enabled = true, commits = 0, finish
  const wait = new Promise(resolve => { finish = resolve })
  h.store.read = () => ({ module: {}, global: {}, session: { n: '0' }, enabled, revisions: { module: 'm', global: null, session: null } })
  h.store.commit = async () => { commits++; await wait; return { persisted: true } }
  const main = h.make(), pending = Promise.all([main.assemble(), main.assemble()])
  while (commits === 0) await Promise.resolve()
  enabled = false
  finish()
  for (const assembly of await pending) assert.ok(!texts(assembly).includes('SENSITIVE=1'), '每次调用返回已获准正文而非提交缓存正文')
  enabled = true
  assert.ok(texts(await main.assemble()).includes('SENSITIVE=1'))
  assert.equal(commits, 1)
})

test('官方会话持久提交期间撤下owner阻止正文，恢复owner不重放已提交模板', async t => {
  const root = new Context(), storage = new Storage(root), backend = new JsonStorageBackend(join(moduleRoot, 'publication-storage'))
  storage.backend.register('json', backend)
  const facility = new DomainFacility(root, { backend: 'json' })
  const open = backend.kv.open
  let started, finish, puts = 0
  const entered = new Promise(resolve => { started = resolve }), wait = new Promise(resolve => { finish = resolve })
  backend.kv.open = async descriptor => {
    const unit = await open(descriptor), put = unit.putRecord.bind(unit)
    unit.putRecord = async (...args) => { puts++; started(); await wait; return put(...args) }
    return unit
  }
  const owner = await openSessionVariables(facility)
  let current = owner
  t.after(async () => { await owner.dispose(); await facility.closeAll(); await backend.close(); await root.fiber.dispose() })
  const h = await fixture(t, [rule('counter', 'SAVED={{session.inc::n}}')], {}, { sessionVariables: () => current })
  const main = h.make(), pending = Promise.all([main.assemble(), main.assemble()])
  await entered
  current = undefined
  finish()
  for (const assembly of await pending) assert.ok(!texts(assembly).includes('SAVED=1'), '持久成功后撤权不能发布迟到正文')
  assert.equal(owner.read(h.dir, main.agent.session.id).variables.n, '1')
  assert.equal(puts, 1)
  current = owner
  assert.ok(texts(await main.assemble()).includes('SAVED=1'))
  assert.equal(puts, 1, '恢复原owner后复用提交凭据')
  current = { ...owner }
  assert.ok(!texts(await main.assemble()).includes('SAVED=1'), '替换owner后不能借旧缓存发布正文')
  assert.equal(puts, 1)
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
  const unchanged = { cycle: '{{module.get::cycle}}', block: 'Z'.repeat(512 * 1024 + 1), fragment: '{{s}' }
  const h = await fixture(t, [
    rule('dual', '{{module.set::bad::x}}{{global.set::bad::y}}'),
    rule('dangerous-key', '{{module.set::rollback::DIRTY}}{{module.set::__proto__::x}}'),
    rule('reserved-key', '{{global.set::rollback::DIRTY}}{{global.set::TIME::x}}'),
    rule('cycle', '{{module.set::rollback::DIRTY}}{{module.get::cycle}}'),
    rule('depth', '{{module.set::rollback::DIRTY}}' + '{{module.get::'.repeat(33) + 'missing' + '}}'.repeat(33)),
    rule('input-budget', '{{module.set::rollback::DIRTY}}' + 'X'.repeat(1024 * 1024)),
    rule('output-budget', '{{module.set::rollback::DIRTY}}{{block}}{{block}}'),
    rule('unclosed-native-operation', '{{module.set::rollback::DIRTY}}{{module.set::broken::value}'),
    rule('unclosed-nested-operation', '{{module.set::rollback::DIRTY}}{{module.set::broken::{{s}'),
    rule('unclosed-expanded-variable', '{{module.set::rollback::DIRTY}}{{fragment}}'),
    rule('unclosed-reserved-fragment', '{{module.set::rollback::DIRTY}}{{TIME}'),
    rule('unclosed-dangerous-fragment', '{{global.set::rollback::DIRTY}}{{__proto__}'),
    rule('unclosed-parameter-fragment', '{{module.set::rollback::DIRTY}}{{s::value}'),
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
  for (const reason of ['one variable scope', 'key blocked: __proto__', 'key blocked: TIME', 'variable cycle', 'depth exceeds 32', 'text exceeds 1 MiB', 'output exceeds 1 MiB', 'Unclosed template expression']) {
    assert.ok(h.warnings.some(message => message.includes(reason)), reason)
  }
})
