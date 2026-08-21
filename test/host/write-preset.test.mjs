import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writePreset } from '../../lib/index.mjs'
import { parse as parseYaml } from 'yaml'

const root = fileURLToPath(new URL('../..', import.meta.url))
const sourceEngineDir = join(root, 'engine')

function listFiles(dir) {
  const out = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(full)
    }
  }
  if (existsSync(dir)) walk(dir)
  return out.sort()
}

function makeOptions(presetDir) {
  return {
    firstTurnAnchor: false,
    firstTurnText: '',
    firstTurnCustom: false,
    guideText: '',
    guideCustom: false,
    injectPrompt: true,
    modelProvider: '', subagentModelProvider: '', subagentModelName: '',
    modelName: '',
    bootstrapMaxTokens: 0,
    usePtcMode: true,
    presetDir,
    presetOrder: 5,
    promptConfigs: [],
  }
}

test('writePreset 生成目录 engine/ 与源码 engine/ 逐字节一致', () => {
  const dir = join(tmpdir(), `prompt-tool-wp-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    writePreset('PROMPT', makeOptions(presetDir))
    const generated = listFiles(join(presetDir, 'anchored', 'engine'))
    const source = listFiles(sourceEngineDir)
    const generatedRel = generated.map((file) => file.slice(join(presetDir, 'anchored', 'engine').length + 1)).sort()
    const sourceRel = source.map((file) => file.slice(sourceEngineDir.length + 1)).sort()
    assert.deepEqual(generatedRel, sourceRel)
    for (const rel of generatedRel) {
      const generatedFile = join(presetDir, 'anchored', 'engine', rel)
      const sourceFile = join(sourceEngineDir, rel)
      assert.ok(readFileSync(generatedFile).equals(readFileSync(sourceFile)), `byte mismatch: ${rel}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 输出不包含未解析的 __VARIABLE__ 残留', () => {
  const dir = join(tmpdir(), `prompt-tool-wp-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    writePreset('PROMPT', makeOptions(presetDir))
    const agent = readFileSync(join(presetDir, 'anchored', 'agent.cordis.yml'), 'utf8')
    assert.doesNotMatch(agent, /__[A-Z0-9_]+__/g)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 模型参数（思维程度/温度/输出上限）→ agent-request 配置，audience 区分主/子', () => {
  const dir = join(tmpdir(), `prompt-tool-wp-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    writePreset('PROMPT', {
      ...makeOptions(presetDir),
      modelReasoningEffort: 'high',
      modelTemperature: '1',
      modelMaxTokens: '32000',
      subagentReasoningEffort: 'max',
      subagentTemperature: '',
      subagentMaxTokens: '',
    })
    const configsDir = join(presetDir, 'anchored', 'prompt-configs')
    const files = readdirSync(configsDir).sort()
    const modelParams = files.find((file) => file.includes('model-params'))
    assert.ok(modelParams, `缺 model-params 配置，实际文件: ${files.join(', ')}`)
    const parsed = parseYaml(readFileSync(join(configsDir, modelParams), 'utf8'))
    assert.equal(parsed.audience, 'main')
    assert.deepEqual(parsed.params.patch, { reasoningEffort: 'high', temperature: 1, maxTokens: 32000 })
    const subagentParams = files.find((file) => file.includes('subagent-model-params'))
    assert.ok(subagentParams, `缺 subagent-model-params 配置，实际文件: ${files.join(', ')}`)
    const subagentParsed = parseYaml(readFileSync(join(configsDir, subagentParams), 'utf8'))
    assert.equal(subagentParsed.audience, 'subagent')
    assert.deepEqual(subagentParsed.params.patch, { reasoningEffort: 'max' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 模型参数全部留空 = 不生成 agent-request 配置', () => {
  const dir = join(tmpdir(), `prompt-tool-wp-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    writePreset('PROMPT', makeOptions(presetDir))
    const configsDir = join(presetDir, 'anchored', 'prompt-configs')
    const files = readdirSync(configsDir)
    assert.ok(!files.some((file) => file.includes('model-params')), `不应生成 model-params，实际: ${files.join(', ')}`)
    assert.ok(!files.some((file) => file.includes('subagent-model-params')), `不应生成 subagent-model-params，实际: ${files.join(', ')}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 生成 agent.cordis.yml 注入 allowKinds', () => {
  const dir = join(tmpdir(), `prompt-tool-wp-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    writePreset('PROMPT', makeOptions(presetDir))
    const agent = readFileSync(join(presetDir, 'anchored', 'agent.cordis.yml'), 'utf8')
    const rows = parseYaml(agent)
    const contextGate = rows.find((row) => row?.id === 'context-gate')
    assert.ok(contextGate, 'agent.cordis.yml 应含 context-gate 行')
    assert.deepEqual(contextGate.config.allowKinds, ['skill-invocation', 'near-anchor', 'router-guide'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 将 preset.yml 的锚点/引导参数写入提示词配置', () => {
  const dir = join(tmpdir(), `prompt-tool-wp-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    writePreset('PROMPT', makeOptions(presetDir))
    const near = readFileSync(join(presetDir, 'anchored', 'prompt-configs', '00-near-anchor.yml'), 'utf8')
    const guide = readFileSync(join(presetDir, 'anchored', 'prompt-configs', '10-router-guide.yml'), 'utf8')
    assert.ok(near.includes('buildPattern'))
    assert.ok(near.includes('firstTurnBuild'))
    assert.ok(guide.includes('guideComplexPattern'))
    assert.ok(guide.includes('guideWeak'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 透传 firstTurnWord 覆盖到 prompt-injector 配置', () => {
  const dir = join(tmpdir(), `prompt-tool-ftw-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    writePreset('PROMPT', { ...makeOptions(presetDir), firstTurnWord: '开始' })
    const injector = readFileSync(join(presetDir, 'anchored', 'prompt-configs', '20-prompt-injector.yml'), 'utf8')
    assert.ok(injector.includes('firstTurnWord: |-') && injector.includes('开始'), injector)
    // 未传 firstTurnWord 时回退 preset.yml 模板默认（we），不写空值覆盖。
    const dir2 = join(dir, 'preset2')
    writePreset('PROMPT', makeOptions(dir2))
    const injector2 = readFileSync(join(dir2, 'anchored', 'prompt-configs', '20-prompt-injector.yml'), 'utf8')
    assert.ok(injector2.includes('firstTurnWord: |-') && injector2.includes('we'), injector2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 内容资产单一事实源：settings 覆盖层带 text 也被清空，注入来自 preset.md', () => {
  const dir = join(tmpdir(), `prompt-tool-src-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    writePreset('FILE CONTENT', {
      ...makeOptions(presetDir),
      promptConfigs: [
        { id: 'prompt-injector', name: '用户覆盖', enabled: true, strategy: 'custom-fallback', text: 'SETTINGS TEXT' },
      ],
    })
    const injector = readFileSync(join(presetDir, 'anchored', 'prompt-configs', '20-prompt-injector.yml'), 'utf8')
    assert.ok(injector.includes('text: |-') && injector.includes('FILE CONTENT'), injector)
    assert.ok(!injector.includes('SETTINGS TEXT'), injector)
    assert.ok(!injector.includes('texts:'), injector)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset injectAgentsPrompt 注入 agents 内容到 instruction-hint params.text', () => {
  const dir = join(tmpdir(), `prompt-tool-ai-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    writePreset('PROMPT', { ...makeOptions(presetDir), agentsInstructionText: 'AGENTS CONTENT', injectAgentsPrompt: true })
    const hint = readFileSync(join(presetDir, 'anchored', 'prompt-configs', '30-instruction-hint.yml'), 'utf8')
    assert.ok(hint.includes('AGENTS CONTENT'), hint)
    // 关闭时不注入：instruction-hint 保持无 params.text（引擎回退 agents-instruction.txt / 动态探测）。
    const dir2 = join(dir, 'preset2')
    writePreset('PROMPT', { ...makeOptions(dir2), agentsInstructionText: 'AGENTS CONTENT', injectAgentsPrompt: false })
    const hint2 = readFileSync(join(dir2, 'anchored', 'prompt-configs', '30-instruction-hint.yml'), 'utf8')
    assert.ok(!hint2.includes('AGENTS CONTENT'), hint2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 官方导入预设（standard/minimal/ptc/creative）渲染组合且含 prompt-tool 引擎行', () => {
  for (const template of ['standard', 'minimal', 'ptc', 'creative']) {
    const dir = join(tmpdir(), `prompt-tool-${template}-${process.pid}-${Date.now()}`)
    const presetDir = join(dir, 'preset')
    try {
      writePreset('PROMPT', {
        ...makeOptions(presetDir),
        presetTemplate: template,
        injectPrompt: true,
        firstTurnAnchor: false,
        firstTurnText: '',
        firstTurnCustom: false,
        guideText: '',
        guideCustom: false,
        modelProvider: '', subagentModelProvider: '', subagentModelName: '',
        modelName: '',
        bootstrapMaxTokens: 0,
        usePtcMode: true,
      })
      const agent = readFileSync(join(presetDir, template, 'agent.cordis.yml'), 'utf8')
      const rows = parseYaml(agent)
      assert.ok(rows.some((row) => row?.id === 'prompt-config-engine'), `${template}: 应含 prompt-config-engine 行`)
      assert.ok(!/__[A-Z0-9_]+__/.test(agent), `${template}: 不应残留未解析 token`)
      assert.ok(rows.length >= 10, `${template}: 组合行数异常（${rows.length}）`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('writePreset 生成内容资产文件 preset.md / agents.md', () => {
  const dir = join(tmpdir(), `prompt-tool-md-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    writePreset('PRESET CONTENT', { ...makeOptions(presetDir), agentsInstructionText: 'AGENTS CONTENT' })
    assert.equal(readFileSync(join(presetDir, 'anchored', 'preset.md'), 'utf8'), 'PRESET CONTENT')
    assert.equal(readFileSync(join(presetDir, 'anchored', 'agents.md'), 'utf8'), 'AGENTS CONTENT')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 失败时保留旧生成目录', () => {
  const dir = join(tmpdir(), `prompt-tool-wp-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  mkdirSync(join(presetDir, 'anchored'), { recursive: true })
  writeFileSync(join(presetDir, 'anchored', 'keep.txt'), 'old', 'utf8')
  try {
    assert.throws(() => writePreset('PROMPT', { ...makeOptions(presetDir), presetTemplate: 'missing-template' }))
    assert.equal(readFileSync(join(presetDir, 'anchored', 'keep.txt'), 'utf8'), 'old')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 容器根薄转发：agent.cordis.yml 指向激活子预设，子预设内相对路径不变', () => {
  const dir = join(tmpdir(), `prompt-tool-fwd-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    writePreset('PROMPT', makeOptions(presetDir))
    const forwarded = readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8')
    const rows = parseYaml(forwarded)
    const engine = rows.find((row) => row?.id === 'prompt-config-engine')
    assert.ok(engine, '容器根转发应含 prompt-config-engine 行')
    assert.equal(engine.name, './anchored/engine/prompt-config-engine.mjs', '转发 name 应指向子预设引擎')
    const subagent = readFileSync(join(presetDir, 'anchored', 'agent.cordis.yml'), 'utf8')
    const subRows = parseYaml(subagent)
    const subEngine = subRows.find((row) => row?.id === 'prompt-config-engine')
    assert.equal(subEngine.name, './engine/prompt-config-engine.mjs', '子预设组合保持原始相对路径')
    assert.equal(subEngine.config.configsDir, '../prompt-configs', 'configsDir 相对子预设引擎文件解析')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 预设隔离：多模板并存，overrides 随子预设互不串台', () => {
  const dir = join(tmpdir(), `prompt-tool-iso-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    // anchored 生成 + 写入 overrides
    writePreset('PROMPT', makeOptions(presetDir))
    mkdirSync(join(presetDir, 'anchored'), { recursive: true })
    writeFileSync(join(presetDir, 'anchored', 'prompt-tool.overrides.yml'), 'firstTurnWord: test-word\n', 'utf8')
    // 切换 minimal 重新生成
    writePreset('PROMPT', { ...makeOptions(presetDir), presetTemplate: 'minimal' })
    assert.ok(existsSync(join(presetDir, 'anchored', 'agent.cordis.yml')), 'anchored 子预设保留')
    assert.ok(existsSync(join(presetDir, 'minimal', 'agent.cordis.yml')), 'minimal 子预设生成')
    assert.ok(existsSync(join(presetDir, 'anchored', 'prompt-tool.overrides.yml')), 'anchored overrides 保留')
    assert.ok(!existsSync(join(presetDir, 'minimal', 'prompt-tool.overrides.yml')), 'minimal 无 anchored 的 overrides（隔离）')
    // 转发跟随最新激活预设
    const forwarded = readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8')
    assert.match(forwarded, /\.\/minimal\/engine\//, '转发应指向 minimal')
    // 切回 anchored：overrides 仍在
    writePreset('PROMPT', makeOptions(presetDir))
    const overrides = readFileSync(join(presetDir, 'anchored', 'prompt-tool.overrides.yml'), 'utf8')
    assert.match(overrides, /firstTurnWord: test-word/, '切回 anchored 后 overrides 保留')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 旧单目录结构迁移：根残留清理 + overrides 归位子预设', () => {
  const dir = join(tmpdir(), `prompt-tool-mig-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    // 构造旧单目录结构：根有 engine/ + agent.cordis.yml + overrides
    mkdirSync(join(presetDir, 'engine'), { recursive: true })
    writeFileSync(join(presetDir, 'engine', 'stale.mjs'), 'stale', 'utf8')
    writeFileSync(join(presetDir, 'agent.cordis.yml'), 'stale', 'utf8')
    writeFileSync(join(presetDir, 'prompt-tool.overrides.yml'), 'firstTurnWord: legacy\n', 'utf8')
    writePreset('PROMPT', makeOptions(presetDir))
    assert.ok(!existsSync(join(presetDir, 'engine')), '容器根残留 engine/ 已清理')
    assert.ok(!existsSync(join(presetDir, 'prompt-tool.overrides.yml')), '容器根旧 overrides 已清理')
    assert.equal(
      readFileSync(join(presetDir, 'anchored', 'prompt-tool.overrides.yml'), 'utf8'),
      'firstTurnWord: legacy\n',
      '旧 overrides 迁移进 anchored 子预设',
    )
    const forwarded = readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8')
    assert.notEqual(forwarded, 'stale', '容器根 agent.cordis.yml 已被转发覆盖')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 拒绝非法 presetTemplate（路径穿越防护）', () => {
  const dir = join(tmpdir(), `prompt-tool-sec-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    assert.throws(
      () => writePreset('PROMPT', { ...makeOptions(presetDir), presetTemplate: '../escape' }),
      /invalid presetTemplate/,
    )
    assert.throws(
      () => writePreset('PROMPT', { ...makeOptions(presetDir), presetTemplate: 'a/b' }),
      /invalid presetTemplate/,
    )
    assert.ok(!existsSync(join(dir, 'escape')), '不得写入容器根之外')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
