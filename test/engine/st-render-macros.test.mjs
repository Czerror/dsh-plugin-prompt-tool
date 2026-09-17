// 合并自 st-macros.test.mjs（15 条）与 st-render.test.mjs（7 条）：
// 同族的宏求值、变量分表与读取优先级用例改为参数化表（每行仍是一条独立用例，名称保留原场景关键词），
// 边界与安全用例保持独立 test()；断言逐条保留，未做语义改写。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareStText, renderStText } from '../../engine/st-macros.mjs'
import { createPromptConfigs } from '../../engine/schema.mjs'
import { setSessionVar, clearSessionVars } from '../../engine/session-vars.mjs'

// 表 1：纯文本求值（输入 → 期望输出）。
for (const [name, text, expected] of [
  ['addvar 数字 2 + 3 = 5，而不是拼接 23', '{{setvar::n::2}}{{addvar::n::3}}{{getvar::n}}', '5'],
  ['addvar 向 JSON 数组追加一个元素', '{{setvar::items::[]}}{{addvar::items::x}}{{getvar::items}}', '["x"]'],
  ['set → get → set → get 按文本顺序求值', '{{setvar::x::a}}{{getvar::x}}|{{setvar::x::b}}{{getvar::x}}', 'a|b'],
  ['嵌套赋值保留完整边界并解析 user', '{{setvar::x::hello {{user}}}}{{getvar::x}}', 'hello 用户'],
]) test(`st-macros：${name}`, () => { assert.equal(renderStText(text), expected) })

// 表 2：变量表状态与 local/global 分表（断言各自持有的表引用）。
for (const [name, run] of [
  ['local/global 严格分表，set/add 无输出，inc/dec 返回新值', () => {
    const local = {}
    const global = {}
    const text = '{{setvar::x::L}}{{setglobalvar::x::G}}{{addvar::s::a}}{{addvar::s::b}}'
      + '{{incvar::n}}/{{decvar::n}}/{{incglobalvar::n}}/{{decglobalvar::n}}:'
      + '{{getvar::x}}/{{getglobalvar::x}}'
    assert.equal(renderStText(text, { local, global }), '1/0/1/0:L/G')
    assert.deepEqual(local, { x: 'L', s: 'ab', n: 0 })
    assert.deepEqual(global, { x: 'G', n: 0 })
    assert.equal(renderStText('{{addglobalvar::n::3}}{{getglobalvar::n}}', { local, global }), '3')
    assert.equal(local.n, 0)
  }],
  ['数组存 JSON、数字相加、非数值拼接，作用于显式对象', () => {
    const local = {}
    renderStText('{{setvar::n::2}}{{addvar::n::3}}{{setvar::items::[]}}{{addvar::items::x}}'
      + '{{setvar::zero::0}}{{addvar::zero::tail}}{{setvar::s::a}}{{addvar::s::2}}', { local })
    assert.deepEqual(local, { n: 5, items: '["x"]', zero: 'tail', s: 'a2' })
    const global = {}
    assert.equal(renderStText('{{setglobalvar::items::[]}}{{addglobalvar::items::x}}{{getglobalvar::items}}', { global }), '["x"]')
  }],
  ['getvar 缺失为空，fallback 只初始化所属表且不覆盖空串或零', () => {
    const local = { empty: '', zero: 0 }
    const global = {}
    const text = '{{getvar::absent}}|{{getvar::missing::fallback}}|{{getvar::missing}}|'
      + '{{getglobalvar::missing}}|{{getvar::empty::not}}|{{getvar::zero::not}}'
    assert.equal(renderStText(text, { local, global }), '|fallback|fallback|||0')
    assert.deepEqual(local, { empty: '', zero: 0, missing: 'fallback' })
    assert.deepEqual(global, {})
  }],
]) test(`st-macros：${name}`, run)

