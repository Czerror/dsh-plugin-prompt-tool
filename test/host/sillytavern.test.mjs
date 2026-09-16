import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离 DSH_HOME：与 host 层其他测试一致（转换引擎虽无 IO，保底隔离）。
const home = mkdtempSync(join(tmpdir(), 'pt-st-home-'))
process.env.DSH_HOME = home
const { buildWorldBookEntry, convertStToPreset, stPresetId } = await import('../../lib/index.mjs')

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

test('convertStToPreset：变量指令保留在卡片，导入期不产生赋值副作用', () => {
  // 真实素材（明月秋青 v5.0 一类）：分卡用 addvar 拼出 {{POV_rules}}/{{anti_rules}}，后续卡片再引用。
  const card = {
    name: '变量族卡',
    data: {
      system_prompt: [
        '{{addvar::POV_rules::- 第一人称}}',
        '{{addvar::POV_rules::，禁止旁白}}',
        '{{setglobalvar::output_language::简体中文}}',
        '{{incvar::counter}}',
        '语言 {{output_language}} 规则 {{POV_rules}} 缺省 {{missing_var::回退值}}',
      ].join('\n'),
    },
  }
  const spec = convertStToPreset(card, 'st-var-family')
  assert.equal(spec.variables.POV_rules, '', '普通引用仅登记默认占位')
  assert.equal(spec.variables.output_language, '', 'global 不在导入期执行')
  assert.equal('counter' in spec.variables, false, 'incvar 留给运行时')
  const system = spec.promptConfigs.find((config) => config.id === 'system-prompt')
  assert.match(system.text, /\{\{addvar/, '保留模板供运行时求值')
  assert.equal(system.params.stMacros, true)
  assert.match(system.text, /\{\{POV_rules\}\}/, '引用保留为变量引用，由引擎解析')
})

test('convertStToPreset：跨行注释剥离、ST 宏归一、字段宏登记为内容变量', () => {
  const card = {
    name: '测试卡',
    data: {
      description: '描写 {{char}} 的场景',
      personality: '性格文本',
      scenario: '场景文本',
      system_prompt: '{{// 注释开头\n{ "thinking": { "type": "disabled" } }\n注释结尾 }}\n正文 {{roll 1d6}} 与 {{random:a,b}} 与 {{description}} 与 {{persona}}',
    },
  }
  const spec = convertStToPreset(card, 'st-macro-card')
  assert.equal(spec.variables.description, '描写 测试卡 的场景', '字段宏登记为内容变量并清洗 {{char}}')
  assert.equal(spec.variables.personality, '性格文本')
  assert.equal(spec.variables.scenario, '场景文本')
  assert.equal(spec.variables.persona, '', '卡内无 persona 字段但正文引用 → 空占位（不留字面）')

  const system = spec.promptConfigs.find((config) => config.id === 'system-prompt')
  assert.ok(system !== undefined, '系统提示卡存在')
  assert.doesNotMatch(system.text, /\{\{\/\//, '跨行注释宏被剥离')
  assert.doesNotMatch(system.text, /thinking/, '注释正文（含 JSON）随注释一并剥离')
  assert.match(system.text, /\{\{roll::1d6\}\}/, '空格形态骰子归一到本项目语法')
  assert.match(system.text, /\{\{random::a,b\}\}/, '单冒号形态 random 归一到本项目语法')
  assert.match(system.text, /\{\{description\}\}/, '字段宏保留为变量引用，由引擎解析')
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
  assert.deepEqual(spec.modules, [
    'prompt-config-engine', 'character-tools', 'world-book-tools',
    'session-var-tools', 'tool-config-engine', 'tool-filter',
  ], 'ST 只装配提示词执行与管理工具模块')
  const lore = spec.promptConfigs.filter((config) => config.strategy === 'world-book')
  assert.equal(lore.length, 2, '两条世界书条目都转换')
  assert.equal(lore[0].params.keys[0], '/^剑\\d+$/')
  assert.equal('useRegex' in lore[0].params, false, '不写幽灵字段 useRegex')
  assert.equal('useRegex' in lore[1].params, false)
})

test('convertStToPreset：空世界书不装工具，tool-filter 仍按需就绪', () => {
  const spec = convertStToPreset({
    name: '空卡',
    data: { character_book: { entries: [{ content: '   ' }] } },
  }, 'empty-card')
  assert.deepEqual(spec.modules, [
    'prompt-config-engine', 'character-tools', 'session-var-tools', 'tool-config-engine', 'tool-filter',
  ])
  assert.equal(spec.moduleConfigs['tool-filter'], undefined, '字段缺省时过滤器为空操作')
})

test('convertStToPreset：世界书最终正文 order 升序（ST 激活后 unshift）', () => {
  const card = {
    name: '排序卡',
    data: {
      character_book: {
        entries: [
          { keys: ['A'], content: 'a', comment: 'a', insertion_order: 10 },
          { keys: ['B'], content: 'b', comment: 'b', insertion_order: 200 },
        ],
      },
    },
  }
  const spec = convertStToPreset(card, 'order-card')
  const lore = spec.promptConfigs
    .filter((config) => config.strategy === 'world-book')
    .sort((x, y) => Number(x.order) - Number(y.order))
  assert.equal(lore.length, 2)
  assert.equal(lore[0].order, 10, '正文低 order 在前，激活优先级另按降序处理')
  assert.equal(lore[1].order, 200)
})

test('convertStToPreset：世界书条目结构 = buildWorldBookEntry 工厂同参数产物（两通道同构）', () => {
  const card = {
    name: '同构卡',
    data: {
      character_book: {
        entries: [
          {
            keys: ['气味'],
            secondary_keys: ['香水'],
            content: '空气中弥漫着…',
            comment: '气味描写',
            insertion_order: 10,
            constant: true,
            case_sensitive: true,
            match_whole_words: true,
          },
        ],
      },
    },
  }
  const spec = convertStToPreset(card, 'iso-card')
  const lore = spec.promptConfigs.filter((config) => config.strategy === 'world-book')
  assert.equal(lore.length, 1)
  const expected = buildWorldBookEntry({
    id: lore[0].id,
    name: lore[0].name,
    text: lore[0].text,
    order: lore[0].order,
    enabled: lore[0].enabled,
    constant: lore[0].params.constant,
    keys: lore[0].params.keys,
    secondaryKeys: lore[0].params.secondaryKeys,
    caseSensitive: lore[0].params.caseSensitive,
    wholeWords: lore[0].params.wholeWords,
  })
  const { stWorldBook, stMacros, ...params } = lore[0].params
  const { role, ...withoutRole } = lore[0]
  assert.deepEqual({ ...withoutRole, params }, expected, '通用结构复用工厂，ST 专属语义在 params 中')
  assert.equal(stMacros, true)
  assert.equal(stWorldBook.scanDepth, 2)
  assert.equal(role, 'user')
})

test('convertStToPreset：marker 条目与 SPresetSettings 设置 dump 整体丢弃', () => {
  const card = {
    name: '标记卡',
    prompts: [
      { identifier: 'main', name: '主提示', marker: true, content: 'MARKER_PLACEHOLDER', role: 'system', enabled: true },
      { identifier: 'SPresetSettings', name: 'SPreset配置', content: '{"RegexBinding":{"regexes":[]}}', enabled: false },
      { identifier: 'e5f4a3b2-1111-2222-3333-444455556666', name: '真实提示', content: '你是助手。', role: 'system', enabled: true },
    ],
  }
  const spec = convertStToPreset(card, 'marker-card')
  const ids = spec.promptConfigs.map((config) => config.id)
  assert.ok(!ids.includes('main'), 'marker: true 条目丢弃（ST 不发送其 content）')
  assert.ok(!ids.includes('SPresetSettings'), 'SPresetSettings 设置 dump 丢弃')
  assert.equal(spec.promptConfigs.length, 1, '仅保留真实提示词条目')
  assert.equal(spec.promptConfigs[0].text, '你是助手。')
  assert.deepEqual([...spec.meta.stDroppedMarkers].sort(), ['SPresetSettings', 'main'], '丢弃计数进 meta 审计')
  // 无丢弃时不写审计键
  const clean = convertStToPreset({ name: '净卡', prompts: [] }, 'clean-card')
  assert.equal(clean.meta.stDroppedMarkers, undefined, '无丢弃不写审计键')
})

test('convertStToPreset：非 marker 的 main 同名条目保留（借名装真实提示词）', () => {
  const card = {
    name: '借名卡',
    prompts: [
      { identifier: 'main', name: '主提示', content: '你是助手。', role: 'system', enabled: true },
    ],
  }
  const spec = convertStToPreset(card, 'borrowed-main')
  const main = spec.promptConfigs.find((config) => config.id === 'main')
  assert.ok(main, '非 marker 的 main 条目保留')
  assert.equal(main.text, '你是助手。')
  assert.equal(main.enabled, true)
})
