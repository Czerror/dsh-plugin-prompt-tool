/**
 * fields.mjs（B2 T1）单元断言。
 *
 * B2 的硬约束是「迁移前后逐字段校验结果与错误消息一致」，所以这里不满足于断言
 * fields 自己的行为，而是把每个字段类型与**它要取代的 shared.mjs helper** 放在
 * 同一组输入下对拍：抛/不抛一致、归一化值一致、错误消息逐字一致。
 * 另外用两个真实模块（run-code-env 的 envKeys、context-gate 的 Set 形态）证明
 * 这套 DSL 确实能表达现有 helper 的语义。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bool, int, text, stringList, enumOf, defineConfig } from '../../engine/fields.mjs'
import { booleanOption, requiredInt, requiredText, validateConfig } from '../../engine/shared.mjs'

const PLUGIN = 'demo'

/** 捕获同步抛错：返回 { ok, value } 或 { ok:false, error }，不吞掉「没抛」这个事实。 */
function caught(fn) {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    return { ok: false, error }
  }
}

/** 同一输入下，「既有 helper」与「字段声明」的抛错行为、归一化值或消息必须完全一致。 */
function expectSameAsHelper(helperCall, spec, value, label) {
  const viaHelper = caught(() => helperCall(value))
  const viaField = caught(() => spec.parse(value, PLUGIN, 'probe'))
  assert.equal(viaField.ok, viaHelper.ok, `${label}: 抛/不抛行为一致`)
  if (viaHelper.ok) assert.deepEqual(viaField.value, viaHelper.value, `${label}: 归一化值一致`)
  else assert.equal(viaField.error.message, viaHelper.error.message, `${label}: 错误消息逐字一致`)
}

test('bool 与 booleanOption 在六种输入下逐字对拍', () => {
  for (const value of [undefined, true, false, 'yes', 1, null]) {
    expectSameAsHelper(
      (input) => booleanOption(PLUGIN, input, 'probe', false),
      bool({ default: false }),
      value,
      `bool(${String(value)})`,
    )
  }
})

test('int(required) 与 requiredInt 在六种输入下逐字对拍', () => {
  for (const value of [undefined, 0, 3, -1, 1.5, '2', null]) {
    expectSameAsHelper(
      (input) => requiredInt(PLUGIN, input, 'probe', 0),
      int({ min: 0, required: true }),
      value,
      `int(${String(value)})`,
    )
  }
})

test('text(required) 与 requiredText 在五种输入下逐字对拍（含空串 → undefined 契约）', () => {
  for (const value of [undefined, 'x', '', 1, null]) {
    expectSameAsHelper(
      (input) => requiredText(PLUGIN, input, 'probe'),
      text({ required: true }),
      value,
      `text(${String(value)})`,
    )
  }
  assert.equal(text({ required: true }).parse('', PLUGIN, 'txt'), undefined, '空串 = 显式留空')
})

test('字段类型的五输入表：undefined / 正确值 / 错类型 / 空数组 / 空串', () => {
  assert.equal(bool({ default: false }).parse(undefined, PLUGIN, 'f'), false, 'bool: undefined → default')
  assert.equal(bool().parse(true, PLUGIN, 'f'), true, 'bool: 正确值')
  assert.throws(() => bool().parse('yes', PLUGIN, 'f'), /must be a boolean/, 'bool: 错类型')

  assert.equal(int({ min: 1 }).parse(undefined, PLUGIN, 'f'), undefined, 'int: undefined → default(undefined)')
  assert.equal(int({ min: 1 }).parse(3, PLUGIN, 'f'), 3, 'int: 正确值')
  assert.throws(() => int({ min: 1 }).parse('3', PLUGIN, 'f'), /must be an integer >= 1/, 'int: 错类型')
  assert.throws(() => int({ min: 1, message: '{field} 必须是整数' }).parse('3', PLUGIN, 'f'), /f 必须是整数/, 'int: message 可覆盖措辞')

  assert.equal(text({ default: 'd' }).parse(undefined, PLUGIN, 'f'), 'd', 'text: undefined → default')
  assert.equal(text().parse('v', PLUGIN, 'f'), 'v', 'text: 正确值')
  assert.throws(() => text().parse(1, PLUGIN, 'f'), /must be a string/, 'text: 错类型')
  assert.throws(() => text({ allowEmpty: false }).parse('', PLUGIN, 'f'), /must be a non-empty string/, 'text: 空串（allowEmpty:false）')

  assert.deepEqual(stringList({ default: () => [] }).parse(undefined, PLUGIN, 'f'), [], 'stringList: undefined → default')
  assert.deepEqual(stringList().parse(['a', 'b'], PLUGIN, 'f'), ['a', 'b'], 'stringList: 正确值')
  assert.throws(() => stringList().parse('a', PLUGIN, 'f'), /must be an array of non-empty strings/, 'stringList: 错类型')
  assert.throws(() => stringList().parse([], PLUGIN, 'f'), /must be an array of non-empty strings/, 'stringList: 空数组')
  assert.throws(() => stringList().parse([''], PLUGIN, 'f'), /must be an array of non-empty strings/, 'stringList: 含空串')

  assert.equal(enumOf(['a', 'b'], { default: 'a' }).parse(undefined, PLUGIN, 'f'), 'a', 'enum: undefined → default')
  assert.equal(enumOf(['a', 'b']).parse('b', PLUGIN, 'f'), 'b', 'enum: 正确值')
  assert.throws(() => enumOf(['a', 'b']).parse('c', PLUGIN, 'f'), /must be one of "a", "b"/, 'enum: 错值')
  assert.throws(() => enumOf(['a', 'b'], { required: true }).parse(undefined, PLUGIN, 'f'), /must be one of/, 'enum: 必填缺键')
})

