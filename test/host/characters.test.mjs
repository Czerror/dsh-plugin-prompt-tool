import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

// 隔离 DSH_HOME：角色卡库操作全部走显式 presetRoot 参数。
const home = mkdtempSync(join(tmpdir(), 'pt-chara-home-'))
process.env.DSH_HOME = home
const {
  appendCharacterMemory,
  appendMemoryFile,
  applyCharacterToPreset,
  importCharacterCard,
  importCharacterCardFile,
  listCharacterCards,
  syncImportedCharacterMemory,
} = await import('../../lib/index.mjs')

const root = mkdtempSync(join(tmpdir(), 'pt-chara-root-'))
const template = 'anchored'
const presetDir = join(root, template)

// 预建激活预设（applyCharacterToPreset 只更新不创建）。
mkdirSync(presetDir, { recursive: true })
writeFileSync(join(presetDir, 'preset.yml'), [
  'id: anchored',
  'name: 测试预设',
  'version: 1.0.0',
  'engineCompat: ">=0.4.2"',
  'meta:',
  '  order: 1',
  'promptConfigs: []',
  '',
].join('\n'), 'utf8')

/** 最小角色卡 JSON（chara_card_v3：内容在 data 内层）。 */
const cardJson = JSON.stringify({
  spec: 'chara_card_v3',
  name: '测试角色',
  data: {
    name: '测试角色',
    description: '一位测试角色。',
    personality: '冷静。',
    first_mes: '你好。',
    character_book: {
      entries: [
        { keys: ['剑'], content: '剑术高超。', comment: '剑术', insertion_order: 10 },
      ],
    },
  },
})

test('importCharacterCard + applyCharacterToPreset：卡入库并导入预设（含记忆条目）', () => {
  const imported = importCharacterCard(root, [{ path: '测试角色.json', content: cardJson }])
  assert.equal(imported.ok, true)
  // 中文卡 id = st-<hash>（stPresetId 退化规则）；后续操作一律用返回 id。
  const cardId = imported.ok ? imported.id : ''
  assert.match(cardId, /^st-[0-9a-f]{6}$/)

  // 追加角色记忆后再导入 → 记忆条目随之合并。
  appendCharacterMemory(root, cardId, '她喜欢下雨天。')
  const applied = applyCharacterToPreset(root, template, cardId)
  assert.equal(applied.ok, true)

  const preset = parseYaml(readFileSync(join(presetDir, 'preset.yml'), 'utf8'))
  const memoryEntry = preset.promptConfigs.find((config) => config.id === `chara-${cardId}-memory`)
  assert.ok(memoryEntry, '记忆条目存在')
  assert.match(memoryEntry.text, /喜欢下雨天/, '记忆文本已合并')
  assert.equal(memoryEntry.params.constant, true, '记忆条目为 world-book constant')
  assert.deepEqual(preset.meta.importedCharacters, [cardId])

  const listed = listCharacterCards(root, template)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].imported, true)
})

test('applyCharacterToPreset：导入含 system-section 的卡自动开放 persona-main complete（ST system prompt 层级开放）', () => {
  // 预建含 persona-main complete: true 的激活预设。
  const dir = mkdtempSync(join(tmpdir(), 'pt-chara-open-'))
  const template = 'anchored'
  const presetDir = join(dir, template)
  mkdirSync(presetDir, { recursive: true })
  writeFileSync(join(presetDir, 'preset.yml'), [
    'id: anchored',
    'name: 测试预设',
    'version: 1.0.0',
    'engineCompat: ">=0.4.2"',
    'meta:',
    '  order: 1',
    'promptConfigs:',
    '  - id: persona-main',
    '    name: 主会话人设',
    '    layer: system-section',
    '    strategy: static',
    '    order: 0',
    '    text: 默认人设',
    '    params:',
    '      sectionName: deployment:persona',
    '      complete: true',
    '      suppressRuntimeContext: true',
    '',
  ].join('\n'), 'utf8')

  // 卡含 system-section 段（description → character-definition）。
  const imported = importCharacterCard(dir, [{ path: '开放卡.json', content: cardJson }])
  const cardId = imported.ok ? imported.id : ''
  const applied = applyCharacterToPreset(dir, template, cardId)
  assert.equal(applied.ok, true)
  assert.equal(applied.personaOpened, true, '导入 system-section 卡应报告 persona 开放')
  const preset = parseYaml(readFileSync(join(presetDir, 'preset.yml'), 'utf8'))
  const persona = preset.promptConfigs.find((config) => config.id === 'persona-main')
  assert.equal(persona.params.complete, false, 'persona-main complete 置 false（开放 ST system prompt）')
  assert.equal(persona.params.suppressRuntimeContext, true, 'suppressRuntimeContext 不受影响')
  // 幂等：再次导入不再报告开放（complete 已 false）。
  const again = applyCharacterToPreset(dir, template, cardId)
  assert.equal(again.personaOpened, undefined, '重复导入不再开放（已开放）')

  // 反向：persona-main complete: true + 纯世界书卡（无 system-section）→ 不开放。
  const loreOnly = JSON.stringify({
    spec: 'chara_card_v3',
    name: '纯世界书',
    data: {
      name: '纯世界书',
      character_book: { entries: [{ keys: ['剑'], content: '剑术高超。', comment: '剑术', insertion_order: 10 }] },
    },
  })
  const importedLore = importCharacterCard(dir, [{ path: '纯世界书.json', content: loreOnly }])
  const loreId = importedLore.ok ? importedLore.id : ''
  const appliedLore = applyCharacterToPreset(dir, template, loreId)
  assert.equal(appliedLore.personaOpened, undefined, '纯世界书卡（无 system-section）不触碰 persona complete')
  const preset2 = parseYaml(readFileSync(join(presetDir, 'preset.yml'), 'utf8'))
  assert.equal(preset2.promptConfigs.find((config) => config.id === 'persona-main').params.complete, false, '仍保持已开放状态')
})

