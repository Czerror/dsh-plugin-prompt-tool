import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml, parseDocument } from 'yaml'

// 隔离 DSH_HOME：writePreset 的模板解析（resolvePresetDir）用户预设优先——
// 真实用户环境 .agent-presets/<id> 会遮蔽包内模板，测试必须隔离。
const home = mkdtempSync(join(tmpdir(), 'pt-wp-home-'))
process.env.DSH_HOME = home
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const { FIXTURE_PRESET_ID, FIXTURE_PRESET_SRC, installFixturePreset, installFixturePresetInHome } = await import('../fixtures/preset-template.mjs')
const { writePreset, savePresetParams, loadPresetSpec } = await import('../../lib/index.mjs')
// 夹具模板同时装进隔离 DSH_HOME 的官方预设根（resolvePresetDir 场景）与各测试的输出根（见 makeOptions）。
installFixturePresetInHome(home)
/** 指令文件正文 sentinel：任何预设产物都不得包含它（正文只属于用户文件）。 */
const AGENTS_BODY_SENTINEL = 'AGENTS CONTENT SENTINEL 7f3a'
test.after(() => rmSync(home, { recursive: true, force: true }))

test('writePreset 从指定预设根读取同名参数，不被默认根遮蔽', () => {
  const id = 'root-isolation'
  const customRoot = mkdtempSync(join(home, 'custom-root-'))
  for (const [root, usePtcMode] of [[join(home, '.agent-presets'), true], [customRoot, false]]) {
    mkdirSync(join(root, id), { recursive: true })
    writeFileSync(join(root, id, 'preset.yml'),
      `id: ${id}\nmodules: [promoted-code-mode]\nparams:\n  usePtcMode: ${usePtcMode}\n`, 'utf8')
  }
  const defaultFile = join(home, '.agent-presets', id, 'preset.yml')
  const before = readFileSync(defaultFile, 'utf8')
  writePreset('', { ...makeOptions(customRoot), presetTemplate: id, usePtcMode: undefined })
  const row = parseYaml(readFileSync(join(customRoot, id, 'agent.cordis.yml'), 'utf8'))[0]
  assert.equal(row.config.usePtcMode, false)
  assert.equal(readFileSync(defaultFile, 'utf8'), before)
})

function makeOptions(presetDir) {
  // writePreset 的模板解析根 = options.presetDir（其次包内 preset/）：夹具缺失时安装；
  // 测试已自行复制并改写过 preset.yml 时不覆盖。
  if (!existsSync(join(presetDir, FIXTURE_PRESET_ID, 'preset.yml'))) installFixturePreset(presetDir)
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
    presetTemplate: FIXTURE_PRESET_ID,
    presetOrder: 5,
    promptConfigs: [],
  }
}

