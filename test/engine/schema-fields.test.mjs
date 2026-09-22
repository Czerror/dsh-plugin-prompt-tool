/**
 * B5 验收回归：层定义表合一（T1）与字段校验声明化（T2）。
 *
 * 这两条改动的本质都是「把散落的重复收敛成一份声明」，所以最容易被将来的改动悄悄打破的
 * 不是某个具体值，而是**声明与派生之间的一致性**——本文件就守这个。
 *
 * 值层面的等价性在改动当时用 HEAD 版对拍过（`getEngineMeta()` 逐字段逐顺序、错误消息逐字
 * 相同，66 组输入）；这里留下的是**改动后仍然成立的不变量**，防止后续新增层 / 新增字段时
 * 只改了声明的一部分。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONFIG_FIELDS,
  CONDITIONAL_LAYERS,
  LAYER_CONTRACTS,
  LAYER_DEFAULT_SUBJECT,
  LAYER_FIELD_POLICIES,
  LAYER_LABELS,
  LAYER_ORDER,
  createPromptConfigs,
  getEngineMeta,
} from '../../engine/schema.mjs'

const options = { loadTemplate: () => null }

// ───────────────────────── T2：字段表驱动 ─────────────────────────

test('字段表驱动：每个枚举字段都自动获得校验，无需逐字段写断言', () => {
  const enumRules = CONFIG_FIELDS.filter((rule) => rule.known !== undefined)
  assert.ok(enumRules.length >= 7, `至少 7 个枚举字段（实际 ${enumRules.length}）`)
  for (const rule of enumRules) {
    // 非法值必须按 `${name}: ${label} unknown <field> <json>` 抛出——这条断言对表里**每个**
    // 枚举字段自动成立，所以新增一个枚举字段时不需要再写一行测试。
    assert.throws(
      () => createPromptConfigs([{ id: 'a', [rule.field]: '__not_a_member__' }], options),
      new RegExp(`unknown ${rule.field} `),
      `${rule.field} 应自动获得枚举校验`,
    )
  }
})

test('字段表驱动：每个形态字段都自动获得校验（validate 分支同理）', () => {
  const shapeRules = CONFIG_FIELDS.filter((rule) => rule.validate !== undefined)
  assert.ok(shapeRules.length >= 4, `至少 4 个形态字段（实际 ${shapeRules.length}）`)
  for (const rule of shapeRules) {
    const bad = rule.field === 'exclusive' ? 'not-a-boolean' : rule.field === 'order' ? 'not-a-number' : ''
    assert.throws(
      () => createPromptConfigs([{ id: 'a', [rule.field]: bad }], options),
      new RegExp(`\\.${rule.field} `),
      `${rule.field} 应自动获得形态校验`,
    )
  }
})

test('字段表顺序 = 报错顺序：多字段同时非法时先报表里靠前的那个', () => {
  const index = new Map(CONFIG_FIELDS.map((rule, at) => [rule.field, at]))
  // 每个字段用它**自己的**非法值：非空字符串对 group/name 是合法的，用错值会让断言假绿。
  const BAD = {
    position: '__bad__', subject: '__bad__', order: '__bad__',
    group: '', name: '', texts: [1], dedupe: '__bad__', modelScope: '__bad__', mergeMode: '__bad__',
  }
  const pairs = [
    ['position', 'mergeMode'],
    ['subject', 'order'],
    ['order', 'group'],
    ['name', 'texts'],
    ['dedupe', 'modelScope'],
  ]
  for (const [first, second] of pairs) {
    assert.ok(index.get(first) < index.get(second), `用例本身要求 ${first} 在 ${second} 之前`)
    const spec = { id: 'a', [first]: BAD[first], [second]: BAD[second] }
    // 两个字段都非法时，消息里出现的必须是表里靠前的那个字段。
    assert.throws(
      () => createPromptConfigs([spec], options),
      new RegExp(`(unknown ${first} |\\.${first} )`),
      `${first} 应先于 ${second} 报错`,
    )
    // 反向确认第二个字段**确实**非法（否则这条用例什么都没证明）。
    if (second !== 'name' && second !== 'group') {
      assert.throws(() => createPromptConfigs([{ id: 'a', [second]: BAD[second] }], options),
        new RegExp(`(unknown ${second} |\\.${second} )`), `${second} 的非法值本身必须会抛错`)
    }
  }
})

test('字段表结构自洽：字段名唯一、known 是 Set、每条的旋钮组合有意义', () => {
  const fields = CONFIG_FIELDS.map((rule) => rule.field)
  assert.equal(new Set(fields).size, fields.length, '字段名不得重复')
  for (const rule of CONFIG_FIELDS) {
    assert.equal(typeof rule.field, 'string')
    if (rule.known !== undefined) assert.ok(rule.known instanceof Set, `${rule.field}.known 应是 Set`)
    // 三种 null 处置互斥且各有归属：keepNull 只给「显式 null 合法」的字段。
    if (rule.keepNull === true) assert.ok(rule.known !== undefined, `${rule.field}: keepNull 需要 known 才有意义`)
    if (rule.validate !== undefined) assert.equal(typeof rule.problem, 'string', `${rule.field}: validate 必须带 problem 文案`)
    // 枚举与 validate 不共存（枚举走 unknown 分支，形态走 problem 分支）。
    assert.ok(rule.known === undefined || rule.validate === undefined, `${rule.field}: 枚举与形态校验不共存`)
  }
})

// ───────────────────────── T1：层定义派生的不变量 ─────────────────────────

test('九层顺序固定，且所有派生物都恰好覆盖这九层', () => {
  assert.deepEqual(LAYER_ORDER, [
    'pre-step', 'system-section', 'runtime-context', 'agent-request', 'llm-stream', 'tool-pipeline',
    'turn-stop', 'subagent-start', 'subagent-end',
  ], '层顺序是产品定义，改动必须是有意的')
  for (const [name, table] of [
    ['LAYER_FIELD_POLICIES', LAYER_FIELD_POLICIES],
    ['LAYER_LABELS', LAYER_LABELS],
    ['LAYER_CONTRACTS', LAYER_CONTRACTS],
  ]) {
    assert.deepEqual(Object.keys(table), LAYER_ORDER, `${name} 必须按同一顺序覆盖全部九层`)
  }
})

test('每层的能力矩阵恰好 11 项，标签与契约字段完整', () => {
  const fields = ['position', 'dedupe', 'promotion', 'audience', 'modelScope', 'merge', 'order', 'role', 'placeholder', 'subject', 'match']
  for (const layer of LAYER_ORDER) {
    assert.deepEqual(Object.keys(LAYER_FIELD_POLICIES[layer]), fields, `${layer} 的能力矩阵字段与顺序`)
    for (const value of Object.values(LAYER_FIELD_POLICIES[layer])) assert.equal(typeof value, 'boolean')
    assert.equal(typeof LAYER_LABELS[layer].title, 'string')
    assert.equal(typeof LAYER_LABELS[layer].detail, 'string')
    const contract = LAYER_CONTRACTS[layer]
    assert.ok(Array.isArray(contract.strategies), `${layer}.strategies 是数组`)
    assert.ok(Array.isArray(contract.subjects), `${layer}.subjects 是数组`)
    assert.equal(typeof contract.content, 'string')
    assert.equal(typeof contract.variables, 'boolean')
    assert.equal(typeof contract.messageMetadata, 'boolean')
    assert.equal(typeof contract.params, 'object')
  }
})

test('缺省匹配对象必须在同层 subjects 内（新增层时最先撞到的不变量）', () => {
  for (const [layer, subject] of Object.entries(LAYER_DEFAULT_SUBJECT)) {
    assert.ok(LAYER_CONTRACTS[layer].subjects.includes(subject),
      `${layer}: defaultSubject ${subject} 必须在 subjects 内`)
  }
  assert.deepEqual([...CONDITIONAL_LAYERS].sort(), Object.keys(LAYER_DEFAULT_SUBJECT).sort(),
    'CONDITIONAL_LAYERS 与 LAYER_DEFAULT_SUBJECT 同域')
  assert.deepEqual(Object.keys(LAYER_DEFAULT_SUBJECT), [
    'pre-step', 'tool-pipeline', 'turn-stop', 'subagent-start', 'subagent-end',
  ], '只有这五层有条件缺省 subject')
})

test('subject 的两条语义都还在：全局集合外与层内不可用分别报错', () => {
  assert.throws(() => createPromptConfigs([{ id: 'a', subject: 'nope' }], options),
    /unknown subject "nope" — known subjects: /)
  assert.throws(() => createPromptConfigs([{ id: 'a', layer: 'pre-step', subject: 'toolArgs' }], options),
    /\.subject "toolArgs" is unavailable on layer "pre-step"/)
  // 合法：本层允许 + 层缺省回退。
  const [ok] = createPromptConfigs([{ id: 'a', layer: 'tool-pipeline', subject: 'toolResult' }], options)
  assert.equal(ok.subject, 'toolResult')
  const [fallback] = createPromptConfigs([{ id: 'a', layer: 'pre-step' }], options)
  assert.equal(fallback.subject, 'userMessage', '缺省来自层定义')
  const [none] = createPromptConfigs([{ id: 'a', layer: 'system-section' }], options)
  assert.equal(none.subject, undefined, '无条件缺省的层得到 undefined')
})

test('getEngineMeta() 的层相关字段与各派生物同源', () => {
  const meta = getEngineMeta()
  assert.deepEqual(meta.layerOrder, LAYER_ORDER)
  assert.deepEqual(meta.layers, [...LAYER_ORDER].sort())
  assert.deepEqual(meta.layerFieldPolicies, LAYER_FIELD_POLICIES)
  assert.deepEqual(meta.layerLabels, LAYER_LABELS)
  assert.deepEqual(meta.layerDefaultSubjects, LAYER_DEFAULT_SUBJECT)
  assert.deepEqual(meta.layerContracts, LAYER_CONTRACTS)
  assert.deepEqual(meta.subjects, [...new Set(Object.values(LAYER_CONTRACTS).flatMap((contract) => contract.subjects))].sort()
    .concat(['userMessage']).filter((value, at, all) => all.indexOf(value) === at).sort(), 'subjects 覆盖各层允许集合')
})
