/**
 * 受众事实：条件树 → 受众集合的唯一判据。
 *
 * 真值源是 docs/engine-reuse.md 的语法契约与 grilling 确认的矩阵：
 * scope 精确、all 求交（AND 只会更窄）、any 保守、not/notAny 只对精确结果取补、
 * 其余不收窄；动作级按 bypassRuleWhen 合并（else 动作自带 not(if)）。
 * 空数组与非法形状用例是导出 API 的防御契约，不是可编译语法——compileWhen 会先拒绝它们。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { COMPOSITE_OPERATORS } from '../../engine/conditions/index.mjs'
import { actionAudiences, audienceOf, compileRules } from '../../engine/rule-spec.mjs'
import { ruleFacts } from '../../engine/rule-facts.mjs'

const set = (...values) => new Set(values)
const both = () => set('main', 'subagent')

test('audienceOf：scope 精确匹配，其余条件不收窄', () => {
  assert.deepEqual(audienceOf({ scope: { audience: 'main' } }), set('main'))
  assert.deepEqual(audienceOf({ scope: { audience: 'subagent' } }), set('subagent'))
  assert.equal(audienceOf({ scope: { audience: 'both' } }), undefined)
  assert.equal(audienceOf({ anchor: {} }), undefined)
  assert.equal(audienceOf(null), undefined)
  assert.equal(audienceOf([]), undefined)
  assert.equal(audienceOf('nope'), undefined)
})

test('audienceOf：all 求交，无法收窄的子条件被跳过', () => {
  assert.deepEqual(audienceOf({ all: [{ scope: { audience: 'main' } }, { anchor: {} }] }), set('main'))
  assert.deepEqual(audienceOf({ all: [{ scope: { audience: 'main' } }, { scope: { audience: 'subagent' } }] }), set())
  assert.deepEqual(audienceOf({ all: [] }), both())
})

test('audienceOf：any 保守，任一分支无法收窄即整体未知', () => {
  assert.deepEqual(audienceOf({ any: [{ scope: { audience: 'main' } }, { scope: { audience: 'subagent' } }] }), both())
  assert.equal(audienceOf({ any: [{ scope: { audience: 'main' } }, { anchor: {} }] }), undefined)
  assert.deepEqual(audienceOf({ any: [] }), set())
})

test('audienceOf：scope 同节点带 modelScope 时不算精确', () => {
  assert.deepEqual(audienceOf({ scope: { audience: 'main', modelScope: 'pro' } }), set('main'))
  assert.deepEqual(audienceOf({ scope: { audience: 'main', modelScope: 'all' } }), set('main'))
  assert.equal(audienceOf({ not: { scope: { audience: 'main', modelScope: 'pro' } } }), undefined)
})

test('audienceOf：非精确结果不能取补，not / notAny 返回未知', () => {
  const main = { scope: { audience: 'main' } }
  // all 跳过 anchor 后只剩 main，但那是「可能命中」的上界：取补会错误排除 main。
  assert.equal(audienceOf({ not: { all: [main, { anchor: {} }] } }), undefined)
  assert.equal(audienceOf({ notAny: [{ all: [main, { anchor: {} }] }] }), undefined)
  // 精确子节点仍可取补。
  assert.deepEqual(audienceOf({ not: { all: [main] } }), set('subagent'))
})

test('audienceOf：not / notAny 取补，子条件未知则未知', () => {
  assert.deepEqual(audienceOf({ not: { scope: { audience: 'main' } } }), set('subagent'))
  assert.deepEqual(audienceOf({ notAny: [{ scope: { audience: 'subagent' } }] }), set('main'))
  assert.equal(audienceOf({ not: { anchor: {} } }), undefined)
  assert.equal(audienceOf({ notAny: [{ anchor: {} }] }), undefined)
})

test('audienceOf：非法算子形状按无法收窄处理，不抛错', () => {
  assert.equal(audienceOf({ all: null }), undefined)
  assert.equal(audienceOf({ any: 'nope' }), undefined)
  assert.equal(audienceOf({ notAny: {} }), undefined)
  assert.equal(audienceOf({ not: null }), undefined)
})

test('受众推导覆盖全部组合算子（新增算子时此映射先红）', () => {
  const main = { scope: { audience: 'main' } }
  const cases = {
    all: { all: [main] },
    any: { any: [main] },
    not: { not: main },
    notAny: { notAny: [main] },
  }
  for (const operator of COMPOSITE_OPERATORS) {
    assert.ok(cases[operator] !== undefined, `受众映射缺少算子 ${operator}`)
    assert.notEqual(audienceOf(cases[operator]), undefined, `${operator} 需要可区分的受众结果`)
  }
  assert.equal(audienceOf({ xor: [{ scope: { audience: 'main' } }] }), undefined, '未知算子不静默当成组合节点')
})

test('actionAudiences：普通动作取规则 when 与动作条件的交集', () => {
  const rule = compileRules([{
    id: 'r',
    if: { scope: { audience: 'main' } },
    then: [{ id: 'a', kind: 'tool-gate', decision: 'allow' }],
  }])[0]
  assert.deepEqual(actionAudiences(rule, 'a'), set('main'))
})

test('actionAudiences：动作级分支条件收窄最终受众', () => {
  const rule = compileRules([{
    id: 'r',
    if: { scope: { audience: 'main' } },
    then: [{
      if: { scope: { audience: 'subagent' } },
      then: [{ id: 'a', kind: 'tool-gate', decision: 'allow' }],
    }],
  }])[0]
  assert.deepEqual(actionAudiences(rule, 'a'), set())
})

test('actionAudiences：规则与动作都无条件时为两个受众', () => {
  const rule = compileRules([{ id: 'r', then: [{ id: 'a', kind: 'tool-gate', decision: 'allow' }] }])[0]
  assert.deepEqual(actionAudiences(rule, 'a'), both())
})

test('actionAudiences：else 动作自带 not(if)，不再叠规则级 when', () => {
  const rule = compileRules([{
    id: 'r',
    if: { scope: { audience: 'main' } },
    then: [{ id: 't', kind: 'tool-gate', decision: 'allow' }],
    else: [{ id: 'a', kind: 'tool-gate', decision: 'allow' }],
  }])[0]
  assert.deepEqual(actionAudiences(rule, 't'), set('main'))
  assert.deepEqual(actionAudiences(rule, 'a'), set('subagent'))
})

test('actionAudiences：未知动作 id 退回两个受众（防御分支）', () => {
  const rule = compileRules([{ id: 'r', then: [{ id: 'a', kind: 'tool-gate', decision: 'allow' }] }])[0]
  assert.deepEqual(actionAudiences(rule, 'missing'), both())
})

test('ruleFacts：then + else 的受众并集包含两个受众', () => {
  const rule = {
    id: 'r',
    if: { scope: { audience: 'main' } },
    then: [{ id: 't', kind: 'tool-gate', decision: 'allow' }],
    else: [{ id: 'e', kind: 'tool-gate', decision: 'allow' }],
  }
  assert.deepEqual(ruleFacts(rule).audiences, both())
})

test('ruleFacts：not 收窄到子代理', () => {
  const rule = {
    id: 'r',
    if: { not: { scope: { audience: 'main' } } },
    then: [{ id: 't', kind: 'tool-gate', decision: 'allow' }],
  }
  assert.deepEqual(ruleFacts(rule).audiences, set('subagent'))
})

test('ruleFacts：动作自己的受众目标也参与收窄', () => {
  const rule = {
    id: 'r',
    then: [{ id: 't', kind: 'inject-text', config: { layer: 'pre-step', audience: 'main', text: 'x' } }],
  }
  assert.deepEqual(ruleFacts(rule).audiences, set('main'))
})

test('ruleFacts：嵌套分支的 else 与规则级 if 求交', () => {
  const rule = {
    id: 'r',
    if: { scope: { audience: 'main' } },
    then: [{
      if: { scope: { audience: 'main' } },
      then: [{ id: 'n', kind: 'tool-gate', decision: 'allow' }],
      else: [{ id: 'ne', kind: 'tool-gate', decision: 'allow' }],
    }],
  }
  // 嵌套 else 的条件是 not(branch.if)=subagent，再与规则级 main 求交为空；只剩 then 的 main。
  assert.deepEqual(ruleFacts(rule).audiences, set('main'))
})

test('ruleFacts：未知组合与空动作按保守方向返回 undefined', () => {
  const unknown = {
    id: 'r',
    if: { any: [{ scope: { audience: 'main' } }, { anchor: {} }] },
    then: [{ id: 'a', kind: 'tool-gate', decision: 'allow' }],
  }
  assert.equal(ruleFacts(unknown).audiences, undefined)
  assert.equal(ruleFacts({ id: 'empty', then: [] }).audiences, undefined)
  assert.deepEqual(ruleFacts({ id: 'empty-main', if: { scope: { audience: 'main' } }, then: [] }).audiences, set('main'),
    '没有动作的编辑卡仍按规则级 if 过滤')
  assert.equal(ruleFacts(null).audiences, undefined)
})

test('ruleFacts：context activation 顶层、嵌套、普通注入', () => {
  const top = {
    id: 'top',
    then: [{ id: 'a', kind: 'inject-text', config: { layer: 'pre-step', strategy: 'context-activation', text: 'x' } }],
  }
  const nested = {
    id: 'nested',
    then: [{
      if: { scope: { audience: 'main' } },
      then: [{ id: 'a', kind: 'inject-text', config: { layer: 'pre-step', strategy: 'context-activation', text: 'x' } }],
    }],
  }
  const plain = {
    id: 'plain',
    then: [{ id: 'a', kind: 'inject-text', config: { layer: 'pre-step', strategy: 'static', text: 'x' } }],
  }
  const unfinished = {
    id: 'unfinished',
    then: [{
      then: [{ id: 'a', kind: 'inject-text', config: { layer: 'pre-step', strategy: 'context-activation', text: 'x' } }],
    }],
  }
  assert.equal(ruleFacts(top).contextActivation, true)
  assert.equal(ruleFacts(nested).contextActivation, true)
  assert.equal(ruleFacts(plain).contextActivation, false)
  assert.equal(ruleFacts(unfinished).contextActivation, true, '缺 if 的未完成分支仍能发现 context activation')
})

test('ruleFacts：受众并集与 actionAudiences 对拍', () => {
  const cases = [
    {
      id: 'else',
      if: { scope: { audience: 'main' } },
      then: [{ id: 't', kind: 'tool-gate', decision: 'allow' }],
      else: [{ id: 'e', kind: 'tool-gate', decision: 'allow' }],
    },
    {
      id: 'not',
      if: { not: { scope: { audience: 'main' } } },
      then: [{ id: 't', kind: 'tool-gate', decision: 'allow' }],
    },
    {
      id: 'nested',
      if: { scope: { audience: 'main' } },
      then: [{
        if: { scope: { audience: 'main' } },
        then: [{ id: 'n', kind: 'tool-gate', decision: 'allow' }],
        else: [{ id: 'ne', kind: 'tool-gate', decision: 'allow' }],
      }],
    },
    {
      id: 'unknown-any',
      if: { any: [{ scope: { audience: 'main' } }, { anchor: {} }] },
      then: [{ id: 'a', kind: 'tool-gate', decision: 'allow' }],
    },
  ]
  for (const raw of cases) {
    const rule = compileRules([raw])[0]
    const union = new Set()
    for (const action of rule.actions) {
      for (const audience of actionAudiences(rule, action.id)) union.add(audience)
    }
    const facts = ruleFacts(raw)
    if (facts.audiences === undefined) {
      assert.deepEqual(union, both(), raw.id + '：无法收窄时引擎仍是两个受众')
    } else {
      assert.deepEqual(facts.audiences, union, raw.id)
    }
  }
})
