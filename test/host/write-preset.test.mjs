import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml, parseDocument } from 'yaml'

// 隔离 DSH_HOME：writePreset 的模板解析（resolvePresetDir）用户预设优先——
// 真实用户环境 .prompt-tool/modules/<id> 会遮蔽包内模板，测试必须隔离。
const home = mkdtempSync(join(tmpdir(), 'pt-wp-home-'))
process.env.DSH_HOME = home
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const { FIXTURE_PRESET_ID, FIXTURE_PRESET_SRC, installFixturePreset, installFixturePresetInHome } = await import('../fixtures/preset-template.mjs')
const { writePreset, savePresetParams } = await import('../../src/index.ts')
// 夹具模板同时装进隔离 DSH_HOME 的官方预设根（resolvePresetDir 场景）与各测试的输出根（见 makeOptions）。
installFixturePresetInHome(home)
test.after(() => rmSync(home, { recursive: true, force: true }))

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

test('writePreset 共享引擎：预设根不物化 .engine，组合引用插件包说明符', () => {
  const dir = join(tmpdir(), `prompt-tool-wp-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    writePreset('PROMPT', makeOptions(presetDir))
    // 共享引擎自阶段 2 起由**插件包**提供（组合行引用 dsh-plugin-prompt-tool/engine/*.mjs）：
    // 预设根下不再出现 .engine/ 目录，也不再写引擎指纹文件。
    assert.equal(existsSync(join(presetDir, '.engine')), false, '预设根不再物化 .engine')
    assert.equal(existsSync(join(presetDir, '.pt-engine-fingerprint')), false, '不再写引擎指纹文件')
    assert.deepEqual(readdirSync(presetDir).filter((name) => name.startsWith('.')), [],
      '预设根不残留 .engine/.pt-engine-fingerprint/临时目录')
    assert.equal(existsSync(join(presetDir, 'fixture', 'engine')), false, '子预设不复制 engine')
    assert.equal(existsSync(join(presetDir, 'agent.cordis.yml')), false, '预设根不再写容器根转发')
    // 组合路径重写：引擎行改引用包名说明符（预设包不再携带 engine/，旧 ./engine/ 与
    // ../.engine/ 都不再被识别）；configsDir 保持历史语义 `../<id>/...`
    //（相对 <预设根>/.engine/ 解析 = 预设目录/prompt-configs），由配装通道在挂载期换算。
    const sub = readFileSync(join(presetDir, 'fixture', 'agent.cordis.yml'), 'utf8')
    assert.doesNotMatch(sub, /name: ['"]?\.{1,2}\/\.?engine\//,
      '产物不得残留 ./engine/ 或 ../.engine/ 本地引用')
    for (const module of ['prompt-config-engine', 'run-code-env', 'tool-git-bash', 'skill-search']) {
      assert.match(sub, new RegExp(`name: dsh-plugin-prompt-tool/engine/${module}\\.mjs`),
        `引擎行 ${module} 应引用插件包说明符`)
      assert.ok(existsSync(join(ROOT, 'engine', `${module}.mjs`)),
        `说明符 ${module}.mjs 应在包内引擎目录存在（否则引用悬空）`)
    }
    assert.match(sub, /configsDir: \.\.\/fixture\/prompt-configs/, 'configsDir 相对 .engine 指向预设目录')
    const engineRow = parseYaml(sub).find((row) => row?.id === 'prompt-config-engine')
    // 虚拟引擎基准 <预设根>/.engine/（注册期换算用的同一基准；URL 解析无需目录真实存在）。
    const engineFileUrl = pathToFileURL(join(presetDir, '.engine', 'prompt-config-engine.mjs'))
    const resolved = new URL(engineRow.config.configsDir + '/', engineFileUrl)
    assert.ok(existsSync(resolved), `configsDir 解析后应存在: ${resolved.pathname}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 不再有引擎指纹：二次写入不物化 .engine，产物幂等', () => {
  const dir = join(tmpdir(), `prompt-tool-fp-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    writePreset('PROMPT', makeOptions(presetDir))
    // 引擎指纹（.engine/.pt-engine-fingerprint + 内容摘要比对、未变则不重刷）已随共享引擎
    // 归位插件包整体删除：二次写入不再有「是否重刷共享引擎」这一步，只需保证产物本身幂等
    // 且不产生引擎目录/指纹文件。
    const stable = readFileSync(join(presetDir, 'fixture', 'agent.cordis.yml'), 'utf8')
    writePreset('PROMPT', makeOptions(presetDir))
    assert.equal(readFileSync(join(presetDir, 'fixture', 'agent.cordis.yml'), 'utf8'), stable,
      '二次写入产物逐字节稳定（引擎说明符不来回改写）')
    assert.equal(existsSync(join(presetDir, '.engine')), false, '二次写入仍不物化 .engine')
    assert.equal(existsSync(join(presetDir, '.pt-engine-fingerprint')), false, '不再写引擎指纹文件')
    assert.deepEqual(readdirSync(presetDir).filter((name) => name.startsWith('.')), [],
      '二次写入不残留引擎/指纹/临时/备份目录')
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

test('writePreset：preset.yml 的模块行参数经参数桥注入 agent.cordis.yml', () => {
  const dir = join(tmpdir(), `prompt-tool-wp-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    // B7 T3：原用例的载体是 `pre-step.allowKinds` → `context-gate` 行；两者都已删除。
    // 换成本地自己写的模板（不污染共享夹具），机制与断言不变。
    mkdirSync(join(presetDir, FIXTURE_PRESET_ID), { recursive: true })
    writeFileSync(join(presetDir, FIXTURE_PRESET_ID, 'preset.yml'),
      'id: fixture\nname: fixture\nversion: "1"\nengineCompat: ">=0.4.2"\n'
      + 'modules: [tool-git-bash]\nlayerSettings:\n  tool-pipeline:\n    toolGitBashEnabled: false\n', 'utf8')
    writePreset('PROMPT', makeOptions(presetDir))
    const rows = parseYaml(readFileSync(join(presetDir, FIXTURE_PRESET_ID, 'agent.cordis.yml'), 'utf8'))
    const toolGitBash = rows.find((row) => row?.id === 'tool-git-bash')
    assert.ok(toolGitBash, 'agent.cordis.yml 应含 tool-git-bash 行')
    assert.equal(toolGitBash.config.enabled, false, '参数桥把 layerSettings 参数写进该行的 config')
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

test('writePreset 四个官方基型以顶层 persona 段渲染官方 dsh-persona 行', () => {
  for (const template of ['pt-standard', 'pt-minimal', 'pt-ptc', 'pt-cordis']) {
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
      assert.ok(!/__[A-Za-z0-9_]+__/.test(agent), `${template}: 不应残留未解析 token`)
      assert.match(agent, /^# prompt-tool:render v\d+$/m, `${template}: 组合应带渲染契约版本标记`)
      assert.ok(rows.length >= 2, `${template}: 组合行数异常（${rows.length}）`)
      if (template === 'pt-cordis') {
        const persona = readPersonaRow(presetDir, template)
        assert.ok(persona.config.prefix.includes('{{model}}'), 'cordis 人设应保留 {{model}} 变量')
        const officialPatch = parseYaml(readFileSync(new URL('../fixtures/dsh/current/packages/bundle/web-app/presets/cordis.patch.yml', import.meta.url), 'utf8'), { logLevel: 'silent' })
        const officialPersona = officialPatch[0].insert[0].config.plugins.find((row) => row.id === 'persona').config
        assert.equal(persona.config.prefix.trim(), officialPersona.prefix.trim(), 'cordis 人设应对齐本次核验的官方声明')
        assert.equal(persona.config.suffix, 'Your working directory is {{cwd}}.', 'cordis 人设 suffix 应对齐官方原文')
        assert.ok(existsSync(join(presetDir, template, 'skills', 'editing-cordis-compositions', 'SKILL.md')), 'editing-cordis-compositions skill 应随预设复制')
        assert.ok(existsSync(join(presetDir, template, 'skills', 'cordis-plugin-development', 'SKILL.md')), 'cordis-plugin-development skill 应随预设复制')
      } else if (template === 'pt-standard' || template === 'pt-ptc') {
        const persona = readPersonaRow(presetDir, template)
        assert.equal(persona.config.prefix, 'You are a coding agent powered by the {{model}} model.', `${template}: prefix 应对齐官方原文`)
        assert.equal(persona.config.suffix, 'Your working directory is {{cwd}}.', `${template}: suffix 应对齐官方原文`)
        assert.equal(persona.config.complete, undefined, `${template}: 非独占（无 complete）`)
      } else if (template === 'pt-minimal') {
        const persona = readPersonaRow(presetDir, template)
        assert.equal(persona.config.prefix, 'You are a helpful software engineer assistant.', 'minimal: 人设应对齐官方原文')
        assert.equal(persona.config.complete, true, 'minimal: 人设独占（complete）')
        assert.equal(persona.config.includeRuntimeContext, false, 'minimal: 抑制 runtime context')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('writePreset 自定义预设（custom）保持显式空组合', () => {
  const dir = join(tmpdir(), `prompt-tool-custom-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    writePreset('', {
      ...makeOptions(presetDir),
      presetTemplate: 'pt-custom',
      injectPrompt: false,
      firstTurnAnchor: false,
      bootstrapMaxTokens: 0,
      usePtcMode: true,
    })
    const agent = readFileSync(join(presetDir, 'pt-custom', 'agent.cordis.yml'), 'utf8')
    const rows = parseYaml(agent)
    assert.deepEqual(rows, [], '空白预设不应隐式装配引擎能力')
    assert.ok(!/__[A-Za-z0-9_]+__/.test(agent), '不应残留未解析 token')
    const promptConfigs = readdirSync(join(presetDir, 'pt-custom', 'prompt-configs'))
    assert.equal(promptConfigs.length, 0, '自定义预设 promptConfigs 应为空')
    assert.equal(existsSync(join(presetDir, 'pt-custom', 'engine')), false, '子预设不复制 engine（共享于容器根）')
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
    assert.equal(toolRow.name, 'dsh-plugin-prompt-tool/engine/tool-config-engine.mjs',
      'tool-config-engine 行引用插件包说明符')
    assert.equal(toolRow.config.configsDir, '../fixture/custom-tools',
      'custom-tools 路径应重写为相对虚拟引擎基准 <预设根>/.engine/ 的 ../<id>/custom-tools')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset 用户副本缺组合源时拒绝，不回退包内同名模板', () => {
  const presetDir = join(home, '.prompt-tool', 'modules')
  const userMinimal = join(presetDir, 'pt-minimal')
  try {
    rmSync(userMinimal, { recursive: true, force: true })
    mkdirSync(userMinimal, { recursive: true })
    // 纯元数据副本：无 modules/params/promptConfigs，目录也无 agent.cordis.yml。
    writeFileSync(join(userMinimal, 'preset.yml'), 'name: 极简模式（旧）\ndescription: 旧版种子副本\norder: 3\n', 'utf8')
    const before = readFileSync(join(userMinimal, 'preset.yml'), 'utf8')
    assert.throws(() => writePreset('PROMPT', { ...makeOptions(presetDir), presetTemplate: 'pt-minimal' }), /no modules\/composition/)
    assert.equal(existsSync(join(userMinimal, 'agent.cordis.yml')), false)
    assert.equal(readFileSync(join(userMinimal, 'preset.yml'), 'utf8'), before)
    const spec = parseYaml(readFileSync(join(userMinimal, 'preset.yml'), 'utf8'))
    assert.equal(spec.modules, undefined, '不注入包内 modules（无迁移）')
    assert.equal(spec.name, '极简模式（旧）', '用户命名保留')
    assert.equal(spec.description, '旧版种子副本', '用户描述保留')
  } finally {
    rmSync(userMinimal, { recursive: true, force: true })
  }
})

test('R3 未提供的引擎参数保留 preset.yml 定义，显式值才覆盖（导入/离线物化同源）', () => {
  const dir = join(tmpdir(), `prompt-tool-preserve-${process.pid}-${Date.now()}`)
  /** 安装夹具并把定义改成「作者显式声明」形态，覆盖 runtimeOf 曾补默认值的键。 */
  const install = (presetDir) => {
    installFixturePreset(presetDir)
    const file = join(presetDir, FIXTURE_PRESET_ID, 'preset.yml')
    const doc = parseDocument(readFileSync(file, 'utf8'))
    doc.setIn(['layerSettings', 'pre-step', 'firstTurnAnchor'], true)
    doc.setIn(['layerSettings', 'pre-step', 'firstTurnText'], 'ANCHOR TEXT')
    doc.setIn(['layerSettings', 'pre-step', 'injectPrompt'], false)
    doc.setIn(['layerSettings', 'subagent-start', 'subagentModelProvider'], 'sub-provider')
    doc.setIn(['layerSettings', 'subagent-start', 'subagentModelName'], 'sub-model')
    writeFileSync(file, doc.toString(), 'utf8')
    return presetDir
  }
  const readConfig = (presetDir, id) => {
    const configsDir = join(presetDir, FIXTURE_PRESET_ID, 'prompt-configs')
    const file = readdirSync(configsDir).find((name) => name.endsWith(`-${id}.yml`))
    assert.ok(file, `应生成 ${id}`)
    return parseYaml(readFileSync(join(configsDir, file), 'utf8'))
  }
  const subagentRow = (presetDir) => {
    const rows = parseYaml(readFileSync(join(presetDir, FIXTURE_PRESET_ID, 'agent.cordis.yml'), 'utf8'))
    const group = rows.find((row) => row?.id === 'delegation')
    return (group?.config ?? []).find((row) => row?.id === 'tool-subagent')
  }
  try {
    // 调用方只给部署字段（与 installPresetPackage / 离线物化调用同源）：不得覆盖作者定义。
    const kept = install(join(dir, 'kept'))
    writePreset('PRESET BODY', { presetDir: kept, presetTemplate: FIXTURE_PRESET_ID, presetOrder: 5, promptConfigs: [] })
    assert.equal(readConfig(kept, 'near-anchor').enabled, true, '省略 firstTurnAnchor 时保留定义里的 true')
    assert.equal(readConfig(kept, 'near-anchor').params.text, 'ANCHOR TEXT', '省略 firstTurnText 不清空作者文本')
    assert.equal(readConfig(kept, 'prompt-injector').enabled, false, '省略 injectPrompt 时保留定义里的 false')
    assert.deepEqual(subagentRow(kept)?.config?.agentOptions, { provider: 'sub-provider', model: 'sub-model' },
      '省略子代理模型路由时保留定义')

    // 显式值优先：false / true / 空串分别是「关锚定」「启用注入器」「不设置路由」。
    const explicit = install(join(dir, 'explicit'))
    writePreset('PRESET BODY', {
      presetDir: explicit, presetTemplate: FIXTURE_PRESET_ID, presetOrder: 5, promptConfigs: [],
      firstTurnAnchor: false, injectPrompt: true, subagentModelProvider: '', subagentModelName: '',
    })
    assert.equal(readConfig(explicit, 'near-anchor').enabled, false, '显式 false 覆盖定义')
    assert.equal(readConfig(explicit, 'prompt-injector').enabled, true, '显式 true 覆盖定义')
    assert.equal(subagentRow(explicit)?.config?.agentOptions, undefined, '显式空串 = 不设置路由')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset：模板名与输出目录名分离，安全 id 输出仍渲染包内模板', () => {
  const outputRoot = mkdtempSync(join(home, 'split-'))
  writePreset('', {
    ...makeOptions(outputRoot),
    presetTemplate: FIXTURE_PRESET_ID,
    outputId: 'pt-safe',
  })
  const composition = readFileSync(join(outputRoot, 'pt-safe', 'agent.cordis.yml'), 'utf8')
  assert.match(composition, /configsDir: \.\.\/pt-safe\/prompt-configs/, '引擎配置目录应指向输出目录自身')
  assert.match(composition, /name: dsh-plugin-prompt-tool\/engine\/prompt-config-engine\.mjs/,
    '引擎引用插件包说明符（与输出目录名解耦）')
  assert.equal(existsSync(join(outputRoot, 'standard')), false, '模板名不会被当成输出目录')
})
