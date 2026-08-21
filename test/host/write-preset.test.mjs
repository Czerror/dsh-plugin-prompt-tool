import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

test('writePreset 容器根共享引擎：子预设不复制 engine，组合引用 ../engine', () => {
  const dir = join(tmpdir(), `prompt-tool-wp-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    writePreset('PROMPT', makeOptions(presetDir))
    // 容器根共享引擎完整存在（含组合库与 vendor）。
    const engineDir = join(presetDir, 'engine')
    assert.ok(existsSync(join(engineDir, 'prompt-config-engine.mjs')), '容器根共享引擎存在')
    assert.ok(existsSync(join(engineDir, 'vendor', 'yaml', 'index.js')), '容器根共享引擎含 vendor')
    assert.equal(existsSync(join(presetDir, 'anchored', 'engine')), false, '子预设不再复制 engine')
    // 子预设组合路径重写：引擎引用 ../engine（相对子预设 = 容器根），configsDir 相对容器根引擎。
    const sub = readFileSync(join(presetDir, 'anchored', 'agent.cordis.yml'), 'utf8')
    assert.match(sub, /name: \.\.\/engine\/prompt-config-engine\.mjs/, '子预设引擎引用 ../engine（容器根共享）')
    assert.match(sub, /configsDir: \.\/anchored\/prompt-configs/, 'configsDir 相对容器根引擎指向子预设')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 引擎指纹：包内引擎未变时二次写入不重刷共享引擎', () => {
  const dir = join(tmpdir(), `prompt-tool-fp-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    writePreset('PROMPT', makeOptions(presetDir))
    const engineFile = join(presetDir, 'engine', 'prompt-config-engine.mjs')
    const marker = join(presetDir, 'engine', '.pt-engine-fingerprint')
    assert.ok(existsSync(marker), '指纹标记应写入')
    assert.ok(readFileSync(marker, 'utf8').length > 10, '指纹内容非空')
    const mtime1 = statSync(engineFile).mtimeMs
    writePreset('PROMPT', makeOptions(presetDir))
    const mtime2 = statSync(engineFile).mtimeMs
    assert.equal(mtime2, mtime1, '引擎未变不应重刷（mtime 保持不变）')
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

test('writePreset skipForward 只生成子预设、不写容器根薄转发', () => {
  const dir = join(tmpdir(), `prompt-tool-skip-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    writePreset('PROMPT', { ...makeOptions(presetDir), presetTemplate: 'minimal', skipForward: true })
    assert.ok(existsSync(join(presetDir, 'minimal', 'preset.yml')), '子预设应生成')
    assert.equal(existsSync(join(presetDir, 'agent.cordis.yml')), false, 'skipForward 不应写容器根')
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

test('writePreset 自定义预设（custom，所有参数为空）渲染安全', () => {
  const dir = join(tmpdir(), `prompt-tool-custom-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    writePreset('', {
      ...makeOptions(presetDir),
      presetTemplate: 'custom',
      injectPrompt: false,
      firstTurnAnchor: false,
      bootstrapMaxTokens: 0,
      usePtcMode: true,
    })
    const agent = readFileSync(join(presetDir, 'custom', 'agent.cordis.yml'), 'utf8')
    const rows = parseYaml(agent)
    assert.ok(Array.isArray(rows) && rows.length >= 5, `自定义预设组合应含引擎骨架（${rows.length}）`)
    assert.ok(!/__[A-Z0-9_]+__/.test(agent), '不应残留未解析 token')
    const promptConfigs = readdirSync(join(presetDir, 'custom', 'prompt-configs'))
    assert.equal(promptConfigs.length, 0, '自定义预设 promptConfigs 应为空')
    assert.equal(existsSync(join(presetDir, 'custom', 'engine')), false, '子预设不复制 engine（共享于容器根）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
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

test('writePreset 容器根薄转发：agent.cordis.yml 指向容器根共享引擎与激活子预设配置', () => {
  const dir = join(tmpdir(), `prompt-tool-fwd-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    writePreset('PROMPT', makeOptions(presetDir))
    const forwarded = readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8')
    const rows = parseYaml(forwarded)
    const engine = rows.find((row) => row?.id === 'prompt-config-engine')
    assert.ok(engine, '容器根转发应含 prompt-config-engine 行')
    assert.equal(engine.name, './engine/prompt-config-engine.mjs', '转发 name 指向容器根共享引擎')
    assert.equal(engine.config.configsDir, './anchored/prompt-configs', '转发 configsDir 指向激活子预设配置')
    const subagent = readFileSync(join(presetDir, 'anchored', 'agent.cordis.yml'), 'utf8')
    const subRows = parseYaml(subagent)
    const subEngine = subRows.find((row) => row?.id === 'prompt-config-engine')
    assert.equal(subEngine.name, '../engine/prompt-config-engine.mjs', '子预设引擎引用 ../engine（容器根共享）')
    assert.equal(subEngine.config.configsDir, './anchored/prompt-configs', 'configsDir 相对容器根引擎指向子预设')
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
    assert.match(forwarded, /\.\/engine\//, '转发指向容器根共享引擎')
    assert.match(forwarded, /configsDir: \.\/minimal\/prompt-configs/, '转发 configsDir 跟随激活预设 minimal')
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
    assert.equal(existsSync(join(presetDir, 'engine', 'stale.mjs')), false, '容器根旧单目录 engine 残留已重刷为共享引擎')
    assert.ok(existsSync(join(presetDir, 'engine', 'prompt-config-engine.mjs')), '容器根现为共享引擎')
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
