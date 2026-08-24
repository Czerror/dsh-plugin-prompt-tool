import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离 DSH_HOME：与 host 层其他测试一致（转换引擎虽无 IO，保底隔离）。
const home = mkdtempSync(join(tmpdir(), 'pt-st-home-'))
process.env.DSH_HOME = home
const { convertStToPreset, stPresetId } = await import('../../lib/index.mjs')

/** 官方 agent-presets discovery 的目录名校验（lib/index.js PRESET_ID）。 */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

test('stPresetId：中英混合文件名 slug 化（官方 agent-presets 可发现）', () => {
  // 调用方契约：baseName 已剥 .json 扩展名（settings-bridge/characters 均 replace(/\.json$/i,'')）。
  const id = stPresetId('夏瑾-天琴座-beta-2-42')
  assert.match(id, PRESET_ID, 'id 必须满足官方 PRESET_ID')
  assert.equal(id, 'beta-2-42')
})

test('stPresetId：纯中文文件名退化为 st-<hash>（唯一且合法）', () => {
  const id = stPresetId('夏瑾')
  assert.match(id, PRESET_ID)
  assert.match(id, /^st-[0-9a-f]{6}$/)
  // 不同文件名 → 不同 id（防止多张中文卡互相覆盖）
  assert.notEqual(stPresetId('天琴座'), id)
})

test('stPresetId：英文文件名保持 slug', () => {
  assert.equal(stPresetId('My Card v2'), 'my-card-v2')
})

test('convertStToPreset：世界书正则键保留原样且不写幽灵字段 useRegex', () => {
  const card = {
    name: '测试卡',
    data: {
      character_book: {
        entries: [
          { keys: ['/^剑\\d+$/'], content: '剑术规则', comment: '剑术', insertion_order: 10 },
          { keys: ['普通词'], content: '普通条目', comment: '普通', insertion_order: 20 },
        ],
      },
    },
  }
  const spec = convertStToPreset(card, 'test-card')
  const lore = spec.promptConfigs.filter((config) => config.strategy === 'world-book')
  assert.equal(lore.length, 2, '两条世界书条目都转换')
  assert.equal(lore[0].params.keys[0], '/^剑\\d+$/')
  assert.equal('useRegex' in lore[0].params, false, '不写幽灵字段 useRegex')
  assert.equal('useRegex' in lore[1].params, false)
})
