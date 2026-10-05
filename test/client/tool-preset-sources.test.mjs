/**
 * 工具面「官方预设」来源清单的过滤规则。
 *
 * 真值源：官方 roster 的元素形状——`broken` 非空表示缺组合文件，选中它读不出工具面。
 * 本插件的模块不登记为官方预设、本来就不在 roster 里，因此这里不再有「区分两类 id」的规则。
 *
 * 断言落在调用方观察到的返回值上（谁进、谁不进），不碰实现细节。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { officialPresetSources } from '../../src/client/features/tools/preset-sources.ts'

test('已损坏的官方预设不进列表，可用项原样保留顺序（缺组合文件 ⇒ 选中也读不出工具面）', () => {
  const roster = [
    { id: 'cordis' },
    { id: 'standard' },
    { id: 'broken-one', broken: '缺少组合文件' },
    { id: 'ptc' },
  ]
  assert.deepEqual(officialPresetSources(roster).map((preset) => preset.id), ['cordis', 'standard', 'ptc'], 'broken 的预设被排除，其余保持 roster 原顺序')
})