test('default 工厂：可变默认值在多次 parse 之间绝不共享', () => {
  const spec = stringList({ as: 'set', default: () => new Set() })
  const first = spec.parse(undefined, PLUGIN, 'f')
  const second = spec.parse(undefined, PLUGIN, 'f')
  assert.notEqual(first, second, '两次 parse 得到不同实例')
  first.add('mutated')
  assert.equal(second.size, 0, 'mutate 一个实例不影响另一个')
  // 值形态的 default 仍然可用（不可变值无须工厂）。
  assert.equal(bool({ default: true }).parse(undefined, PLUGIN, 'f'), true)
})

test('defineConfig 派生白名单、拒绝未知键，信封消息与 validateConfig 逐字一致', () => {
  const { allowedKeys, parse } = defineConfig({
    enabled: bool({ default: false }),
    text: text({ default: '' }),
  })
  assert.deepEqual([...allowedKeys].sort(), ['enabled', 'text'], '白名单由声明派生')
  assert.deepEqual(parse({}, PLUGIN), { enabled: false, text: '' }, '缺键走各自 default')

  const viaDefine = caught(() => parse({ nope: 1 }, PLUGIN))
  const viaHelper = caught(() => validateConfig(PLUGIN, { nope: 1 }, allowedKeys))
  assert.equal(viaDefine.ok, false, '未知键必须抛')
  assert.equal(viaDefine.error.message, viaHelper.error.message, '未知键消息与 shared.validateConfig 逐字一致')
  assert.match(viaDefine.error.message, /allowed keys: enabled, text/, '消息含允许键清单（已排序）')

  assert.throws(() => parse([], PLUGIN), /config must be an object/, '信封类型错误')
})

test('表达力①：stringList 能表达 run-code-env 的 envKeys（两条消息 + trim/去重）', () => {
  const envKeys = stringList({
    required: true,
    trim: true,
    dedupe: true,
    message: '{plugin}: envKeys must be a non-empty array of env var names — 白名单归模板/预设，请在本预设或组合源提供',
    emptyMessage: '{plugin}: envKeys must contain at least one non-empty env var name',
  })
  assert.deepEqual(envKeys.parse([' A ', 'B', 'A'], PLUGIN, 'envKeys'), ['A', 'B'], 'trim + 去重')
  assert.throws(
    () => envKeys.parse([], PLUGIN, 'envKeys'),
    /must be a non-empty array of env var names — 白名单归模板\/预设/,
    '空数组 → 消息 A',
  )
  assert.throws(
    () => envKeys.parse(['   '], PLUGIN, 'envKeys'),
    /must contain at least one non-empty env var name/,
    'trim 后为空 → 消息 B（与消息 A 不同，必须能分别表达）',
  )
  assert.throws(() => envKeys.parse(undefined, PLUGIN, 'envKeys'), /must be a non-empty array/, '缺键 → 消息 A')
})

test('表达力②：stringList(as: set) 能表达 nameSet / allowKindList / deferredList 的返回形态', () => {
  const nameSet = stringList({ as: 'set' })
  const parsedSet = nameSet.parse(['read', 'glob'], PLUGIN, 'allow')
  assert.ok(parsedSet instanceof Set, '返回 Set 而非数组')
  assert.deepEqual([...parsedSet], ['read', 'glob'])
  assert.equal(nameSet.parse(undefined, PLUGIN, 'allow'), undefined, 'undefined → undefined（不启用过滤）')
  const deferred = stringList({ as: 'set', default: () => new Set() })
  assert.equal(deferred.parse(undefined, PLUGIN, 'sources').size, 0, 'undefined → 空 Set（延迟列表的缺省形态）')
})

test('表达力③：enumOf 能表达 promoteOn 一族的枚举白名单', () => {
  const promoteOn = enumOf(['tool-call', 'assistant-message', 'either'], { default: 'either' })
  assert.equal(promoteOn.parse('tool-call', PLUGIN, 'promoteOn'), 'tool-call')
  assert.equal(promoteOn.parse(undefined, PLUGIN, 'promoteOn'), 'either', '缺省 either')
  assert.throws(() => promoteOn.parse('bogus', PLUGIN, 'promoteOn'), /must be one of "tool-call", "assistant-message", "either"/)
})
