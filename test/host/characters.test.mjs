import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

// 隔离 DSH_HOME：角色卡库操作全部走显式 presetRoot 参数。
const home = mkdtempSync(join(tmpdir(), 'pt-chara-home-'))
process.env.DSH_HOME = home
const {
  appendCharacterMemory,
  appendMemoryFile,
  applyCharacterToPreset,
  CHARACTER_MODULES_KEY,
  characterModuleStillNeeded,
  declaredCharacterModules,
  importCharacterCard,
  importCharacterCardFile,
  listCharacterCards,
  recordedCharacterModules,
  removeCharacterFromPreset,
  requiredCharacterModules,
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
  'modules: [prompt-config-engine]',
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
  assert.deepEqual(preset.modules, [
    'prompt-config-engine', 'character-tools', 'world-book-tools',
    'session-var-tools', 'tool-config-engine', 'tool-filter',
  ], 'ST 卡按自身 modules 声明装配（声明优先），行为与改造前一致')
  // 模块来源记录：预设原本只有 prompt-config-engine，其余五个是这张卡引入的（移除时据此回退）。
  assert.deepEqual(preset.meta.characterModules[cardId], [
    'character-tools', 'world-book-tools', 'session-var-tools', 'tool-config-engine', 'tool-filter',
  ], 'apply 记录由该卡引入的模块')

  const listed = listCharacterCards(root, template)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].imported, true)
})

test('applyCharacterToPreset：导入含 system-section 的卡自动开放顶层 persona complete（ST system prompt 层级开放）', () => {
  // 预建含顶层 persona complete: true 的激活预设。
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
    'modules: [prompt-config-engine]',
    'persona:',
    '  prefix: 默认人设',
    '  complete: true',
    '  includeRuntimeContext: false',
    '',
  ].join('\n'), 'utf8')

  // 卡含 system-section 段（description → character-definition）。
  const imported = importCharacterCard(dir, [{ path: '开放卡.json', content: cardJson }])
  const cardId = imported.ok ? imported.id : ''
  const applied = applyCharacterToPreset(dir, template, cardId)
  assert.equal(applied.ok, true)
  assert.equal(applied.personaOpened, true, '导入 system-section 卡应报告 persona 开放')
  const preset = parseYaml(readFileSync(join(presetDir, 'preset.yml'), 'utf8'))
  assert.equal(preset.persona.complete, false, '顶层 persona complete 置 false（开放 ST system prompt）')
  assert.equal(preset.persona.includeRuntimeContext, false, 'includeRuntimeContext 不受影响')
  // 幂等：再次导入不再报告开放（complete 已 false）。
  const again = applyCharacterToPreset(dir, template, cardId)
  assert.equal(again.personaOpened, undefined, '重复导入不再开放（已开放）')

  // 反向：顶层 persona complete: true + 纯世界书卡（无 system-section）→ 不开放。
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
  assert.equal(preset2.persona.complete, false, '仍保持已开放状态')
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

// ── 模块按需装配与回退（手写「类角色卡」：只放 converted.yml，与 ponytail 卡同一路径）──────────

/** 手写卡：不经 ST 转换，直接写 converted.yml（PresetSpec 片段）。 */
function writeManualCard(root, id, spec) {
  const dir = join(root, '.characters', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'converted.yml'), stringifyYaml(spec, { lineWidth: 0 }), 'utf8')
}

/** 独立预设根：modules 与 params 由用例指定，用于观察按需追加与回退。 */
function makeRoot({ modules = ['prompt-config-engine'], params } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pt-chara-mod-'))
  const template = 'anchored'
  const presetDir = join(dir, template)
  mkdirSync(presetDir, { recursive: true })
  const lines = [
    'id: anchored',
    'name: 测试预设',
    'version: 1.0.0',
    'engineCompat: ">=0.4.2"',
    `modules: [${modules.join(', ')}]`,
  ]
  if (params !== undefined) {
    lines.push('params:')
    for (const [key, value] of Object.entries(params)) lines.push(`  ${key}: ${value}`)
  }
  lines.push('promptConfigs: []', '')
  writeFileSync(join(presetDir, 'preset.yml'), lines.join('\n'), 'utf8')
  return {
    dir,
    template,
    read: () => parseYaml(readFileSync(join(presetDir, 'preset.yml'), 'utf8')),
  }
}

const manual = (id, extra = {}) => ({
  id,
  name: `${id} 卡`,
  version: '1.0.0',
  engineCompat: '>=0.4.2',
  ...extra,
})
const staticConfig = (id, text) => ({ id, strategy: 'static', layer: 'system-section', order: 200, text })

