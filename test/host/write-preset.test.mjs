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
    modelProvider: '',
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
    const generated = listFiles(join(presetDir, 'engine'))
    const source = listFiles(sourceEngineDir)
    const generatedRel = generated.map((file) => file.slice(join(presetDir, 'engine').length + 1)).sort()
    const sourceRel = source.map((file) => file.slice(sourceEngineDir.length + 1)).sort()
    assert.deepEqual(generatedRel, sourceRel)
    for (const rel of generatedRel) {
      const generatedFile = join(presetDir, 'engine', rel)
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
    const agent = readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8')
    assert.doesNotMatch(agent, /__[A-Z0-9_]+__/g)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 生成 agent.cordis.yml 注入 allowKinds', () => {
  const dir = join(tmpdir(), `prompt-tool-wp-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    writePreset('PROMPT', makeOptions(presetDir))
    const agent = readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8')
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
    const near = readFileSync(join(presetDir, 'prompt-configs', '00-near-anchor.yml'), 'utf8')
    const guide = readFileSync(join(presetDir, 'prompt-configs', '10-router-guide.yml'), 'utf8')
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
    const injector = readFileSync(join(presetDir, 'prompt-configs', '20-prompt-injector.yml'), 'utf8')
    assert.ok(injector.includes('firstTurnWord: |-') && injector.includes('开始'), injector)
    // 未传 firstTurnWord 时回退 preset.yml 模板默认（we），不写空值覆盖。
    const dir2 = join(dir, 'preset2')
    writePreset('PROMPT', makeOptions(dir2))
    const injector2 = readFileSync(join(dir2, 'prompt-configs', '20-prompt-injector.yml'), 'utf8')
    assert.ok(injector2.includes('firstTurnWord: |-') && injector2.includes('we'), injector2)
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
        modelProvider: '',
        modelName: '',
        bootstrapMaxTokens: 0,
        usePtcMode: true,
      })
      const agent = readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8')
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
    assert.equal(readFileSync(join(presetDir, 'preset.md'), 'utf8'), 'PRESET CONTENT')
    assert.equal(readFileSync(join(presetDir, 'agents.md'), 'utf8'), 'AGENTS CONTENT')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 失败时保留旧生成目录', () => {
  const dir = join(tmpdir(), `prompt-tool-wp-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  mkdirSync(presetDir, { recursive: true })
  writeFileSync(join(presetDir, 'keep.txt'), 'old', 'utf8')
  try {
    assert.throws(() => writePreset('PROMPT', { ...makeOptions(presetDir), presetTemplate: 'missing-template' }))
    assert.equal(readFileSync(join(presetDir, 'keep.txt'), 'utf8'), 'old')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
