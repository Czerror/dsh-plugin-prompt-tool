/**
 * 工具面「官方预设」来源清单的过滤规则。
 *
 * 真值源：本插件的模块会被登记成官方预设身份，因此官方 roster 里**混着两类东西**——
 * 真官方预设（standard / minimal / ptc / cordis…）与本插件模块（用户存储根里的那些）。
 * 而模块的工具面由会话装配决定、已由「当前会话工具」完整体现，不该再作为「预设来源」
 * 出现在这一栏。这里锁死这条区分规则。
 *
 * 断言落在调用方观察到的返回值上（谁进、谁不进），不碰实现细节。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { officialPresetSources } from '../../src/client/features/tools/preset-sources.ts'

test('列出来源时排除本插件模块，只留官方预设', () => {
  const roster = [
    { id: 'standard', name: 'standard' },
    { id: 'minimal', name: 'minimal' },
    { id: 'ptc', name: 'ptc' },
    { id: 'cordis', name: 'cordis' },
    { id: 'ponytail', name: 'Ponytail 懒懒资深工程师模式' },
    { id: 'beta-2-42', name: '夏瑾 天琴座 Beta 2.42' },
  ]
  const kept = officialPresetSources(roster, ['ponytail', 'beta-2-42']).map((preset) => preset.id)
  assert.deepEqual(kept, ['standard', 'minimal', 'ptc', 'cordis'], '本插件模块不进这个列表')
})

test('已损坏的官方预设同样不进列表（既有判据不因这次改动丢失）', () => {
  const roster = [
    { id: 'standard' },
    { id: 'broken-one', broken: '缺少组合文件' },
  ]
  const kept = officialPresetSources(roster, []).map((preset) => preset.id)
  assert.deepEqual(kept, ['standard'], 'broken 的预设被排除')
})

test('没有本插件模块时原样保留顺序（过滤不重排、不丢项）', () => {
  const roster = [{ id: 'cordis' }, { id: 'standard' }, { id: 'ptc' }]
  const kept = officialPresetSources(roster, []).map((preset) => preset.id)
  assert.deepEqual(kept, ['cordis', 'standard', 'ptc'], '保持 roster 原顺序')
})

test('来源清单缺省或为空时退化为「只滤 broken」', () => {
  const roster = [{ id: 'standard' }, { id: 'minimal' }]
  assert.deepEqual(officialPresetSources(roster, undefined).map((p) => p.id), ['standard', 'minimal'])
  assert.deepEqual(officialPresetSources(roster, []).map((p) => p.id), ['standard', 'minimal'])
  assert.deepEqual(officialPresetSources([], ['ponytail']), [], '空 roster 得空表')
})