test('手写卡未声明 modules：只补必需项 prompt-config-engine，并记录来源', () => {
  const root = makeRoot({ modules: ['tool-fs'] })
  try {
    writeManualCard(root.dir, 'ponytail', manual('ponytail', {
      promptConfigs: [staticConfig('ponytail-full', '规则正文')],
    }))
    const applied = applyCharacterToPreset(root.dir, root.template, 'ponytail')
    assert.equal(applied.ok, true)
    const preset = root.read()
    assert.deepEqual(preset.modules, ['tool-fs', 'prompt-config-engine'],
      '纯文本卡只补必需引擎，不引入用不到的工具模块')
    assert.deepEqual(preset.meta.characterModules.ponytail, ['prompt-config-engine'])
  } finally {
    rmSync(root.dir, { recursive: true, force: true })
  }
})

test('手写卡声明 modules：按声明追加，必需项去重', () => {
  const root = makeRoot({ modules: ['prompt-config-engine'] })
  try {
    writeManualCard(root.dir, 'ponytail', manual('ponytail', {
      modules: ['session-var-tools'],
      promptConfigs: [staticConfig('ponytail-full', '规则正文')],
    }))
    applyCharacterToPreset(root.dir, root.template, 'ponytail')
    const preset = root.read()
    assert.deepEqual(preset.modules, ['prompt-config-engine', 'session-var-tools'],
      '声明优先，已存在的必需项不重复追加')
    assert.deepEqual(preset.meta.characterModules.ponytail, ['session-var-tools'])
  } finally {
    rmSync(root.dir, { recursive: true, force: true })
  }
})

test('手写卡带 world-book 策略配置：自动补 world-book-tools', () => {
  const root = makeRoot({ modules: ['prompt-config-engine'] })
  try {
    writeManualCard(root.dir, 'lorecard', manual('lorecard', {
      promptConfigs: [{ id: 'lore', strategy: 'world-book', layer: 'pre-step', order: 1, text: '关键词条目' }],
    }))
    applyCharacterToPreset(root.dir, root.template, 'lorecard')
    const preset = root.read()
    assert.deepEqual(preset.modules, ['prompt-config-engine', 'world-book-tools'])
    assert.deepEqual(preset.meta.characterModules.lorecard, ['world-book-tools'])
  } finally {
    rmSync(root.dir, { recursive: true, force: true })
  }
})

test('移除：回退由本卡引入的模块，并清记录与导入标记', () => {
  const root = makeRoot({ modules: ['tool-fs'] })
  try {
    writeManualCard(root.dir, 'ponytail', manual('ponytail', {
      modules: ['session-var-tools', 'tool-filter'],
      promptConfigs: [staticConfig('ponytail-full', '规则正文')],
    }))
    applyCharacterToPreset(root.dir, root.template, 'ponytail')
    assert.deepEqual(root.read().modules,
      ['tool-fs', 'session-var-tools', 'tool-filter', 'prompt-config-engine'])

    const removed = removeCharacterFromPreset(root.dir, root.template, 'ponytail')
    assert.equal(removed.ok, true)
    assert.equal(removed.count, 1)
    const preset = root.read()
    assert.deepEqual(preset.modules, ['tool-fs'], '三个由卡引入的模块全部回退')
    assert.equal(preset.meta.characterModules, undefined, '记录随卡清理，不留空对象')
    assert.deepEqual(preset.meta.importedCharacters, [])
    assert.deepEqual(preset.promptConfigs, [])
  } finally {
    rmSync(root.dir, { recursive: true, force: true })
  }
})

test('移除：另一张已导入卡也声明同一模块时不夺走', () => {
  const root = makeRoot({ modules: ['prompt-config-engine'] })
  try {
    for (const id of ['card-a', 'card-b']) {
      writeManualCard(root.dir, id, manual(id, {
        modules: ['session-var-tools'],
        promptConfigs: [staticConfig(`${id}-cfg`, `${id} 正文`)],
      }))
      applyCharacterToPreset(root.dir, root.template, id)
    }
    // 第二张卡的模块已在磁盘上，差集为空 → 不进记录，但它的 converted.yml 仍声明该模块。
    assert.deepEqual(root.read().meta.characterModules, { 'card-a': ['session-var-tools'] })

    removeCharacterFromPreset(root.dir, root.template, 'card-a')
    assert.ok(root.read().modules.includes('session-var-tools'), '另一张卡仍声明该模块 → 保留')

    // 第二张卡没有引入记录（模块不是它加的）→ 不回退，宁可留模块也不误删。
    removeCharacterFromPreset(root.dir, root.template, 'card-b')
    assert.ok(root.read().modules.includes('session-var-tools'), '无引入记录的卡不回退模块')
  } finally {
    rmSync(root.dir, { recursive: true, force: true })
  }
})

