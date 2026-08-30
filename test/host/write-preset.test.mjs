import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml, parseDocument } from 'yaml'

// 隔离 DSH_HOME：writePreset 的模板解析（resolvePresetDir）用户预设优先——
// 真实用户环境 .agent-presets/<id> 会遮蔽包内模板，测试必须隔离。
const home = mkdtempSync(join(tmpdir(), 'pt-wp-home-'))
process.env.DSH_HOME = home
const { writePreset, savePresetParams, loadPresetSpec } = await import('../../lib/index.mjs')

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
    assert.doesNotMatch(agent, /__[A-Za-z0-9_]+__/g)
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

test('模型参数改回留空：空串删除 preset.yml 旧键（渲染层空值跳过 = 继承宿主默认）', () => {
  const dir = join(tmpdir(), `prompt-tool-clear-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    cpSync(join(process.cwd(), 'preset', 'anchored'), join(presetDir, 'anchored'), { recursive: true })
    // 1) 先设置 high。
    savePresetParams(presetDir, 'anchored', { modelReasoningEffort: 'high' }, undefined)
    assert.equal(loadPresetSpec(join(presetDir, 'anchored')).params.modelReasoningEffort, 'high', '设置 high 写入预设参数')
    // 2) 改回留空（UI 总是发送空串键）：preset.yml 旧键被删除，渲染不生成 patch。
    savePresetParams(presetDir, 'anchored', { modelReasoningEffort: '' }, undefined)
    assert.equal(loadPresetSpec(join(presetDir, 'anchored')).params.modelReasoningEffort, undefined, '改回留空删除旧键（渲染层无 patch）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('savePresetParams 空值删键：空数组删除，stagePreUnlock=0 是合法档位必须保留', () => {
  const dir = join(tmpdir(), `prompt-tool-empty-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    cpSync(join(process.cwd(), 'preset', 'anchored'), join(presetDir, 'anchored'), { recursive: true })
    // 1) 设置有值：bootstrapTools / messageSources / stagePreUnlock / maxPromoteSteps。
    savePresetParams(presetDir, 'anchored', {
      bootstrapTools: ['bash'],
      messageSources: ['user'],
      stagePreUnlock: 2,
      maxPromoteSteps: 6,
    }, undefined)
    let spec = loadPresetSpec(join(presetDir, 'anchored'))
    assert.deepEqual(spec.params.bootstrapTools, ['bash'], 'bootstrapTools 写入')
    assert.deepEqual(spec.params.messageSources, ['user'], 'messageSources 写入')
    assert.equal(spec.params.stagePreUnlock, 2, 'stagePreUnlock 写入')
    assert.equal(spec.params.maxPromoteSteps, 6, 'maxPromoteSteps 写入')
    // 2) 改回空：空数组删除键；stagePreUnlock=0 是合法档位，不是空值。
    savePresetParams(presetDir, 'anchored', {
      bootstrapTools: [],
      messageSources: [],
      stagePreUnlock: 0,
      maxPromoteSteps: 0,
    }, undefined)
    spec = loadPresetSpec(join(presetDir, 'anchored'))
    assert.equal(spec.params.bootstrapTools, undefined, 'bootstrapTools 空数组删键（引擎 stringList 空数组 fail）')
    assert.equal(spec.params.messageSources, undefined, 'messageSources 空数组删键（空列表 = 全拦注入）')
    assert.equal(spec.params.stagePreUnlock, 0, 'stagePreUnlock 0 保留（与 undefined->1 语义不同）')
    // maxPromoteSteps 0 写入（引擎 createEpochPromotion 0/undefined 都落默认 4，等价）。
    assert.equal(spec.params.maxPromoteSteps, 0, 'maxPromoteSteps 0 照常写入（引擎 0→默认 4）')
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
    assert.ok(guide.includes('complexPattern'))
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
      assert.ok(!/__[A-Za-z0-9_]+__/.test(agent), `${template}: 不应残留未解析 token`)
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

test('writePreset outputId 覆盖：别名目录独立渲染（旧容器 id 兼容物化路径）', () => {
  const dir = join(tmpdir(), `prompt-tool-alias-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    writePreset('ALIAS PROMPT', { ...makeOptions(presetDir), presetTemplate: 'anchored', outputId: 'prompt-tool' })
    assert.ok(existsSync(join(presetDir, 'prompt-tool', 'agent.cordis.yml')), '别名目录组合本体生成')
    assert.ok(existsSync(join(presetDir, 'prompt-tool', 'preset.md')), '别名目录内容资产生成')
    assert.equal(existsSync(join(presetDir, 'anchored', 'preset.md')), false, '模板同名目录不受别名渲染影响')
    const sub = readFileSync(join(presetDir, 'prompt-tool', 'agent.cordis.yml'), 'utf8')
    assert.match(sub, /configsDir: \.\.\/prompt-tool\/prompt-configs/, '组合 configsDir 重写到别名目录')
    assert.match(sub, /name: \.\.\/\.engine\/prompt-config-engine\.mjs/, '引擎引用共享 .engine')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset aliasOf（方案 E）：别名目录带完整参数源 + name 兼容标记 + 随源同步更新', () => {
  const dir = join(tmpdir(), `prompt-tool-alias-e-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    // 源预设目录先建参数源（模拟真实场景：种子化/新建后的 preset.yml）。
    mkdirSync(join(presetDir, 'anchored'), { recursive: true })
    writeFileSync(join(presetDir, 'anchored', 'preset.yml'),
      'id: anchored\nname: Anchored\nmodules: [prompt-config-engine, tool-bash]\nparams:\n  firstTurnAnchor: true\n', 'utf8')
    writePreset('SOURCE PROMPT', { ...makeOptions(presetDir), presetTemplate: 'anchored' })
    // 别名物化（aliasOf: true）：preset.yml 应为源参数完整拷贝 + name 兼容标记。
    writePreset('SOURCE PROMPT', { ...makeOptions(presetDir), presetTemplate: 'anchored', outputId: 'prompt-tool', aliasOf: true })
    assert.ok(existsSync(join(presetDir, 'prompt-tool', 'preset.yml')), '别名目录必须有参数源 preset.yml')
    const spec = parseYaml(readFileSync(join(presetDir, 'prompt-tool', 'preset.yml'), 'utf8'))
    assert.equal(spec.id, 'prompt-tool', '别名 id = outputId')
    assert.match(String(spec.name), /旧会话兼容/, '别名 name 带兼容标记')
    assert.ok(Array.isArray(spec.modules) && spec.modules.length > 0, '参数源完整（modules 复制）')
    // 同步更新：源渲染变化后再写别名，组合内容跟随（不再一次性冻结）。
    writePreset('CHANGED PROMPT', { ...makeOptions(presetDir), presetTemplate: 'anchored', outputId: 'prompt-tool', aliasOf: true })
    const agent = readFileSync(join(presetDir, 'prompt-tool', 'agent.cordis.yml'), 'utf8')
    assert.ok(!agent.includes('SOURCE PROMPT') || agent.includes('CHANGED PROMPT'), '别名组合随源同步')
  } finally {
    rmSync(dir, { recursive: true, force: true })
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
    assert.ok(!/__[A-Za-z0-9_]+__/.test(agent), '不应残留未解析 token')
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
    // 官方 agent-presets id 约束（PRESET_ID /^[a-z0-9][a-z0-9-]*$/）：中文/大写
    // 目录名会被宿主 discovery 静默跳过（会话 resume 报 preset not found），必须 fail loud。
    assert.throws(
      () => writePreset('PROMPT', { ...makeOptions(presetDir), presetTemplate: '夏瑾-天琴座-beta-2-42' }),
      /invalid presetTemplate/,
    )
    assert.throws(
      () => writePreset('PROMPT', { ...makeOptions(presetDir), presetTemplate: 'Anchored' }),
      /invalid presetTemplate/,
    )
    assert.ok(!existsSync(join(dir, 'escape')), '不得写入容器根之外')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 预设级模板变量生成 variables.yml（顶层 variables 段优先 + 旧 params 兼容）；UI 已管理键不落配置', () => {
  const dir = join(tmpdir(), `prompt-tool-uikeys-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    // 先写入预设级模板变量（顶层 variables 段）+ 旧布局 params 内容键（兼容层）。
    // writePreset 的 spec 经 resolvePresetDir 读取（用户预设根优先）：
    // 复制包内完整 anchored 模板到 DSH_HOME 用户根，再写入顶层 variables 与
    // 旧布局 params 内容键（兼容层），模拟真实用户预设。
    const homePresetDir = join(home, '.agent-presets')
    cpSync(join(process.cwd(), 'preset', 'anchored'), join(homePresetDir, 'anchored'), { recursive: true })
    const presetFile = join(homePresetDir, 'anchored', 'preset.yml')
    const doc = parseDocument(readFileSync(presetFile, 'utf8'))
    doc.setIn(['params', 'legacyVar'], '旧值')
    doc.setIn(['params', 'legacyEmpty'], '')
    writeFileSync(presetFile, doc.toString(), 'utf8')
    savePresetParams(homePresetDir, 'anchored', undefined, undefined, { wordsCloud: '1500字', 日期: '' })
    writePreset('PROMPT', {
      ...makeOptions(presetDir),
      firstTurnAnchor: true,
      firstTurnText: 'go',
      modelProvider: 'provider-x',
      modelName: 'model-y',
      guideText: 'guide',
      usePtcMode: true,
      injectPrompt: true,
      bootstrapMaxTokens: 4096,
    })
    const pcDir = join(presetDir, 'anchored', 'prompt-configs')
    const file = readdirSync(pcDir).find((name) => name.endsWith('-persona-main.yml'))
    assert.ok(file, 'persona-main 配置存在')
    const parsed = parseYaml(readFileSync(join(pcDir, file), 'utf8'))
    for (const key of ['firstTurnAnchor', 'firstTurnText', 'modelProvider', 'modelName',
      'guideText', 'usePtcMode', 'injectPrompt', 'bootstrapMaxTokens', 'toolFilterAllow']) {
      assert.equal(parsed.params?.[key], undefined, `配置 params 不得含 UI 管理键 ${key}`)
      assert.equal(parsed.variables?.[key], undefined, `配置 variables 不得含 UI 管理键 ${key}`)
    }
    // 非 UI 键（内容变量）进单一文件 variables.yml（引擎加载时合并，配置文件保持干净）。
    const varsFile = join(pcDir, 'variables.yml')
    assert.ok(existsSync(varsFile), 'variables.yml 生成')
    const vars = parseYaml(readFileSync(varsFile, 'utf8'))
    assert.equal(vars.wordsCloud, '1500字', '顶层 variables 段进 variables.yml')
    assert.equal(vars.legacyVar, '旧值', '旧布局 params 内容键兼容进 variables.yml')
    assert.equal(vars['日期'], '', '空值占位变量（ST 未定义宏登记）进 variables.yml')
    assert.equal(vars.legacyEmpty, '', '旧布局 params 空值内容键也保留')
    assert.equal(vars.promptText, undefined, 'runtime 参数（promptText）不进变量文件')
    assert.equal(parsed.variables?.['wordsCloud'], undefined, '配置文件不再逐条展开内容变量')
    assert.equal(parsed.params?.wordsCloud, undefined, '内容变量不再进 params')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 自定义工具渲染 custom-tools/<n>-<id>.yml（源 = preset.yml 顶层 customTools 段）', () => {
  const dir = join(tmpdir(), `prompt-tool-ctools-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    const homePresetDir = join(home, '.agent-presets')
    cpSync(join(process.cwd(), 'preset', 'anchored'), join(homePresetDir, 'anchored'), { recursive: true })
    const presetFile = join(homePresetDir, 'anchored', 'preset.yml')
    const doc = parseDocument(readFileSync(presetFile, 'utf8'))
    doc.setIn(['customTools'], [
      {
        id: 'greet',
        name: 'my_greet',
        description: '打招呼',
        parameters: { who: { type: 'string', required: true, description: '对象' } },
        output: { schema: { type: 'object', additionalProperties: true } },
        execute: { kind: 'shell', command: 'Write-Output "hi {{args.who}}"' },
      },
      { id: 'bad', name: 'no execute' },
    ])
    writeFileSync(presetFile, doc.toString(), 'utf8')
    writePreset('PROMPT', makeOptions(presetDir))
    const customToolsDir = join(presetDir, 'anchored', 'custom-tools')
    assert.ok(existsSync(customToolsDir), 'custom-tools 目录生成')
    const files = readdirSync(customToolsDir).sort()
    assert.deepEqual(files, ['01-greet.yml', '02-bad.yml'], '结构合法条目逐份落盘（坏条目保留待引擎跳过）')
    const parsed = parseYaml(readFileSync(join(customToolsDir, '01-greet.yml'), 'utf8'))
    assert.equal(parsed.name, 'my_greet')
    assert.equal(parsed.execute.kind, 'shell')
    assert.equal(parsed.parameters.who.required, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('savePresetParams 清理空 key（VariablesEditor 待编辑行不落盘）', () => {
  const dir = join(tmpdir(), `prompt-tool-emptyk-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    mkdirSync(join(presetDir, 'anchored'), { recursive: true })
    writeFileSync(join(presetDir, 'anchored', 'preset.yml'), 'id: anchored\nparams: {}\n', 'utf8')
    savePresetParams(
      presetDir,
      'anchored',
      { '': 'x', wordsCloud: 'v' },
      [{ id: 'a', variables: { '': '', keep: '1' } }],
    )
    const doc = parseYaml(readFileSync(join(presetDir, 'anchored', 'preset.yml'), 'utf8'))
    assert.equal(doc.params?.[''], undefined, 'params 空 key 不写入')
    assert.equal(doc.params?.wordsCloud, 'v', '有效 params 正常写入')
    assert.equal(doc.promptConfigs[0]?.variables?.[''], undefined, '配置 variables 空 key 不写入')
    assert.equal(doc.promptConfigs[0]?.variables?.keep, '1', '有效变量保留')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P1 回归：晋升门控/渐进披露/验证工具参数键不进 variables.yml（PARAM_KEYS 覆盖）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-wp-paramkeys-'))
  try {
    // 复制 anchored 模板，params 加新增参数键（模拟用户手写/UI 保存）。
    const homePresetDir = join(home, '.agent-presets')
    cpSync(join(process.cwd(), 'preset', 'anchored'), join(homePresetDir, 'anchored'), { recursive: true })
    const presetFile = join(homePresetDir, 'anchored', 'preset.yml')
    const doc = parseDocument(readFileSync(presetFile, 'utf8'))
    doc.setIn(['params', 'promoteGate'], true)
    doc.setIn(['params', 'maxPromoteSteps'], 6)
    doc.setIn(['params', 'bootstrapTools'], ['bash', 'read'])
    doc.setIn(['params', 'messageSources'], ['user', 'goal'])
    doc.setIn(['params', 'stagePreUnlock'], 2)
    doc.setIn(['params', 'stages'], [
      { name: '了解', tools: ['read', 'glob', 'grep'] },
      { name: '开发', tools: ['write', 'edit'] },
    ])
    writeFileSync(presetFile, doc.toString(), 'utf8')

    writePreset('PROMPT', makeOptions(dir))

    const pcDir = join(dir, 'anchored', 'prompt-configs')
    const varsFile = join(pcDir, 'variables.yml')
    // 无内容变量（顶层 variables 段为空）时不生成 variables.yml；生成时不得含参数键。
    const vars = existsSync(varsFile) ? parseYaml(readFileSync(varsFile, 'utf8')) : {}
    // 新增参数键必须被 PARAM_KEYS 排除：不得当作内容变量混入 variables.yml。
    for (const key of ['promoteGate', 'maxPromoteSteps', 'bootstrapTools', 'messageSources',
      'stagePreUnlock',
      // 锚定/引导内容键：writePreset 映射进 promptConfig.params，不得双落盘 variables.yml。
      'buildPattern', 'complexPattern', 'firstTurnBuild', 'firstTurnInspect', 'firstTurnDeep',
      'guideComplexPattern', 'guideWeak', 'guideDeep']) {
      assert.equal(vars[key], undefined, `variables.yml 不得含参数键 ${key}`)
    }
    // 配置 params 同样不含。
    const configs = readdirSync(pcDir).filter((name) => name.endsWith('.yml') && name !== 'variables.yml')
    for (const name of configs) {
      const parsed = parseYaml(readFileSync(join(pcDir, name), 'utf8'))
      for (const key of ['promoteGate', 'messageSources', 'stagePreUnlock']) {
        assert.equal(parsed.params?.[key], undefined, `配置 params 不得含 ${key}`)
      }
    }
    // 参数桥落点：生成组合的 tool-bootstrap 行应含 promoteGate 等（params 声明生效）。
    const cordis = readFileSync(join(dir, 'anchored', 'agent.cordis.yml'), 'utf8')
    assert.ok(cordis.includes('promoteGate: true'), '参数桥把 promoteGate 合并进 tool-bootstrap 行')
    assert.ok(cordis.includes('maxPromoteSteps: 6'))
    assert.ok(cordis.includes('messageSources'), 'context-gate 行含 messageSources')
    assert.ok(cordis.includes('stagePreUnlock: 2'), 'tool-bootstrap 行含 stagePreUnlock')
    assert.ok(cordis.includes('name: 了解'), 'tool-bootstrap 行含 stages 阶段名')
    assert.ok(cordis.includes('- read'), 'tool-bootstrap 行含 stages 工具集')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('顶层 model/subagentModel 段：读取展平进 params + 保存写顶层段（旧扁平键迁移）', () => {
  const dir = join(tmpdir(), `prompt-tool-modelseg-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    mkdirSync(join(presetDir, 'mseg'), { recursive: true })
    writeFileSync(join(presetDir, 'mseg', 'preset.yml'), [
      'id: mseg',
      'model:',
      '  provider: deepseek-official',
      '  name: deepseek-v4-pro',
      '  maxTokens: "32000"',
      'subagentModel:',
      '  provider: p2',
      'params:',
      '  firstTurnAnchor: true',
      'promptConfigs: []',
    ].join('\n') + '\n', 'utf8')
    // 读取：顶层段展平进 params 扁平键（消费方统一读 modelProvider 等）。
    const spec = loadPresetSpec(join(presetDir, 'mseg'))
    assert.equal(spec.params?.modelProvider, 'deepseek-official', 'model.provider → modelProvider')
    assert.equal(spec.params?.modelName, 'deepseek-v4-pro')
    assert.equal(spec.params?.modelMaxTokens, '32000')
    assert.equal(spec.params?.subagentModelProvider, 'p2')
    assert.equal(spec.params?.firstTurnAnchor, true, '非模型键保留')
    // 保存：模型键写顶层段 + params 旧扁平键清理（保存即迁移）。
    savePresetParams(presetDir, 'mseg', { modelTemperature: '0.8', firstTurnAnchor: false }, undefined)
    const doc = parseYaml(readFileSync(join(presetDir, 'mseg', 'preset.yml'), 'utf8'))
    assert.equal(doc.model?.temperature, '0.8', '模型键写顶层 model 段')
    assert.equal(doc.params?.modelTemperature, undefined, 'params 旧扁平键清理')
    assert.equal(doc.params?.firstTurnAnchor, false, '非模型键仍写 params')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('模板变量插值开关：停用不生成 variables.yml 且剥离配置中的 {{key}} 引用（内置变量保留）', () => {
  const dir = join(tmpdir(), `prompt-tool-vars-off-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  const homePresetDir = join(home, '.agent-presets')
  const varConfig = () => [{
    id: 'var-test',
    layer: 'pre-step',
    strategy: 'static',
    order: 999,
    texts: ['剧情{{wordsCloud}}字 {{DSH_HOME}}'],
  }]
  try {
    cpSync(join(process.cwd(), 'preset', 'anchored'), join(homePresetDir, 'anchored'), { recursive: true })
    savePresetParams(homePresetDir, 'anchored', undefined, undefined, { wordsCloud: '1500字' }, false)
    const pcDir = join(presetDir, 'anchored', 'prompt-configs')
    writePreset('PROMPT', { ...makeOptions(presetDir), promptConfigs: varConfig() })
    const varsFile = join(pcDir, 'variables.yml')
    assert.equal(existsSync(varsFile), false, '停用时 variables.yml 不生成')
    const file = readdirSync(pcDir).find((name) => name.endsWith('-var-test.yml'))
    assert.ok(file, 'var-test 配置生成')
    const parsed = parseYaml(readFileSync(join(pcDir, file), 'utf8'))
    assert.equal(parsed.texts[0], '剧情字 {{DSH_HOME}}', '预设变量引用剥离、内置变量保留')
    // 重新启用：true = 删除开关键（缺省启用），变量文件恢复。
    savePresetParams(homePresetDir, 'anchored', undefined, undefined, { wordsCloud: '1500字' }, true)
    writePreset('PROMPT', { ...makeOptions(presetDir), promptConfigs: varConfig() })
    assert.ok(existsSync(varsFile), '启用后 variables.yml 恢复生成')
    const vars = parseYaml(readFileSync(varsFile, 'utf8'))
    assert.equal(vars.wordsCloud, '1500字')
    const reParsed = parseYaml(readFileSync(join(pcDir, file), 'utf8'))
    assert.equal(reParsed.texts[0], '剧情{{wordsCloud}}字 {{DSH_HOME}}', '启用后配置文本保留引用（引擎插值）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})
