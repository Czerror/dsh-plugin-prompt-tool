import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareStText, renderStText } from '../../engine/st-macros.mjs'

test('addvar 数字 2 + 3 = 5，而不是拼接 23', () => {
  assert.equal(renderStText('{{setvar::n::2}}{{addvar::n::3}}{{getvar::n}}'), '5')
})

test('addvar 向 JSON 数组追加一个元素', () => {
  assert.equal(renderStText('{{setvar::items::[]}}{{addvar::items::x}}{{getvar::items}}'), '["x"]')
})

test('set → get → set → get 按文本顺序求值', () => {
  assert.equal(renderStText('{{setvar::x::a}}{{getvar::x}}|{{setvar::x::b}}{{getvar::x}}'), 'a|b')
})

test('嵌套赋值保留完整边界并解析 user', () => {
  assert.equal(renderStText('{{setvar::x::hello {{user}}}}{{getvar::x}}'), 'hello 用户')
})

test('prepare 只清理与归一，不执行变量或动态宏', () => {
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

test('local/global 严格分表，set/add 无输出，inc/dec 返回新值', () => {
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
})

test('数组存 JSON、数字相加、非数值拼接，作用于显式对象', () => {
  const local = {}
  renderStText('{{setvar::n::2}}{{addvar::n::3}}{{setvar::items::[]}}{{addvar::items::x}}'
    + '{{setvar::zero::0}}{{addvar::zero::tail}}{{setvar::s::a}}{{addvar::s::2}}', { local })
  assert.deepEqual(local, { n: 5, items: '["x"]', zero: 'tail', s: 'a2' })
  const global = {}
  assert.equal(renderStText('{{setglobalvar::items::[]}}{{addglobalvar::items::x}}{{getglobalvar::items}}', { global }), '["x"]')
})

test('getvar 缺失为空，fallback 只初始化所属表且不覆盖空串或零', () => {
  const local = { empty: '', zero: 0 }
  const global = {}
  const text = '{{getvar::absent}}|{{getvar::missing::fallback}}|{{getvar::missing}}|'
    + '{{getglobalvar::missing}}|{{getvar::empty::not}}|{{getvar::zero::not}}'
  assert.equal(renderStText(text, { local, global }), '|fallback|fallback|||0')
  assert.deepEqual(local, { empty: '', zero: 0, missing: 'fallback' })
  assert.deepEqual(global, {})
})

test('普通变量按 local 自有属性、variables、既有插值器优先级读取，未知保留', () => {
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
})

test('动态宏与会话事实委托既有插值器，session 只读', () => {
  const events = [{ type: 'user/message', data: { message: { content: [{ type: 'text', text: '最近消息' }] } } }]
  const session = Object.freeze({ snapshotEvents: () => events })
  const before = structuredClone(events)
  assert.equal(renderStText('{{roll 1d1}}|{{random:a}}|{{pick b}}|{{chance:100}}|{{lastusermessage}}', { session }), '1|a|b|true|最近消息')
  assert.deepEqual(events, before)
})

test('JSON 单花括号、引号内右花括号和嵌套键值不截断', () => {
  const json = '{"nested":{"user":"{{user}}","close":"}","double":"}}"}}'
  const local = {}
  assert.equal(renderStText(`{{setvar::data::${json}}}{{getvar::data}}`, { local }), '{"nested":{"user":"用户","close":"}","double":"}}"}}')
  assert.deepEqual(JSON.parse(local.data), { nested: { user: '用户', close: '}', double: '}}' } })
  assert.equal(renderStText('{{setvar::key::target}}{{setvar::{{getvar::key}}::a::b}}{{getvar::target}}'), 'a::b')
  const unclosed = '{{setvar::x::{{setvar::y::bad}}'
  assert.equal(renderStText(unclosed, { local }), unclosed)
  assert.equal(Object.hasOwn(local, 'y'), false)
})

test('注释与 ERA 内嵌赋值永不执行，且不残留尾部', () => {
  const local = {}
  const global = {}
  const text = 'left{{// {{setvar::x::bad}}{{setglobalvar::x::bad}} 注释尾部}}/'
    + '{{ERA:throw new Error("不得执行"); {{setvar::y::bad}}}}{{trim}}right'
  assert.equal(renderStText(text, { local, global }), 'left/right')
  assert.deepEqual(local, {})
  assert.deepEqual(global, {})
})

test('禁止危险变量键，读写仅操作自有属性而不污染原型', () => {
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

test('嵌套最多 32 层，循环变量引用拒绝而不无界递归', () => {
  const nested = (depth) => '{{setvar::x::'.repeat(depth) + 'ok' + '}}'.repeat(depth)
  assert.equal(prepareStText(nested(32)), nested(32))
  assert.doesNotThrow(() => renderStText(nested(32)))
  assert.throws(() => prepareStText(nested(33)), RangeError)
  assert.throws(() => renderStText(nested(33)), RangeError)
  assert.throws(() => renderStText('{{a}}', { variables: { a: '{{b}}', b: '{{a}}' } }), /cycle/i)
  assert.throws(() => renderStText('{{getvar::a}}', { local: { a: '{{getvar::a}}' } }), /cycle/i)
  assert.equal(renderStText('{{getvar::a}}', { local: { a: '{{getglobalvar::a}}' }, global: { a: '独立' } }), '独立')
})

test('输入与展开输出限制为 UTF-8 1 MiB', () => {
  const limit = 1024 * 1024
  assert.equal(renderStText('x'.repeat(limit)).length, limit)
  assert.throws(() => prepareStText('x'.repeat(limit + 1)), RangeError)
  assert.throws(() => renderStText('你'.repeat(Math.floor(limit / 3) + 1)), RangeError)
  assert.throws(() => renderStText('{{big}}{{big}}', { variables: { big: 'x'.repeat(limit / 2 + 1) } }), RangeError)
})
