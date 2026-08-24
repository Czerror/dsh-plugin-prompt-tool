import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MATCH_LOGIC, createAnchorMatcher } from '../../engine/anchor-match.mjs'

test('anchor-match any：主键或副键任一命中激活（ST AND_ANY）', () => {
  const m = createAnchorMatcher({ keys: ['剑'], secondaryKeys: ['鞘'] })
  assert.equal(m.scan('一把剑').active, true, '主键命中')
  assert.equal(m.scan('剑鞘').active, true, '副键命中')
  assert.equal(m.scan('盾').active, false, '均未命中')
})

test('anchor-match all：主键命中且副键全部命中（ST AND_ALL）', () => {
  const m = createAnchorMatcher({ keys: ['剑'], secondaryKeys: ['鞘', '刃'], logic: MATCH_LOGIC.ALL })
  assert.equal(m.scan('剑与鞘').active, false, '缺副键 刃')
  assert.equal(m.scan('剑鞘刃').active, true, '副键全中')
  assert.equal(m.scan('鞘刃').active, false, '缺主键')
})

test('anchor-match not：主键命中且副键全部未命中（ST NOT_ALL/NOT_ANY 排除）', () => {
  const m = createAnchorMatcher({ keys: ['盾'], secondaryKeys: ['破'], logic: MATCH_LOGIC.NOT })
  assert.equal(m.scan('盾牌').active, true, '副键未命中')
  assert.equal(m.scan('破盾').active, false, '副键命中 → 排除')
})

test('anchor-match notAny：主键命中且至少一个副键未命中（ST NOT_ANY）', () => {
  const m = createAnchorMatcher({ keys: ['盾'], secondaryKeys: ['破', '裂'], logic: MATCH_LOGIC.NOT_ANY })
  assert.equal(m.scan('盾牌').active, true, '副键全未中')
  assert.equal(m.scan('破盾').active, true, '部分副键命中（仍有一个未中）')
  assert.equal(m.scan('破盾裂').active, false, '副键全中 → 排除')
})

test('anchor-match 选项：caseSensitive / wholeWords / useRegex', () => {
  const cs = createAnchorMatcher({ keys: ['Sword'], caseSensitive: true })
  assert.equal(cs.scan('sword').active, false, '大小写敏感')
  assert.equal(cs.scan('Sword').active, true)
  const ww = createAnchorMatcher({ keys: ['剑'], wholeWords: true })
  assert.equal(ww.scan('剑客').active, false, '后接汉字非整词')
  assert.equal(ww.scan('《剑》').active, true, '标点边界整词')
  const rx = createAnchorMatcher({ keys: ['^剑\\d+$'], useRegex: true })
  assert.equal(rx.scan('剑123').active, true, '正则键')
  assert.equal(rx.scan('剑abc').active, false)
})

test('anchor-match 正则键检测（ST parseRegexFromString：仅 /pattern/ 包裹，其余字面）', () => {
  const wrapped = createAnchorMatcher({ keys: ['/^剑\\d+$/'] })
  assert.equal(wrapped.scan('剑123').active, true, '/包裹正则命中')
  assert.equal(wrapped.scan('剑abc').active, false, '/包裹正则未命中')
  const special = createAnchorMatcher({ keys: ['剑\\d+'] })
  assert.equal(special.scan('剑\\d+').active, true, '裸特殊字符键按字面匹配（ST 无自动检测）')
  assert.equal(special.scan('剑123').active, false, '裸正则形态不生效')
  const literal = createAnchorMatcher({ keys: ['剑·刃'] })
  assert.equal(literal.scan('剑·刃').active, true, '无特殊字符按字面')
  assert.equal(literal.scan('剑').active, false, '字面键不误判')
  const macro = createAnchorMatcher({ keys: ['{{user}}'] })
  assert.equal(macro.scan('{{user}} 说').active, true, '{{user}} 宏键按字面命中')
  assert.equal(macro.scan('user').active, false, '花括号键不做正则解析')
  const badDelim = createAnchorMatcher({ keys: ['/a/b/'] })
  assert.equal(badDelim.scan('a/b').active, false, '模式内未转义分隔符视为非法 → 字面不命中')
  assert.equal(badDelim.scan('/a/b/').active, true, '非法正则回退字面匹配')
  const forcedLiteral = createAnchorMatcher({ keys: ['a+b'], useRegex: false })
  assert.equal(forcedLiteral.scan('a+b').active, true, 'useRegex=false 强制字面')
  assert.equal(forcedLiteral.scan('aaab').active, false, '强制字面不按正则')
  const forcedRx = createAnchorMatcher({ keys: ['a+b'], useRegex: true })
  assert.equal(forcedRx.scan('aaab').active, true, 'useRegex=true 强制正则')
})

test('anchor-match prefix：custom-fallback 锚定确认语义（开头匹配）', () => {
  const en = createAnchorMatcher({ keys: ['we'], mode: 'prefix' })
  assert.equal(en.scan('we need to...').active, true, 'ASCII 词边界前缀')
  assert.equal(en.scan('...we...').active, false, '非开头不命中')
  const cn = createAnchorMatcher({ keys: ['我是xxx'], mode: 'prefix' })
  assert.equal(cn.scan('我是xxx，开始分析').active, true, '非 ASCII 直前缀')
  assert.equal(cn.scan('他说我是xxx').active, false)
})