test('移除：预设自带模块与无记录的老卡都不回退', () => {
  const root = makeRoot({ modules: ['prompt-config-engine', 'character-tools'] })
  try {
    writeManualCard(root.dir, 'legacy', manual('legacy', {
      modules: ['character-tools'],
      promptConfigs: [staticConfig('legacy-cfg', '老卡正文')],
    }))
    applyCharacterToPreset(root.dir, root.template, 'legacy')
    assert.equal(root.read().meta.characterModules, undefined, '差集为空 → 不产生引入记录')
    removeCharacterFromPreset(root.dir, root.template, 'legacy')
    assert.deepEqual(root.read().modules, ['prompt-config-engine', 'character-tools'],
      '预设自带模块永不被回退')
  } finally {
    rmSync(root.dir, { recursive: true, force: true })
  }
})

test('移除：params 里仍有工具名单时保留 tool-filter', () => {
  const root = makeRoot({ modules: ['prompt-config-engine'], params: { toolFilterDeny: 'web_search' } })
  try {
    writeManualCard(root.dir, 'filtercard', manual('filtercard', {
      modules: ['tool-filter'],
      promptConfigs: [staticConfig('filtercard-cfg', '名单卡正文')],
    }))
    applyCharacterToPreset(root.dir, root.template, 'filtercard')
    assert.ok(root.read().modules.includes('tool-filter'))
    removeCharacterFromPreset(root.dir, root.template, 'filtercard')
    assert.ok(root.read().modules.includes('tool-filter'), '预设自己设的名单仍需该模块 → 保留')
  } finally {
    rmSync(root.dir, { recursive: true, force: true })
  }
})

test('重复 apply 与重复 remove 都幂等', () => {
  const root = makeRoot({ modules: ['tool-fs'] })
  try {
    writeManualCard(root.dir, 'ponytail', manual('ponytail', {
      promptConfigs: [staticConfig('ponytail-full', '规则正文')],
    }))
    applyCharacterToPreset(root.dir, root.template, 'ponytail')
    applyCharacterToPreset(root.dir, root.template, 'ponytail')
    const afterApply = root.read()
    assert.deepEqual(afterApply.modules, ['tool-fs', 'prompt-config-engine'], '模块不重复追加')
    assert.deepEqual(afterApply.meta.characterModules.ponytail, ['prompt-config-engine'], '记录不重复')
    assert.equal(afterApply.promptConfigs.length, 1, '配置不重复并入')

    assert.equal(removeCharacterFromPreset(root.dir, root.template, 'ponytail').count, 1)
    const afterRemove = readFileSync(join(root.dir, root.template, 'preset.yml'), 'utf8')
    const second = removeCharacterFromPreset(root.dir, root.template, 'ponytail')
    assert.equal(second.ok, true)
    assert.equal(second.count, 0, '再次移除没有可删配置')
    assert.equal(readFileSync(join(root.dir, root.template, 'preset.yml'), 'utf8'), afterRemove,
      '第二次移除不改动预设文件')
  } finally {
    rmSync(root.dir, { recursive: true, force: true })
  }
})

test('判据纯函数：记录容错、未知模块保守保留、消费者判据', () => {
  assert.deepEqual(recordedCharacterModules(undefined), {})
  assert.deepEqual(recordedCharacterModules({ [CHARACTER_MODULES_KEY]: 'x' }), {})
  assert.deepEqual(recordedCharacterModules({ [CHARACTER_MODULES_KEY]: { a: ['m1', 2, '', 'm1'], b: [] } }),
    { a: ['m1'] }, '非法项丢弃、重复去重、空记录不返回')
  assert.deepEqual(declaredCharacterModules({ id: 'x', name: 'x', modules: ['a', '', 3, 'a'] }), ['a'])
  assert.deepEqual(requiredCharacterModules([{ strategy: 'world-book' }]),
    ['prompt-config-engine', 'world-book-tools'])
  assert.deepEqual(requiredCharacterModules([{ strategy: 'static' }]), ['prompt-config-engine'])

  const empty = { configs: [], params: {}, customTools: false, importedCharacters: [] }
  assert.equal(characterModuleStillNeeded('prompt-config-engine', empty), false)
  assert.equal(characterModuleStillNeeded('prompt-config-engine', { ...empty, configs: [{ id: 'x' }] }), true)
  assert.equal(characterModuleStillNeeded('tool-filter', { ...empty, params: { toolFilterAllow: [] } }), false)
  assert.equal(characterModuleStillNeeded('tool-filter', { ...empty, params: { toolFilterAllow: ['read'] } }), true)
  assert.equal(characterModuleStillNeeded('tool-filter', { ...empty, params: { toolFilterDeny: '  ' } }), false)
  assert.equal(characterModuleStillNeeded('session-var-tools',
    { ...empty, configs: [{ id: 'x', params: { stMacros: true } }] }), true)
  assert.equal(characterModuleStillNeeded('tool-config-engine', { ...empty, customTools: true }), true)
  assert.equal(characterModuleStillNeeded('unknown-module', empty), true, '未知模块保守保留')
})


