import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'

// 隔离 DSH_HOME：writePreset 的模板解析（resolvePresetDir）用户预设优先——
// 真实用户环境 .agent-presets/<id> 会遮蔽包内模板，测试必须隔离。
const home = mkdtempSync(join(tmpdir(), 'pt-wp-home-'))
process.env.DSH_HOME = home
const { writePreset } = await import('../../lib/index.mjs')

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

/** 读取生成目录的 persona-main 提示词配置（文件名前缀随模板默认配置数量变化）。 */
function readPersonaConfig(presetDir, template) {
  const dir = join(presetDir, template, 'prompt-configs')
  const file = readdirSync(dir).find((name) => name.endsWith('-persona-main.yml'))
  assert.ok(file, `${template}: 应生成 persona-main 配置`)
  const parsed = parseYaml(readFileSync(join(dir, file), 'utf8'))
  // renderPromptConfigYaml 把 text 归一为 texts 数组。
  return { ...parsed, text: parsed.text ?? parsed.texts?.[0] ?? '' }
}

test('writePreset 共享引擎 .engine：预设目录不复制 engine，组合引用 ../.engine', () => {
  const dir = join(tmpdir(), `prompt-tool-wp-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    writePreset('PROMPT', makeOptions(presetDir))
    // 预设根共享引擎完整存在（含 vendor；生成期 compositions 不复制）。
    const engineDir = join(presetDir, '.engine')
    assert.ok(existsSync(join(engineDir, 'prompt-config-engine.mjs')), '容器根共享引擎存在')
    assert.ok(existsSync(join(engineDir, 'vendor', 'yaml', 'index.js')), '容器根共享引擎含 vendor')
    assert.equal(existsSync(join(engineDir, 'compositions')), false, '生成期 compositions 不复制')
    assert.equal(existsSync(join(presetDir, 'anchored', 'engine')), false, '子预设不再复制 engine')
    assert.equal(existsSync(join(presetDir, 'agent.cordis.yml')), false, '预设根不再写容器根转发')
    // 组合路径重写：引擎引用 ../.engine（相对预设目录 = 预设根/.engine），
    // configsDir ../anchored/prompt-configs（相对 .engine = 预设目录/prompt-configs，数学可验证）。
    const sub = readFileSync(join(presetDir, 'anchored', 'agent.cordis.yml'), 'utf8')
    assert.match(sub, /name: \.\.\/\.engine\/prompt-config-engine\.mjs/, '预设引擎引用 ../.engine（预设根共享）')
    assert.match(sub, /configsDir: \.\.\/anchored\/prompt-configs/, 'configsDir 相对 .engine 指向预设目录')
    const engineRow = parseYaml(sub).find((row) => row?.id === 'prompt-config-engine')
    const engineFileUrl = pathToFileURL(join(presetDir, '.engine', 'prompt-config-engine.mjs'))
    const resolved = new URL(engineRow.config.configsDir + '/', engineFileUrl)
    assert.ok(existsSync(resolved), `configsDir 解析后应存在: ${resolved.pathname}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 引擎指纹：包内引擎未变时二次写入不重刷共享引擎', () => {
  const dir = join(tmpdir(), `prompt-tool-fp-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    writePreset('PROMPT', makeOptions(presetDir))
    const engineFile = join(presetDir, '.engine', 'prompt-config-engine.mjs')
    const marker = join(presetDir, '.engine', '.pt-engine-fingerprint')
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

test('writePreset 只写预设目录、不写预设根 agent.cordis.yml（无容器根转发）', () => {
  const dir = join(tmpdir(), `prompt-tool-skip-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    writePreset('PROMPT', { ...makeOptions(presetDir), presetTemplate: 'minimal' })
    assert.ok(existsSync(join(presetDir, 'minimal', 'agent.cordis.yml')), '预设目录组合应生成')
    assert.equal(existsSync(join(presetDir, 'agent.cordis.yml')), false, '预设根不写转发组合')
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
    assert.ok(hint.includes('agentsInstructionPath: |-') && hint.includes('../anchored/agents-instruction.md'), hint)
    assert.ok(existsSync(join(presetDir, 'anchored', 'agents-instruction.md')), 'agents-instruction.md 应写入')
    assert.equal(existsSync(join(presetDir, 'anchored', 'agents-instruction.txt')), false, '旧 .txt 残留应清理')
    // 关闭时不注入：instruction-hint 保持无 params.text（引擎回退 agents-instruction.md / 动态探测）。
    const dir2 = join(dir, 'preset2')
    writePreset('PROMPT', { ...makeOptions(dir2), agentsInstructionText: 'AGENTS CONTENT', injectAgentsPrompt: false })
    const hint2 = readFileSync(join(dir2, 'anchored', 'prompt-configs', '30-instruction-hint.yml'), 'utf8')
    assert.ok(!hint2.includes('AGENTS CONTENT'), hint2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 空 prompt/agents 不生成空内容资产，prompt-injector 禁用', () => {
  const dir = join(tmpdir(), `prompt-tool-blank-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    writePreset('', {
      ...makeOptions(presetDir),
      injectPrompt: true,
      agentsInstructionText: '',
    })
    assert.equal(existsSync(join(presetDir, 'anchored', 'preset.md')), false, '空内容不生成 preset.md')
    assert.equal(existsSync(join(presetDir, 'anchored', 'agents.md')), false, '空内容不生成 agents.md')
    assert.equal(existsSync(join(presetDir, 'anchored', 'agents-instruction.md')), false, '空内容不生成 agents-instruction.md')
    const injector = readFileSync(join(presetDir, 'anchored', 'prompt-configs', '20-prompt-injector.yml'), 'utf8')
    const parsed = parseYaml(injector)
    assert.equal(parsed.enabled, false, '空内容时 prompt-injector 应禁用（无内容可注入）')
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
      assert.ok(rows.length >= 8, `${template}: 组合行数异常（${rows.length}）`)
      if (template === 'creative') {
        // creative = 官方 cordis（创造模式）：人设为 promptConfigs 的 persona 模块
        // （system-section + sectionName: deployment:persona），创意文本含 {{model}}/{{cwd}}；
        // 配套 cordis 创作 skills 随预设复制进生成目录。
        const persona = readPersonaConfig(presetDir, 'creative')
        assert.ok(persona.params.sectionName === 'deployment:persona', 'creative 人设段应为 deployment:persona shadow')
        assert.ok(persona.text.includes('{{model}}'), 'creative 人设应保留 {{model}} 变量')
        assert.ok(persona.text.includes('editing-cordis-compositions'), 'creative 人设应引用创作 skill')
        assert.ok(existsSync(join(presetDir, 'creative', 'skills', 'editing-cordis-compositions', 'SKILL.md')), 'editing-cordis-compositions skill 应随预设复制')
        assert.ok(existsSync(join(presetDir, 'creative', 'skills', 'cordis-plugin-development', 'SKILL.md')), 'cordis-plugin-development skill 应随预设复制')
      } else if (template === 'standard' || template === 'ptc') {
        // standard / ptc 人设对齐官方 standard / code 预设原文（{{model}}/{{cwd}}，非独占）。
        const persona = readPersonaConfig(presetDir, template)
        assert.equal(persona.text, 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.', `${template}: 人设应对齐官方原文`)
        assert.equal(persona.params?.complete, undefined, `${template}: 非独占（无 complete）`)
      } else if (template === 'minimal') {
        // minimal 人设对齐官方 minimal 预设原文（RL 句）。
        const persona = readPersonaConfig(presetDir, 'minimal')
        assert.equal(persona.text, 'You are a helpful software engineer assistant.', 'minimal: 人设应对齐官方原文')
        assert.equal(persona.params?.complete, true, 'minimal: 人设独占（complete）')
        assert.equal(persona.params?.suppressRuntimeContext, true, 'minimal: 抑制 runtime context')
      }
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
    // 切回 anchored：overrides 仍在
    writePreset('PROMPT', makeOptions(presetDir))
    const overrides = readFileSync(join(presetDir, 'anchored', 'prompt-tool.overrides.yml'), 'utf8')
    assert.match(overrides, /firstTurnWord: test-word/, '切回 anchored 后 overrides 保留')
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

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})