/** 读取生成组合里的官方 persona 行（preset.yml 顶层 persona 段的渲染产物）。 */
function readPersonaRow(presetDir, template) {
  const agent = readFileSync(join(presetDir, template, 'agent.cordis.yml'), 'utf8')
  const row = parseYaml(agent).find((item) => item?.id === 'persona')
  assert.ok(row, `${template}: 应生成 persona 行`)
  assert.equal(row.name, '@deepseek-ai/dsh-persona', `${template}: persona 行应对齐官方包名`)
  return row
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
    assert.equal(readFileSync(join(engineDir, 'THIRD_PARTY_LICENSES'), 'utf8'),
      readFileSync(join(ROOT, 'engine', 'THIRD_PARTY_LICENSES'), 'utf8'), '上游版权与许可随物化引擎保留')
    assert.equal(existsSync(join(engineDir, 'compositions')), false, '生成期 compositions 不复制')
    assert.equal(existsSync(join(presetDir, 'fixture', 'engine')), false, '子预设不再复制 engine')
    assert.equal(existsSync(join(presetDir, 'agent.cordis.yml')), false, '预设根不再写容器根转发')
    // 组合路径重写：引擎引用 ../.engine（相对预设目录 = 预设根/.engine），
    // configsDir ../fixture/prompt-configs（相对 .engine = 预设目录/prompt-configs，数学可验证）。
    const sub = readFileSync(join(presetDir, 'fixture', 'agent.cordis.yml'), 'utf8')
    assert.match(sub, /name: \.\.\/\.engine\/prompt-config-engine\.mjs/, '预设引擎引用 ../.engine（预设根共享）')
    assert.match(sub, /configsDir: \.\.\/fixture\/prompt-configs/, 'configsDir 相对 .engine 指向预设目录')
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
    const agent = readFileSync(join(presetDir, 'fixture', 'agent.cordis.yml'), 'utf8')
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
    const configsDir = join(presetDir, 'fixture', 'prompt-configs')
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
    const configsDir = join(presetDir, 'fixture', 'prompt-configs')
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
    cpSync(FIXTURE_PRESET_SRC, join(presetDir, 'fixture'), { recursive: true })
    // 1) 先设置 high。
    savePresetParams(presetDir, 'fixture', { modelReasoningEffort: 'high' }, undefined)
    assert.equal(loadPresetSpec(join(presetDir, 'fixture')).params.modelReasoningEffort, 'high', '设置 high 写入预设参数')
    // 2) 改回留空（UI 总是发送空串键）：preset.yml 旧键被删除，渲染不生成 patch。
    savePresetParams(presetDir, 'fixture', { modelReasoningEffort: '' }, undefined)
    assert.equal(loadPresetSpec(join(presetDir, 'fixture')).params.modelReasoningEffort, undefined, '改回留空删除旧键（渲染层无 patch）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('savePresetParams 空值删键：空数组删除，stagePreUnlock=0 是合法档位必须保留', () => {
  const dir = join(tmpdir(), `prompt-tool-empty-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    cpSync(FIXTURE_PRESET_SRC, join(presetDir, 'fixture'), { recursive: true })
    // 1) 设置有值：bootstrapTools / messageSources / stagePreUnlock / maxPromoteSteps。
    savePresetParams(presetDir, 'fixture', {
      bootstrapTools: ['bash'],
      messageSources: ['user'],
      stagePreUnlock: 2,
      maxPromoteSteps: 6,
    }, undefined)
    let spec = loadPresetSpec(join(presetDir, 'fixture'))
    assert.deepEqual(spec.params.bootstrapTools, ['bash'], 'bootstrapTools 写入')
    assert.deepEqual(spec.params.messageSources, ['user'], 'messageSources 写入')
    assert.equal(spec.params.stagePreUnlock, 2, 'stagePreUnlock 写入')
    assert.equal(spec.params.maxPromoteSteps, 6, 'maxPromoteSteps 写入')
    // 2) 改回空：空数组删除键；stagePreUnlock=0 是合法档位，不是空值。
    savePresetParams(presetDir, 'fixture', {
      bootstrapTools: [],
      messageSources: [],
      stagePreUnlock: 0,
      maxPromoteSteps: 0,
    }, undefined)
    spec = loadPresetSpec(join(presetDir, 'fixture'))
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
    const agent = readFileSync(join(presetDir, 'fixture', 'agent.cordis.yml'), 'utf8')
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
    const near = readFileSync(join(presetDir, 'fixture', 'prompt-configs', '0000-near-anchor.yml'), 'utf8')
    const guide = readFileSync(join(presetDir, 'fixture', 'prompt-configs', '0010-router-guide.yml'), 'utf8')
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
    const injector = readFileSync(join(presetDir, 'fixture', 'prompt-configs', '0020-prompt-injector.yml'), 'utf8')
    assert.ok(injector.includes('firstTurnWord: |-') && injector.includes('开始'), injector)
    // 未传 firstTurnWord 时回退 preset.yml 模板默认（we），不写空值覆盖。
    const dir2 = join(dir, 'preset2')
    writePreset('PROMPT', makeOptions(dir2))
    const injector2 = readFileSync(join(dir2, 'fixture', 'prompt-configs', '0020-prompt-injector.yml'), 'utf8')
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
    const injector = readFileSync(join(presetDir, 'fixture', 'prompt-configs', '0020-prompt-injector.yml'), 'utf8')
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

test('writePreset 不再物化任何 AGENTS 文件卡，指令正文不落预设产物', () => {
  const dir = join(tmpdir(), `prompt-tool-ai-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    // 工作区里确实存在指令文件：物化仍不得把它们变成生成卡（独立来源按会话现场解析）。
    const workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'AGENTS.md'), `${AGENTS_BODY_SENTINEL}\n`, 'utf8')
    writePreset('PROMPT', { ...makeOptions(presetDir), agentsInstructionText: AGENTS_BODY_SENTINEL })
    const configsDir = join(presetDir, 'fixture', 'prompt-configs')
    const names = readdirSync(configsDir)
    assert.deepEqual(names.filter((name) => name.includes('agents-file-')), [], '生成目录不再出现文件卡')
    const presetYml = readFileSync(join(presetDir, 'fixture', 'preset.yml'), 'utf8')
    assert.ok(!presetYml.includes('agents-file-'), 'preset.yml 不含文件卡身份')
    const leaked = names
      .filter((name) => name.endsWith('.yml'))
      .filter((name) => readFileSync(join(configsDir, name), 'utf8').includes(AGENTS_BODY_SENTINEL))
    assert.deepEqual(leaked, [], '任何生成产物都不得包含指令正文')
    assert.equal(existsSync(join(presetDir, 'fixture', 'agents-instruction.md')), false, '不再生成 agents-instruction.md')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('所有模板都不物化 AGENTS 文件卡，custom 保持显式空白', () => {
  const dir = join(tmpdir(), `prompt-tool-hints-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    for (const template of ['standard', 'minimal', 'ptc', 'creative']) {
      writePreset('', { ...makeOptions(presetDir), presetTemplate: template, injectPrompt: false })
      const configsDir = join(presetDir, template, 'prompt-configs')
      const names = readdirSync(configsDir)
      assert.deepEqual(names.filter((name) => name.includes('agents-file-')), [], `${template} 不应生成文件卡`)
      const presetYml = readFileSync(join(presetDir, template, 'preset.yml'), 'utf8')
      assert.ok(!presetYml.includes('agents-file-'), `${template} 的文件卡不得写进 preset.yml`)
    }
    writePreset('', { ...makeOptions(presetDir), presetTemplate: 'custom', injectPrompt: false })
    assert.equal(readdirSync(join(presetDir, 'custom', 'prompt-configs')).length, 0, 'custom 空白模板保持显式空组合')
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
    assert.equal(existsSync(join(presetDir, 'fixture', 'preset.md')), false, '空内容不生成 preset.md')
    assert.equal(existsSync(join(presetDir, 'fixture', 'agents.md')), false, '空内容不生成 agents.md')
    assert.equal(existsSync(join(presetDir, 'fixture', 'agents-instruction.md')), false, '空内容不生成 agents-instruction.md')
    const injector = readFileSync(join(presetDir, 'fixture', 'prompt-configs', '0020-prompt-injector.yml'), 'utf8')
    const parsed = parseYaml(injector)
    assert.equal(parsed.enabled, false, '空内容时 prompt-injector 应禁用（无内容可注入）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 四个官方基型以顶层 persona 段渲染官方 dsh-persona 行', () => {
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
      assert.equal(rows.filter((row) => row?.id === 'prompt-config-engine').length, 1, `${template}: persona 配置执行器应且仅应装配一次`)
      for (const id of ['context-gate', 'tool-bootstrap', 'promoted-code-mode']) {
        assert.equal(rows.some((row) => row?.id === id), false, `${template}: 不应追加 ${id}`)
      }
      assert.ok(!/__[A-Za-z0-9_]+__/.test(agent), `${template}: 不应残留未解析 token`)
      assert.match(agent, /^# prompt-tool:render v\d+$/m, `${template}: 组合应带渲染契约版本标记`)
      assert.ok(rows.length >= 2, `${template}: 组合行数异常（${rows.length}）`)
      if (template === 'creative') {
        const persona = readPersonaRow(presetDir, 'creative')
        assert.ok(persona.config.prefix.includes('{{model}}'), 'creative 人设应保留 {{model}} 变量')
        assert.ok(persona.config.prefix.includes('editing-cordis-compositions'), 'creative 人设应引用创作 skill')
        assert.equal(persona.config.suffix, 'Your working directory is {{cwd}}.', 'creative 人设 suffix 应对齐官方原文')
        assert.ok(existsSync(join(presetDir, 'creative', 'skills', 'editing-cordis-compositions', 'SKILL.md')), 'editing-cordis-compositions skill 应随预设复制')
        assert.ok(existsSync(join(presetDir, 'creative', 'skills', 'cordis-plugin-development', 'SKILL.md')), 'cordis-plugin-development skill 应随预设复制')
      } else if (template === 'standard' || template === 'ptc') {
        const persona = readPersonaRow(presetDir, template)
        assert.equal(persona.config.prefix, 'You are a coding agent powered by the {{model}} model.', `${template}: prefix 应对齐官方原文`)
        assert.equal(persona.config.suffix, 'Your working directory is {{cwd}}.', `${template}: suffix 应对齐官方原文`)
        assert.equal(persona.config.complete, undefined, `${template}: 非独占（无 complete）`)
      } else if (template === 'minimal') {
        const persona = readPersonaRow(presetDir, 'minimal')
        assert.equal(persona.config.prefix, 'You are a helpful software engineer assistant.', 'minimal: 人设应对齐官方原文')
        assert.equal(persona.config.complete, true, 'minimal: 人设独占（complete）')
        assert.equal(persona.config.includeRuntimeContext, false, 'minimal: 抑制 runtime context')
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
    writePreset('ALIAS PROMPT', { ...makeOptions(presetDir), presetTemplate: 'fixture', outputId: 'prompt-tool' })
    assert.ok(existsSync(join(presetDir, 'prompt-tool', 'agent.cordis.yml')), '别名目录组合本体生成')
    assert.ok(existsSync(join(presetDir, 'prompt-tool', 'preset.md')), '别名目录内容资产生成')
    assert.equal(existsSync(join(presetDir, 'fixture', 'preset.md')), false, '模板同名目录不受别名渲染影响')
    const sub = readFileSync(join(presetDir, 'prompt-tool', 'agent.cordis.yml'), 'utf8')
    assert.match(sub, /configsDir: \.\.\/prompt-tool\/prompt-configs/, '组合 configsDir 重写到别名目录')
    assert.match(sub, /name: \.\.\/\.engine\/prompt-config-engine\.mjs/, '引擎引用共享 .engine')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 自定义预设（custom）保持显式空组合', () => {
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
    assert.deepEqual(rows, [], '空白预设不应隐式装配引擎能力')
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
    assert.equal(readFileSync(join(presetDir, 'fixture', 'preset.md'), 'utf8'), 'PRESET CONTENT')
    assert.equal(readFileSync(join(presetDir, 'fixture', 'agents.md'), 'utf8'), 'AGENTS CONTENT')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 失败时保留旧生成目录', () => {
  const dir = join(tmpdir(), `prompt-tool-wp-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  mkdirSync(join(presetDir, 'fixture'), { recursive: true })
  writeFileSync(join(presetDir, 'fixture', 'keep.txt'), 'old', 'utf8')
  try {
    assert.throws(() => writePreset('PROMPT', { ...makeOptions(presetDir), presetTemplate: 'missing-template' }))
    assert.equal(readFileSync(join(presetDir, 'fixture', 'keep.txt'), 'utf8'), 'old')
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
      () => writePreset('PROMPT', { ...makeOptions(presetDir), presetTemplate: 'Fixture' }),
      /invalid presetTemplate/,
    )
    assert.ok(!existsSync(join(dir, 'escape')), '不得写入容器根之外')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 预设变量只读顶层 variables，清空后不复活 params 中的旧内容键', () => {
  const dir = join(tmpdir(), `prompt-tool-uikeys-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    // 旧 params 内容键及嵌套 params.variables 保留原文件，但不再成为变量源。
    cpSync(FIXTURE_PRESET_SRC, join(presetDir, 'fixture'), { recursive: true })
    const presetFile = join(presetDir, 'fixture', 'preset.yml')
    const doc = parseDocument(readFileSync(presetFile, 'utf8'))
    doc.setIn(['params', 'legacyVar'], '旧值')
    doc.setIn(['params', 'legacyEmpty'], '')
    doc.setIn(['params', 'wordsCloud'], '旧默认')
    doc.setIn(['params', 'variables'], { nested: '不是模板变量' })
    doc.get('modules', true).add('tool-config-engine')
    writeFileSync(presetFile, doc.toString(), 'utf8')
    const variables = { wordsCloud: '1500字', 日期: '', usePtcMode: '同名内容变量' }
    savePresetParams(presetDir, 'fixture', undefined, undefined, variables)
    const storedParams = parseYaml(readFileSync(presetFile, 'utf8')).params
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
    const pcDir = join(presetDir, 'fixture', 'prompt-configs')
    const file = readdirSync(pcDir).find((name) => name.endsWith('-near-anchor.yml'))
    assert.ok(file, '提示词配置文件存在')
    const parsed = parseYaml(readFileSync(join(pcDir, file), 'utf8'))
    for (const key of ['firstTurnAnchor', 'firstTurnText', 'modelProvider', 'modelName',
      'guideText', 'usePtcMode', 'injectPrompt', 'bootstrapMaxTokens', 'toolFilterAllow']) {
      assert.equal(parsed.params?.[key], undefined, `配置 params 不得含 UI 管理键 ${key}`)
      assert.equal(parsed.variables?.[key], undefined, `配置 variables 不得含 UI 管理键 ${key}`)
    }
    // 顶层变量不靠 PARAM_KEYS 猜测用途，允许与引擎参数同名；配置文件保持干净。
    const varsFile = join(pcDir, 'variables.yml')
    assert.ok(existsSync(varsFile), 'variables.yml 生成')
    const vars = parseYaml(readFileSync(varsFile, 'utf8'))
    assert.deepEqual(vars, variables, '变量文件只包含顶层变量，保留空串与同名键')
    assert.equal(parsed.variables?.['wordsCloud'], undefined, '配置文件不再逐条展开内容变量')
    assert.equal(parsed.params?.wordsCloud, undefined, '内容变量不再进 params')
    savePresetParams(presetDir, 'fixture', undefined, undefined, {})
    writePreset('PROMPT', makeOptions(presetDir))
    assert.equal(existsSync(varsFile), false, '清空顶层变量后移除旧生成文件，params 内容键不复活')
    assert.deepEqual(parseYaml(readFileSync(presetFile, 'utf8')).params, storedParams, '不迁移或清理原 params')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 自定义工具渲染 custom-tools/<n>-<id>.yml（源 = preset.yml 顶层 customTools 段）', () => {
  const dir = join(tmpdir(), `prompt-tool-ctools-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    cpSync(FIXTURE_PRESET_SRC, join(presetDir, 'fixture'), { recursive: true })
    const presetFile = join(presetDir, 'fixture', 'preset.yml')
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
    doc.get('modules', true).add('tool-config-engine')
    writeFileSync(presetFile, doc.toString(), 'utf8')
    writePreset('PROMPT', makeOptions(presetDir))
    const customToolsDir = join(presetDir, 'fixture', 'custom-tools')
    assert.ok(existsSync(customToolsDir), 'custom-tools 目录生成')
    const files = readdirSync(customToolsDir).sort()
    assert.deepEqual(files, ['0001-greet.yml'], '合法条目落盘；缺 output.schema 的坏条目在物化阶段跳过')
    const parsed = parseYaml(readFileSync(join(customToolsDir, '0001-greet.yml'), 'utf8'))
    assert.equal(parsed.name, 'my_greet')
    assert.equal(parsed.execute.kind, 'shell')
    assert.deepEqual(parsed.parameters, { type: 'object', properties: { who: { type: 'string', description: '对象' } }, required: ['who'] }, '参数 DSL 经官方转换器物化为标准 JSON Schema')
    const composition = parseYaml(readFileSync(join(presetDir, 'fixture', 'agent.cordis.yml'), 'utf8'))
    const toolRow = composition.find((row) => row?.id === 'tool-config-engine')
    assert.equal(toolRow.config.configsDir, '../fixture/custom-tools', 'custom-tools 路径应重写到当前预设')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 自动校验并装配 subagentToolPolicy，非法策略拒绝', () => {
  const dir = join(tmpdir(), `prompt-tool-spolicy-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    cpSync(join(ROOT, 'preset', 'minimal'), join(presetDir, 'minimal'), { recursive: true })
    const presetFile = join(presetDir, 'minimal', 'preset.yml')
    const doc = parseDocument(readFileSync(presetFile, 'utf8'))
    doc.setIn(['subagentToolPolicy'], {
      defaultProfile: 'base', ceiling: { allow: ['read'], deny: [] },
      profiles: [{ id: 'base', name: '基础', allow: ['read'], deny: [], modelSelectable: false }],
      characterBindings: [], taskRules: [], modelExpansion: { enabled: false, allow: [], maxAdditionalTools: 0, requireApproval: true },
    })
    writeFileSync(presetFile, doc.toString(), 'utf8')
    writePreset('P', { ...makeOptions(presetDir), presetTemplate: 'minimal' })
    assert.ok(existsSync(join(presetDir, 'minimal', 'subagent-tools', 'policy.yml')))
    const composition = readFileSync(join(presetDir, 'minimal', 'agent.cordis.yml'), 'utf8')
    assert.match(composition, /id: subagent-tool-policy/)
    doc.setIn(['subagentToolPolicy'], {})
    writeFileSync(presetFile, doc.toString(), 'utf8')
    assert.throws(() => writePreset('P', { ...makeOptions(presetDir), presetTemplate: 'minimal' }), /invalid subagentToolPolicy/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('savePresetParams 清理空 key（VariablesEditor 待编辑行不落盘）', () => {
  const dir = join(tmpdir(), `prompt-tool-emptyk-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    mkdirSync(join(presetDir, 'fixture'), { recursive: true })
    writeFileSync(join(presetDir, 'fixture', 'preset.yml'), 'id: fixture\nparams: {}\n', 'utf8')
    savePresetParams(
      presetDir,
      'fixture',
      { '': 'x', wordsCloud: 'v' },
      [{ id: 'a', variables: { '': '', keep: '1' } }],
    )
    const doc = parseYaml(readFileSync(join(presetDir, 'fixture', 'preset.yml'), 'utf8'))
    assert.equal(doc.params?.[''], undefined, 'params 空 key 不写入')
    assert.equal(doc.params?.wordsCloud, 'v', '有效 params 正常写入')
    assert.equal(doc.promptConfigs[0]?.variables?.[''], undefined, '配置 variables 空 key 不写入')
    assert.equal(doc.promptConfigs[0]?.variables?.keep, '1', '有效变量保留')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('晋升门控/渐进披露/验证工具参数仅进入组合配置，不成为模板变量', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-wp-paramkeys-'))
  try {
    // 复制夹具模板，params 加新增参数键（模拟用户手写/UI 保存）。
    cpSync(FIXTURE_PRESET_SRC, join(dir, 'fixture'), { recursive: true })
    const presetFile = join(dir, 'fixture', 'preset.yml')
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
    doc.get('modules', true).add('tool-config-engine')
    writeFileSync(presetFile, doc.toString(), 'utf8')

    writePreset('PROMPT', makeOptions(dir))

    const pcDir = join(dir, 'fixture', 'prompt-configs')
    const varsFile = join(pcDir, 'variables.yml')
    // 无内容变量（顶层 variables 段为空）时不生成 variables.yml；生成时不得含参数键。
    const vars = existsSync(varsFile) ? parseYaml(readFileSync(varsFile, 'utf8')) : {}
    // params 整段不作为变量源，新增参数也不得混入 variables.yml。
    for (const key of ['promoteGate', 'maxPromoteSteps', 'bootstrapTools', 'messageSources',
      'stagePreUnlock',
      // 锚定/引导内容键：writePreset 映射进 promptConfig.params，不得双落盘 variables.yml。
      'buildPattern', 'complexPattern', 'firstTurnBuild', 'firstTurnInspect', 'firstTurnDeep',
      'guideWeak', 'guideDeep']) {
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
    const cordis = readFileSync(join(dir, 'fixture', 'agent.cordis.yml'), 'utf8')
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
  const varConfig = () => [{
    id: 'var-test',
    layer: 'pre-step',
    strategy: 'static',
    order: 999,
    texts: ['剧情{{wordsCloud}}字 {{DSH_HOME}}'],
  }]
  try {
    cpSync(FIXTURE_PRESET_SRC, join(presetDir, 'fixture'), { recursive: true })
    savePresetParams(presetDir, 'fixture', undefined, undefined, { wordsCloud: '1500字' }, false)
    const pcDir = join(presetDir, 'fixture', 'prompt-configs')
    writePreset('PROMPT', { ...makeOptions(presetDir), promptConfigs: varConfig() })
    const varsFile = join(pcDir, 'variables.yml')
    assert.equal(existsSync(varsFile), false, '停用时 variables.yml 不生成')
    const file = readdirSync(pcDir).find((name) => name.endsWith('-var-test.yml'))
    assert.ok(file, 'var-test 配置生成')
    const parsed = parseYaml(readFileSync(join(pcDir, file), 'utf8'))
    assert.equal(parsed.text, '剧情字 {{DSH_HOME}}', '预设变量引用剥离、内置变量保留')
    // 重新启用：true = 删除开关键（缺省启用），变量文件恢复。
    savePresetParams(presetDir, 'fixture', undefined, undefined, { wordsCloud: '1500字' }, true)
    writePreset('PROMPT', { ...makeOptions(presetDir), promptConfigs: varConfig() })
    assert.ok(existsSync(varsFile), '启用后 variables.yml 恢复生成')
    const vars = parseYaml(readFileSync(varsFile, 'utf8'))
    assert.equal(vars.wordsCloud, '1500字')
    const reParsed = parseYaml(readFileSync(join(pcDir, file), 'utf8'))
    assert.equal(reParsed.text, '剧情{{wordsCloud}}字 {{DSH_HOME}}', '启用后配置文本保留引用（引擎插值）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})


test('writePreset 组合源缺失回退：用户副本无组合源 → 回退包内模板渲染，不写回用户参数源', () => {
  // 模拟真实布局：presetDir 即隔离 DSH_HOME 的 .agent-presets（参数源与目标同目录，升级闭环）
  const presetDir = join(home, '.agent-presets')
  const userMinimal = join(presetDir, 'minimal')
  try {
    rmSync(userMinimal, { recursive: true, force: true })
    mkdirSync(userMinimal, { recursive: true })
    // 纯元数据副本：无 modules/params/promptConfigs，目录也无 agent.cordis.yml。
    writeFileSync(join(userMinimal, 'preset.yml'), 'name: 极简模式（旧）\ndescription: 旧版种子副本\norder: 3\n', 'utf8')
    const warnings = []
    writePreset('PROMPT', { ...makeOptions(presetDir), presetTemplate: 'minimal', warn: (message) => warnings.push(message) })
    // 回退包内模板渲染成功：组合精确对齐官方 Minimal 基型。
    const cordis = readFileSync(join(presetDir, 'minimal', 'agent.cordis.yml'), 'utf8')
    assert.deepEqual(parseYaml(cordis).map((row) => row.id), ['persona', 'persistent-shell', 'prompt-config-engine'])
    // 不回写用户参数源：没有迁移，modules 不落盘，用户命名与内容原样保留。
    const spec = parseYaml(readFileSync(join(presetDir, 'minimal', 'preset.yml'), 'utf8'))
    assert.equal(spec.modules, undefined, '不注入包内 modules（无迁移）')
    assert.equal(spec.name, '极简模式（旧）', '用户命名保留')
    assert.equal(spec.description, '旧版种子副本', '用户描述保留')
    assert.ok(warnings.some((message) => message.includes('回退')), '回退发生时 warn')
  } finally {
    rmSync(userMinimal, { recursive: true, force: true })
  }
})

test('writePreset 非纯元数据副本不升级：仅回退渲染，参数源保持用户旧值', () => {
  const presetDir = join(home, '.agent-presets')
  const userPtc = join(presetDir, 'ptc')
  try {
    mkdirSync(userPtc, { recursive: true })
    // 用户配置过（有 params 段）但不可渲染的副本
    writeFileSync(join(userPtc, 'preset.yml'), 'id: ptc\nname: 用户改过的PTC\nparams:\n  injectPrompt: false\n', 'utf8')
    writePreset('PROMPT', { ...makeOptions(presetDir), presetTemplate: 'ptc' })
    // 参数源未被包内模板覆盖（保留用户 params）
    const spec = parseYaml(readFileSync(join(presetDir, 'ptc', 'preset.yml'), 'utf8'))
    assert.equal(spec.name, '用户改过的PTC', '用户命名保留')
    assert.equal(spec.params?.injectPrompt, false, '用户参数保留（不升级不覆盖）')
    assert.ok(existsSync(join(presetDir, 'ptc', 'agent.cordis.yml')), '回退渲染仍产出组合')
  } finally {
    rmSync(userPtc, { recursive: true, force: true })
  }
})

test('writePreset 禁用大条目瘦身：enabled=false 超阈值正文不落产物', () => {
  const dir = join(tmpdir(), `prompt-tool-slim-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    const bigText = 'x'.repeat(40 * 1024)
    writePreset('PROMPT', { ...makeOptions(presetDir), promptConfigs: [
      { id: 'st-dump', name: '设置dump', enabled: false, strategy: 'static', layer: 'system-section', order: 100, text: bigText },
      { id: 'normal-off', name: '普通禁用', enabled: false, strategy: 'static', layer: 'system-section', order: 110, text: '小段文本' },
      { id: 'normal-on', name: '启用大条目', enabled: true, strategy: 'static', layer: 'system-section', order: 120, text: bigText },
    ] })
    const configsDir = join(presetDir, 'fixture', 'prompt-configs')
    const read = (id) => {
      const file = readdirSync(configsDir).find((name) => name.endsWith(`-${id}.yml`))
      assert.ok(file, `应生成 ${id}`)
      return parseYaml(readFileSync(join(configsDir, file), 'utf8'))
    }
    const dump = read('st-dump')
    assert.equal(dump.enabled, false)
    assert.equal(dump.text, undefined, '禁用大条目产物不落正文')
    assert.equal(dump.texts, undefined, '禁用大条目产物不落多段正文')
    const smallOff = read('normal-off')
    assert.equal(smallOff.text, '小段文本', '阈值内禁用条目保留正文')
    const bigOn = read('normal-on')
    assert.equal(bigOn.text.length, 40 * 1024, '启用条目不受瘦身影响')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 夹具模板不默认装配 ST 管理工具模块' , () => {
  const dir = join(tmpdir(), `prompt-tool-modules-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    writePreset('PROMPT', makeOptions(presetDir))
    const rows = parseYaml(readFileSync(join(presetDir, 'fixture', 'agent.cordis.yml'), 'utf8'))
    const ids = rows.map((row) => row?.id).filter(Boolean)
    for (const id of ['character-tools', 'world-book-tools', 'session-var-tools', 'tool-config-engine']) {
      assert.equal(ids.includes(id), false, `${id} 应由 ST 转换按需装配`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 目标目录被占用时退回原地合并写：内容刷新且多余项清理', () => {
  const dir = join(tmpdir(), `prompt-tool-lock-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  const originalCwd = process.cwd()
  try {
    writePreset('PROMPT', makeOptions(presetDir))
    const target = join(presetDir, 'fixture')
    const stale = join(target, 'prompt-configs', '9999-stale.yml')
    mkdirSync(join(target, 'prompt-configs'), { recursive: true })
    writeFileSync(stale, 'id: stale\n', 'utf8')
    // 把本进程 cwd 放进目标目录：Windows 拒绝改名任何进程的当前目录，
    // 等价于宿主打开句柄（真实场景 = 预设内 skills 被技能监听器持有）。
    process.chdir(target)
    writePreset('PROMPT2', makeOptions(presetDir))
    assert.equal(readFileSync(join(target, 'preset.md'), 'utf8'), 'PROMPT2', '原地合并后内容资产刷新')
    assert.ok(existsSync(join(target, 'agent.cordis.yml')), '组合仍在')
    assert.equal(existsSync(stale), false, '原地合并同样清理多余项')
    assert.equal(
      readdirSync(presetDir).some((name) => name.includes('.bak-') || name.includes('.tmp-')),
      false,
      '不残留备份/临时目录',
    )
  } finally {
    process.chdir(originalCwd)
    rmSync(dir, { recursive: true, force: true })
  }
})