// 表 3：读取优先级与既有插值器委托。
for (const [name, run] of [
  ['普通变量按 local 自有属性、variables、既有插值器优先级读取，未知保留', () => {
    const local = Object.assign(Object.create({ inherited: '不可读取' }), { same: 'local', empty: '' })
    const variables = Object.freeze({ same: 'template', empty: 'not', inherited: 'configured', template: '模板', user: '小林' })
    const session = Object.freeze({ header: Object.freeze({ cwd: 'D:/isolated' }) })
    const global = Object.freeze({ unknown: '不能泄漏' })
    const text = '{{same}}|{{empty}}|{{inherited}}|{{template}}|{{CWD}}|{{user}}|{{unknown}}'
    assert.equal(renderStText(text, { variables, local, global, session }), 'local||configured|模板|D:/isolated|小林|{{unknown}}')
    assert.equal(Object.hasOwn(local, 'inherited'), false)
    assert.equal(renderStText('{{getvar::inherited}}{{addvar::inherited::1}}{{getvar::inherited}}', { local }), '1')
    assert.equal(Object.getPrototypeOf(local).inherited, '不可读取')
    assert.equal(renderStText('{{getvar::same}}'), '', '缺省表不跨调用缓存')
  }],
  ['动态宏与会话事实委托既有插值器，session 只读', () => {
    const events = [{ type: 'user/message', data: { message: { content: [{ type: 'text', text: '最近消息' }] } } }]
    const session = Object.freeze({ snapshotEvents: () => events })
    const before = structuredClone(events)
    assert.equal(renderStText('{{roll 1d1}}|{{random:a}}|{{pick b}}|{{chance:100}}|{{lastusermessage}}', { session }), '1|a|b|true|最近消息')
    assert.deepEqual(events, before)
  }],
]) test(`st-macros：${name}`, run)

// 表 4：ST 渲染时序与会话状态（原 st-render.test.mjs）。
const config = (id, text, extra = {}) => ({ id, text, layer: 'system-section', strategy: 'static', params: { stMacros: true }, ...extra })
const agent = () => ({ session: { id: 'st', header: {}, snapshotEvents: () => [] }, options: {} })

