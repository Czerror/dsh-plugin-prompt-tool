/**
 * B6 T5 (4) 验收：`shapeErrors`（host 形状层）与引擎权威校验的**分工固化**。
 *
 * `src/runtime/configs-validate.ts:4-8` 自述这是**有意的两层**：
 *   - 形状层（host 自己的 `shapeErrors`）：数组 / 对象 / 非空 id / 重复 id，**收集全部错误**，
 *     消息形如 `configs[0] …`（不带引擎前缀）；
 *   - 语义层（引擎 `createPromptConfigs`）：枚举、层支持、identity、match 等，**逐条**校验，
 *     消息带 `prompt-config-engine:` 前缀，且被包进同一份 `errors` 返回给 UI。
 *
 * PLAN 只要求「保留两层设计，但断言**引擎会拒的 host 也拒**」——本文件就钉这两件事：
 * ① 两层各自负责哪些输入（用消息前缀区分，前缀变了就红）；② 形状层不脱节（引擎在形状上
 * 会拒的，host 绝不返回 valid）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { validatePromptConfigs } from '../../src/runtime/configs-validate.ts'

const ENGINE_PREFIX = /prompt-config-engine:/

test('形状层：host 自己的 shapeErrors 先拦，消息不带引擎前缀', async () => {
  const cases = [
    ['非数组', 'not-an-array', /promptConfigs must be an array/],
    ['元素为 null', [null], /configs\[0\] must be an object/],
    ['元素为数组', [[]], /configs\[0\] must be an object/],
    ['元素为标量', [42], /configs\[0\] must be an object/],
    ['缺 id', [{ text: 'x' }], /configs\[0\]\.id must be a non-empty string/],
    ['空 id', [{ id: '' }], /configs\[0\]\.id must be a non-empty string/],
    ['id 非字符串', [{ id: 1 }], /configs\[0\]\.id must be a non-empty string/],
    // 重复 id 报的是**后者**的位置（`configs[1]`）——先出现的那个是有效定义，被覆盖的才是问题。
    ['重复 id', [{ id: 'a' }, { id: 'a' }], /configs\[1\] duplicate id "a"/],
  ]
  for (const [label, value, pattern] of cases) {
    const result = await validatePromptConfigs(value)
    assert.equal(result.valid, false, `${label}: 必须判不合格`)
    assert.ok(result.errors.length > 0, `${label}: 必须给出错误`)
    assert.match(result.errors[0].message, pattern, `${label}: 形状层消息形态`)
    assert.doesNotMatch(result.errors[0].message, ENGINE_PREFIX,
      `${label}: 形状错误来自 host 自己，不该先经引擎`)
  }
})

test('语义层：形状合法时错误来自引擎（带引擎前缀）——两层确实都接上了', async () => {
  const cases = [
    ['非法 position', { id: 'a', position: 'nope' }, /unknown position/],
    ['非法 layer', { id: 'a', layer: 'nope' }, /unknown layer/],
    ['层内不支持的字段', { id: 'a', layer: 'system-section', position: 'before-all' }, /does not support field/],
    ['非法 identity', { id: 'a', identity: { field: 'kind', value: 'v' } }, /\.identity must be/],
  ]
  for (const [label, spec, pattern] of cases) {
    const result = await validatePromptConfigs([spec])
    assert.equal(result.valid, false, `${label}: 引擎应拒绝`)
    assert.match(result.errors[0].message, ENGINE_PREFIX, `${label}: 语义错误应来自引擎`)
    assert.match(result.errors[0].message, pattern, `${label}: 引擎消息内容`)
  }
})

test('两层不脱节：引擎在**形状**上会拒的输入，host 绝不返回 valid', async () => {
  // 这四种形状错误引擎也会拒（`createPromptConfigs` 的 config.configs / must be an object /
  // .id must be a non-empty string / duplicate prompt config id）。host 若不拦，就会把
  // 一条引擎必然拒绝的配置渲染成预览文件——那才是真正脱节。
  const shapeRejected = ['not-an-array', [null], [{}], [{ id: 'x' }, { id: 'x' }]]
  for (const value of shapeRejected) {
    const result = await validatePromptConfigs(value)
    assert.equal(result.valid, false, `${JSON.stringify(value)}: host 不得放行`)
    assert.equal(result.files, undefined, '不合格时不得产出预览文件')
  }
})

test('合法输入走通：产出预览文件，且不产生任何错误', async () => {
  const result = await validatePromptConfigs([{ id: 'ok', text: '正文' }])
  assert.equal(result.valid, true, JSON.stringify(result.errors))
  assert.deepEqual(result.errors, [])
  assert.equal(result.files.length, 1)
  assert.match(result.files[0].file, /ok/, '预览文件名应含配置 id')
  assert.match(result.files[0].content, /id: ok/, '预览内容应是该配置的 YAML')
})

test('语义层逐条校验：一条坏配置不吞掉其余（这是它相对形状层的额外价值）', async () => {
  const result = await validatePromptConfigs([
    { id: 'a', position: 'nope' },
    { id: 'b' },
    { id: 'c', position: 'also-nope' },
  ])
  assert.equal(result.valid, false)
  const indexes = result.errors.map((error) => error.index)
  assert.deepEqual(indexes, [0, 2], 'a 与 c 各自报错，b 不受影响（逐条校验而非整组一次）')
})