test('syncImportedCharacterMemory：追加记忆后同步刷新已导入预设的条目', () => {
  const cardId = listCharacterCards(root, template)[0].id
  appendCharacterMemory(root, cardId, '她的剑叫霜雪。')
  const synced = syncImportedCharacterMemory(root, template, cardId)
  assert.equal(synced.ok, true)
  assert.equal(synced.ok && synced.synced, true, '已导入卡应同步')

  const preset = parseYaml(readFileSync(join(presetDir, 'preset.yml'), 'utf8'))
  const memoryEntry = preset.promptConfigs.find((config) => config.id === `chara-${cardId}-memory`)
  assert.ok(memoryEntry, '记忆条目仍在')
  assert.match(memoryEntry.text, /霜雪/, '新记忆已同步进条目')
  assert.match(memoryEntry.text, /喜欢下雨天/, '旧记忆保留')
})

test('syncImportedCharacterMemory：未导入当前预设的卡返回 synced=false 且不动预设', () => {
  const imported = importCharacterCard(root, [{ path: '未导入卡.json', content: JSON.stringify({
    spec: 'chara_card_v3', name: '未导入卡', data: { name: '未导入卡', description: '不入库即不导入。' },
  }) }])
  const cardId = imported.ok ? imported.id : ''
  const before = readFileSync(join(presetDir, 'preset.yml'), 'utf8')
  const synced = syncImportedCharacterMemory(root, template, cardId)
  assert.equal(synced.ok, true)
  assert.equal(synced.ok && synced.synced, false, '未导入卡无需同步')
  assert.equal(readFileSync(join(presetDir, 'preset.yml'), 'utf8'), before, '预设文件不变')
})

test('appendMemoryFile：统一追加格式（时间戳列表），header 区分来源', () => {
  const file = join(root, '.characters', listCharacterCards(root, template)[0].id, 'memory.md')
  appendMemoryFile(file, '第一条', '# 角色记忆')
  appendMemoryFile(file, '第二条', '# 角色记忆')
  const text = readFileSync(file, 'utf8')
  assert.match(text, /^# 角色记忆\n/, 'header 正确')
  assert.match(text, /- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] 第一条/, '时间戳格式')
  assert.match(text, /第二条/, '追加保留')
  assert.ok(existsSync(file), '文件已创建')
})

/** 手工构造带角色卡 tEXt chunk 的 PNG（解码器不校验 CRC，可构造最小合法结构）。 */
function buildPngWithCharaText(payload) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const typeBuf = Buffer.from(type, 'latin1')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(0)
    return Buffer.concat([length, typeBuf, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0) // width
  ihdr.writeUInt32BE(1, 4) // height
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const text = Buffer.concat([Buffer.from('chara\0', 'latin1'), Buffer.from(payload, 'latin1')])
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', text),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test('importCharacterCardFile：合法 PNG 角色卡原子落盘三文件，无残留临时目录', () => {
  const cardRoot = mkdtempSync(join(tmpdir(), 'pt-chara-png-'))
  const cardJson = JSON.stringify({ spec: 'chara_card_v3', name: 'PNG卡', data: { name: 'PNG卡' } })
  const compressed = deflateSync(Buffer.from(cardJson, 'utf8'))
  const png = buildPngWithCharaText(compressed.toString('base64'))
  const file = join(tmpdir(), `pt-chara-${process.pid}-${Date.now()}.png`)
  writeFileSync(file, png)
  try {
    const result = importCharacterCardFile(cardRoot, file, 'card.png')
    assert.equal(result.ok, true)
    const cardDir = join(cardRoot, '.characters', result.id)
    for (const name of ['avatar.png', 'card.json', 'converted.yml']) {
      assert.ok(existsSync(join(cardDir, name)), `${name} 应落盘`)
    }
    const leftovers = readdirSync(join(cardRoot, '.characters'))
      .filter((name) => name.includes('.tmp-') || name.includes('.bak-'))
    assert.deepEqual(leftovers, [], '原子落盘后不应残留 tmp/bak 目录')
  } finally {
    rmSync(cardRoot, { recursive: true, force: true })
    rmSync(file, { force: true })
  }
})

test('importCharacterCardFile：PNG 解压输出超限（zip bomb）干净失败不膨胀内存', () => {
  const cardRoot = mkdtempSync(join(tmpdir(), 'pt-chara-bomb-'))
  // 32MB 零压缩后仅 ~32KB，但解压输出 > 16MB 上限：inflate 必须被 maxOutputLength 拦截。
  const bomb = Buffer.alloc(32 * 1024 * 1024)
  const compressed = deflateSync(bomb)
  const png = buildPngWithCharaText(compressed.toString('base64'))
  const file = join(tmpdir(), `pt-chara-bomb-${process.pid}-${Date.now()}.png`)
  writeFileSync(file, png)
  try {
    const result = importCharacterCardFile(cardRoot, file, 'bomb.png')
    assert.equal(result.ok, false, '解压超限必须失败，不得把膨胀内容当角色卡')
    assert.equal(existsSync(join(cardRoot, '.characters')), false, '失败不得留下半成品卡目录')
  } finally {
    rmSync(cardRoot, { recursive: true, force: true })
    rmSync(file, { force: true })
  }
})