for (const [name, run] of [
  ['ST 按声明顺序求值，禁用赋值不执行，纯赋值卡可重新启用', () => {
    const input = [config('set', '{{setvar::x::2}}', { order: 0 }), config('off', '{{addvar::x::3}}', { order: 1, enabled: false }), config('out', '{{getvar::x}}', { order: 2 })]
    const first = createPromptConfigs(input)
    assert.equal(first[2].renderSt(agent()), '2')
    const enabled = createPromptConfigs(input.map(c => ({ ...c, enabled: true })))
    assert.equal(enabled[2].renderSt(agent()), '5')
  }],
  ['同一输入的两层共享一次宏副作用，后续真实输入才推进状态', () => {
    const configs = createPromptConfigs([config('counter', '{{incvar::n}}'), config('out', '{{getvar::n}}', { order: 1 })])
    const a = agent()
    const message = { id: 'user-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }
    assert.equal(configs[1].renderSt(a, [message]), '1')
    a.session.snapshotEvents = () => [{ type: 'user/message', data: { message } }]
    assert.equal(configs[0].renderSt(a), '1', '入库不再重复执行')
    assert.equal(configs[1].renderSt(a, [{ ...message, id: 'user-2' }]), '2')
    assert.equal(configs[1].renderSt(agent()), '1', '会话隔离')
  }],
  ['ST 会话变量覆盖默认，未命中世界书不执行赋值', () => {
    const configs = createPromptConfigs([config('out', '{{getvar::x}}', { variables: { x: 'DEFAULT' } }), config('lore', '{{setvar::x::LORE}}', { strategy: 'world-book', layer: 'pre-step', params: { stMacros: true, keys: ['MATCH'] } })])
    const a = agent()
    setSessionVar(a.session, 'x', 'SESSION')
    assert.equal(configs[0].renderSt(a), 'SESSION')
    clearSessionVars(a.session, 'x')
    assert.equal(configs[0].renderSt(a), 'DEFAULT', '清空会话覆盖回退模板默认')
  }],
  ['ST 一张模板失败不污染后续状态，禁用/不同受众模板没有副作用', () => {
    const configs = createPromptConfigs([
      config('bad', '{{setvar::x::BAD}}{{cycle}}', { variables: { cycle: '{{cycle}}' } }),
      config('child-only', '{{setvar::x::CHILD}}', { audience: 'subagent', order: 1 }),
      config('out', '{{getvar::x}}', { order: 2, variables: { x: 'DEFAULT' } }),
    ])
    const warnings = []
    assert.equal(configs[2].renderSt(agent(), [], w => warnings.push(w)), 'DEFAULT')
    assert.equal(warnings.length, 1)
  }],
  ['宿主先assembly再pre-step后step/start的真实顺序不重复自增', () => {
    const configs = createPromptConfigs([config('counter', '{{incvar::n}}'), config('out', '{{getvar::n}}', { order: 1 })])
    const a = agent()
    const events = [{ type: 'turn/start', seq: 1, data: { turn: 1 } }]
    a.session.snapshotEvents = () => events
    assert.equal(configs[0].renderSt(a), '1', 'assembly')
    const message = { id: 'u1', role: 'user', content: [{ type: 'text', text: 'new' }] }
    assert.equal(configs[1].renderSt(a, [message]), '1', 'pre-step')
    events.push({ type: 'step/start', seq: 2, data: { turn: 1, step: 1 } }, { type: 'user/message', data: { message } })
    assert.equal(configs[1].renderSt(a), '1', 'admission后同一步')
    events.push({ type: 'step/end', seq: 4, data: { turn: 1, step: 1 } })
    assert.equal(configs[1].renderSt(a), '2', '下一步')
    events.push({ type: 'compaction/end', seq: 5, data: { error: 'cancelled' } })
    assert.equal(configs[1].renderSt(a), '2', '失败压缩不推进宏帧')
    events.push({ type: 'compaction/end', seq: 5, data: { success: true } })
    assert.equal(configs[1].renderSt(a), '3', '新epoch正常构造新帧')
  }],
  ['互斥组淘汰的 ST 赋值模板不参与变量帧', () => {
    const configs = createPromptConfigs([
      config('selected', '{{setvar::x::A}}', { group: 'g', exclusive: true }),
      config('excluded', '{{setvar::x::B}}', { group: 'g', exclusive: true, order: 1 }),
      config('out', '{{getvar::x}}', { order: 2 }),
    ])
    assert.equal(configs[2].renderSt(agent()), 'A')
  }],
  ['晋升或一次性去重受限的卡片只在执行器确认后执行副作用', () => {
    const configs = createPromptConfigs([
      config('promoted', '{{setvar::x::P}}', { layer: 'pre-step', promotion: 'main' }),
      config('once', '{{setvar::x::O}}', { layer: 'pre-step', dedupe: 'session', order: 1 }),
      config('out', '{{getvar::x}}', { order: 2 }),
    ])
    assert.equal(configs[2].renderSt(agent()), '')
  }],
]) test(`st-render：${name}`, run)

// 边界与安全用例：保持独立 test()。
test('st-macros：prepare 只清理与归一，不执行变量或动态宏', () => {
  const text = '\n{{// 注释 {{setvar::x::bad}} 尾部}}\n{{trim}}{{ERA:throw new Error("不得执行")}}\n'
    + '{{setvar::x::hello {{user}}}}{{getvar::x}}\n'
    + '{{char}} {{roll 1d1}} {{random:a}} {{pick x}} {{chance:100}}\n\n\nend\n'
  const expected = '{{setvar::x::hello 用户}}{{getvar::x}}\n'
    + '夏瑾 {{roll::1d1}} {{random::a}} {{pick::x}} {{chance::100}}\n\nend'
  assert.equal(prepareStText(text, ' 夏瑾 '), expected)
  assert.equal(prepareStText(expected, '夏瑾'), expected)
  assert.equal(prepareStText('{{char}}|{{user}}'), '{{char}}|用户')
  const operations = '{{setglobalvar::n::2}}{{addglobalvar::n::3}}{{incglobalvar::n}}{{decglobalvar::n}}{{getglobalvar::n::fallback}}'
  assert.equal(prepareStText(operations), operations)
})

test('st-macros：JSON 单花括号、引号内右花括号和嵌套键值不截断', () => {
  const json = '{"nested":{"user":"{{user}}","close":"}","double":"}}"}}'
  const local = {}
  assert.equal(renderStText(`{{setvar::data::${json}}}{{getvar::data}}`, { local }), '{"nested":{"user":"用户","close":"}","double":"}}"}}')
  assert.deepEqual(JSON.parse(local.data), { nested: { user: '用户', close: '}', double: '}}' } })
  assert.equal(renderStText('{{setvar::key::target}}{{setvar::{{getvar::key}}::a::b}}{{getvar::target}}'), 'a::b')
  const unclosed = '{{setvar::x::{{setvar::y::bad}}'
  assert.equal(renderStText(unclosed, { local }), unclosed)
  assert.equal(Object.hasOwn(local, 'y'), false)
})

test('st-macros：注释与 ERA 内嵌赋值永不执行，且不残留尾部', () => {
  const local = {}
  const global = {}
  const text = 'left{{// {{setvar::x::bad}}{{setglobalvar::x::bad}} 注释尾部}}/'
    + '{{ERA:throw new Error("不得执行"); {{setvar::y::bad}}}}{{trim}}right'
  assert.equal(renderStText(text, { local, global }), 'left/right')
  assert.deepEqual(local, {})
  assert.deepEqual(global, {})
})

test('st-macros：禁止危险变量键，读写仅操作自有属性而不污染原型', () => {
  const local = {}
  const global = {}
  const warnings = []
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const text = `{{setvar::${key}::{"polluted":true}}}{{addglobalvar::${key}::bad}}`
      + `{{getvar::${key}::fallback}}{{incglobalvar::${key}}}`
    assert.equal(renderStText(text, { local, global, warn: (message) => warnings.push(message) }), '')
  }
  assert.deepEqual(local, {})
  assert.deepEqual(global, {})
  assert.equal(Object.getPrototypeOf(local), Object.prototype)
  assert.equal(Object.getPrototypeOf(global), Object.prototype)
  assert.equal(({}).polluted, undefined)
  assert.ok(warnings.length > 0)
})

