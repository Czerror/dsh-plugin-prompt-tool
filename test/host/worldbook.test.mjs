import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

// 隔离 DSH_HOME：host 层测试惯例。
const home = mkdtempSync(join(tmpdir(), 'pt-wb-home-'))
process.env.DSH_HOME = home
const { buildWorldBookEntry, deleteWorldBookEntry, listWorldBookEntries, upsertWorldBookEntry } = await import('../../lib/index.mjs')

const dir = mkdtempSync(join(tmpdir(), 'pt-wb-preset-'))
writeFileSync(join(dir, 'preset.yml'), [
  'id: wb-test',
  'name: 世界书测试',
  'version: 1.0.0',
  'engineCompat: ">=0.4.2"',
  'promptConfigs:',
  '  - id: static-one',
  '    name: 普通配置',
  '    strategy: static',
  '    order: 1',
  '    text: 普通',
  '  - id: lore-1',
  '    name: 已有条目',
  '    strategy: world-book',
  '    order: -100',
  '    text: 旧内容',
  '    params:',
  '      constant: true',
  '',
].join('\n'), 'utf8')

test('worldbook list：只返回 world-book 策略配置', () => {
  const entries = listWorldBookEntries(dir)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, 'lore-1')
})

test('buildWorldBookEntry 结构工厂：固定字段与 params 键集单一权威', () => {
  const entry = buildWorldBookEntry({
    id: 'lore-x',
    name: '气味描写',
    text: '空气中弥漫着…',
    constant: false,
    keys: ['气味', 'smell'],
    secondaryKeys: ['香水'],
    caseSensitive: true,
    wholeWords: true,
    selectiveLogic: 1,
  })
  assert.equal(entry.strategy, 'world-book')
  assert.equal(entry.layer, 'pre-step')
  assert.equal(entry.position, 'before-all')
  assert.equal(entry.order, 100, 'order 缺省 100')
  assert.deepEqual(entry.params, {
    constant: false,
    keys: ['气味', 'smell'],
    secondaryKeys: ['香水'],
    caseSensitive: true,
    wholeWords: true,
    selectiveLogic: 1,
  })
  // 空列表/缺省不写键（与 ST/工具通道历史产物一致）。
  const minimal = buildWorldBookEntry({ id: 'lore-y', name: '全局', text: 't', constant: true })
  assert.deepEqual(minimal.params, { constant: true })
  assert.equal(minimal.enabled, undefined, 'enabled 缺省不写')
})

test('buildWorldBookEntry 两通道同构：模型工具参数形态 = 工厂直接构造', () => {
  const viaTool = buildWorldBookEntry({
    id: 'lore-a',
    name: '条目',
    text: '内容',
    constant: true,
    keys: ['k1'],
  })
  assert.equal(viaTool.enabled, undefined)
  assert.deepEqual(viaTool.params, { constant: true, keys: ['k1'] })
  // 工具 enabled=false 显式关闭。
  const disabled = buildWorldBookEntry({ id: 'lore-b', name: 'n', text: 't', constant: false, enabled: false })
  assert.equal(disabled.enabled, false)
})

test('worldbook upsert：新增与更新（按 id），count 只统计世界书条目', () => {
  const added = upsertWorldBookEntry(dir, {
    id: 'lore-new',
    name: '新条目',
    strategy: 'world-book',
    order: -50,
    text: '新内容',
    layer: 'pre-step',
    position: 'before-all',
    params: { keys: ['新词'] },
  })
  assert.equal(added, 2, '新增后世界书条目数 = 2')

  const updated = upsertWorldBookEntry(dir, {
    id: 'lore-1',
    name: '已有条目',
    strategy: 'world-book',
    order: -200,
    text: '更新内容',
    params: { constant: true },
  })
  assert.equal(updated, 2, '更新不新增')

  const preset = parseYaml(readFileSync(join(dir, 'preset.yml'), 'utf8'))
  const lore1 = preset.promptConfigs.find((config) => config.id === 'lore-1')
  assert.equal(lore1.text, '更新内容')
  assert.equal(lore1.order, -200)
  assert.equal(preset.promptConfigs.length, 3, '普通配置保留')
})

test('worldbook upsert：缺 id 抛 TypeError', () => {
  assert.throws(
    () => upsertWorldBookEntry(dir, { name: '无 id', strategy: 'world-book' }),
    /非空字符串 id/,
  )
})

test('worldbook delete：删除并计数；不存在抛错', () => {
  const after = deleteWorldBookEntry(dir, 'lore-new')
  assert.equal(after, 1)
  assert.throws(() => deleteWorldBookEntry(dir, 'lore-new'), /不存在/)
  const entries = listWorldBookEntries(dir)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, 'lore-1')
})