test('st-macros：嵌套最多 32 层，循环变量引用拒绝而不无界递归', () => {
  const nested = (depth) => '{{setvar::x::'.repeat(depth) + 'ok' + '}}'.repeat(depth)
  assert.equal(prepareStText(nested(32)), nested(32))
  assert.doesNotThrow(() => renderStText(nested(32)))
  assert.throws(() => prepareStText(nested(33)), RangeError)
  assert.throws(() => renderStText(nested(33)), RangeError)
  assert.throws(() => renderStText('{{a}}', { variables: { a: '{{b}}', b: '{{a}}' } }), /cycle/i)
  assert.throws(() => renderStText('{{getvar::a}}', { local: { a: '{{getvar::a}}' } }), /cycle/i)
  assert.equal(renderStText('{{getvar::a}}', { local: { a: '{{getglobalvar::a}}' }, global: { a: '独立' } }), '独立')
})

test('st-macros：输入与展开输出限制为 UTF-8 1 MiB', () => {
  const limit = 1024 * 1024
  assert.equal(renderStText('x'.repeat(limit)).length, limit)
  assert.throws(() => prepareStText('x'.repeat(limit + 1)), RangeError)
  assert.throws(() => renderStText('你'.repeat(Math.floor(limit / 3) + 1)), RangeError)
  assert.throws(() => renderStText('{{big}}{{big}}', { variables: { big: 'x'.repeat(limit / 2 + 1) } }), RangeError)
})
