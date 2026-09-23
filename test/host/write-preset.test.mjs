import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
const { apply, Config, writePreset, savePresetParams, loadPresetSpec } = await import('../../src/index.ts')
// 夹具模板同时装进隔离 DSH_HOME 的官方预设根（resolvePresetDir 场景）与各测试的输出根（见 makeOptions）。
installFixturePresetInHome(home)
/** 指令文件正文 sentinel：任何预设产物都不得包含它（正文只属于用户文件）。 */
const AGENTS_BODY_SENTINEL = 'AGENTS CONTENT SENTINEL 7f3a'
test.after(() => rmSync(home, { recursive: true, force: true }))

test('writePreset 从指定预设根读取同名参数，不被默认根遮蔽', () => {
  const id = 'root-isolation'
  const customRoot = mkdtempSync(join(home, 'custom-root-'))
  // B7 T3：`usePtcMode`（`tool-pipeline`）随 tool-filter/promoted-code-mode 一并删除，
  // 载体换成同样「layerSettings 参数 → 模块行 config」的存活参数 `toolGitBashEnabled`。
  for (const [root, toolGitBashEnabled] of [[join(home, '.agent-presets'), true], [customRoot, false]]) {
    mkdirSync(join(root, id), { recursive: true })
    writeFileSync(join(root, id, 'preset.yml'),
      `id: ${id}\nmodules: [tool-git-bash]\nlayerSettings:\n  tool-pipeline:\n    toolGitBashEnabled: ${toolGitBashEnabled}\n`, 'utf8')
  }
  const defaultFile = join(home, '.agent-presets', id, 'preset.yml')
  const before = readFileSync(defaultFile, 'utf8')
  writePreset('', { ...makeOptions(customRoot), presetTemplate: id, toolGitBashEnabled: undefined })
  const row = parseYaml(readFileSync(join(customRoot, id, 'agent.cordis.yml'), 'utf8'))[0]
  assert.equal(row.config.enabled, false)
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
    //（相对 <预设根>/.engine/ 解析 = 预设目录/prompt-configs），由 preset-registry 注册期换算。
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

test('R4 引擎不再随预设物化：产物里没有引擎副本，引擎行说明符指向包内真实文件', () => {
  const dir = join(tmpdir(), `prompt-tool-engine-pkg-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    writePreset('PROMPT', makeOptions(presetDir))
    // 包内引擎目录是说明符的唯一解析目标（package.json exports "./engine/*"）。
    const packaged = new Set(readdirSync(join(ROOT, 'engine')).filter((name) => name.endsWith('.mjs')))
    assert.ok(packaged.has('prompt-config-engine.mjs'), '包内引擎目录应存在')
    /** 预设根下递归收集全部产物文件（相对路径，正斜杠）。 */
    const walk = (prefix) => readdirSync(join(presetDir, prefix), { withFileTypes: true })
      .flatMap((entry) => {
        const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name
        return entry.isDirectory() ? walk(rel) : [rel]
      })
    const files = walk('')
    // 引擎副本判据：出现在 engine/ 或 .engine/ 路径段下的产物，或与包内引擎模块同名的文件。
    assert.deepEqual(files.filter((rel) => /(^|\/)\.?engine\//.test(rel)), [],
      '预设产物不含任何引擎目录副本（.engine/ 与逐预设 engine/ 都不物化）')
    assert.deepEqual(files.filter((rel) => packaged.has(rel.split('/').pop())), [],
      '预设产物不含与包内引擎同名的文件')
    assert.deepEqual(files.filter((rel) => rel.includes('pt-engine-fingerprint')), [], '不再写引擎指纹文件')
    const rows = parseYaml(readFileSync(join(presetDir, 'fixture', 'agent.cordis.yml'), 'utf8'))
    const prefix = 'dsh-plugin-prompt-tool/engine/'
    const engineRows = rows.filter((row) => typeof row?.name === 'string'
      && (row.name.startsWith(prefix) || /^\.{1,2}\/\.?engine\//.test(row.name)))
    assert.ok(engineRows.length > 0, '组合应含引擎行')
    for (const row of engineRows) {
      assert.match(row.name, /^dsh-plugin-prompt-tool\/engine\/[^/]+\.mjs$/, `${row.id}: 引擎行应引用插件包说明符`)
      assert.ok(packaged.has(row.name.slice(prefix.length)), `${row.id}: 说明符 ${row.name} 应在包内引擎目录存在`)
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

test('savePresetParams 空值删键：空数组/空串删除，合法零值必须保留', () => {
  const dir = join(tmpdir(), `prompt-tool-empty-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    cpSync(FIXTURE_PRESET_SRC, join(presetDir, 'fixture'), { recursive: true })
    // B7 T3：原用例用的 bootstrapTools / messageSources / stagePreUnlock / maxPromoteSteps 四个
    // 参数键已随七个专用能力删除。改用存活参数覆盖同一语义（列表 / 字符串 / 可为零的整数）。
    // 1) 设置有值。
    savePresetParams(presetDir, 'fixture', {
      customToolRequireApproval: ['shell'],
      modelTemperature: 0.7,
      maxDepth: 3,
    }, undefined)
    let spec = loadPresetSpec(join(presetDir, 'fixture'))
    assert.deepEqual(spec.params.customToolRequireApproval, ['shell'], 'customToolRequireApproval 写入')
    assert.equal(spec.params.modelTemperature, 0.7, 'modelTemperature 写入')
    assert.equal(spec.params.maxDepth, 3, 'maxDepth 写入')
    // 2) 改回空：空数组 / 空串删除键；0 是合法值，不是空值。
    savePresetParams(presetDir, 'fixture', {
      customToolRequireApproval: [],
      modelTemperature: '',
      maxDepth: 0,
    }, undefined)
    spec = loadPresetSpec(join(presetDir, 'fixture'))
    assert.equal(spec.params.customToolRequireApproval, undefined, '空数组删键（引擎 stringList 空数组 fail）')
    assert.equal(spec.params.modelTemperature, undefined, '空串删键（留空 = 不设置）')
    assert.equal(spec.params.maxDepth, 0, 'maxDepth 0 保留（0 = 禁止委派，与「留空 = 不设置」语义不同）')
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
    // 未传 firstTurnWord 时不造内置确认词：写空值，由模板/预设决定是否给词。
    const dir2 = join(dir, 'preset2')
    writePreset('PROMPT', makeOptions(dir2))
    const injector2 = readFileSync(join(dir2, 'fixture', 'prompt-configs', '0020-prompt-injector.yml'), 'utf8')
    assert.ok(injector2.includes("firstTurnWord: ''"), injector2)
    assert.equal(injector2.includes('firstTurnWord: |-'), false, '不再回退内置 we 确认词')
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
    writePreset('PROMPT', { ...makeOptions(presetDir), presetTemplate: 'pt-minimal' })
    assert.ok(existsSync(join(presetDir, 'pt-minimal', 'agent.cordis.yml')), '预设目录组合应生成')
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
    for (const template of ['pt-standard', 'pt-minimal', 'pt-ptc', 'pt-cordis']) {
      writePreset('', { ...makeOptions(presetDir), presetTemplate: template, injectPrompt: false })
      const configsDir = join(presetDir, template, 'prompt-configs')
      const names = readdirSync(configsDir)
      assert.deepEqual(names.filter((name) => name.includes('agents-file-')), [], `${template} 不应生成文件卡`)
      const presetYml = readFileSync(join(presetDir, template, 'preset.yml'), 'utf8')
      assert.ok(!presetYml.includes('agents-file-'), `${template} 的文件卡不得写进 preset.yml`)
    }
    writePreset('', { ...makeOptions(presetDir), presetTemplate: 'pt-custom', injectPrompt: false })
    assert.equal(readdirSync(join(presetDir, 'pt-custom', 'prompt-configs')).length, 0, 'custom 空白模板保持显式空组合')
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
      // B7 T3：这三个能力行已随模块删除、永远不该出现——负向断言保留（防渲染层又把它拼回来）。
      for (const id of ['context-gate', 'tool-bootstrap', 'promoted-code-mode']) {
        assert.equal(rows.some((row) => row?.id === id), false, `${template}: 不应追加 ${id}`)
      }
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
    assert.match(sub, /name: dsh-plugin-prompt-tool\/engine\/prompt-config-engine\.mjs/,
      '引擎引用插件包说明符（不再物化 .engine）')
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

test('writePreset 自动校验并装配 subagentToolPolicy，非法策略拒绝', () => {
  const dir = join(tmpdir(), `prompt-tool-spolicy-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    cpSync(join(ROOT, 'preset', 'pt-minimal'), join(presetDir, 'minimal'), { recursive: true })
    const presetFile = join(presetDir, 'minimal', 'preset.yml')
    const doc = parseDocument(readFileSync(presetFile, 'utf8'))
    doc.set('id', 'minimal')
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
      { '': 'x', guideText: 'v' },
      [{ id: 'a', variables: { '': '', keep: '1' } }],
    )
    const doc = parseYaml(readFileSync(join(presetDir, 'fixture', 'preset.yml'), 'utf8'))
    assert.equal(doc.params?.[''], undefined, 'params 空 key 不写入')
    assert.equal(doc.layerSettings['pre-step'].guideText, 'v', '有效引擎参数写入所属层')
    assert.equal(doc.promptConfigs[0]?.variables?.[''], undefined, '配置 variables 空 key 不写入')
    assert.equal(doc.promptConfigs[0]?.variables?.keep, '1', '有效变量保留')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('引擎参数仅进入组合配置，不成为模板变量', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-wp-paramkeys-'))
  try {
    // 复制夹具模板，params 加引擎参数键（模拟用户手写/UI 保存）。
    // B7 T3：原用例用的 promoteGate / bootstrapTools / messageSources / stagePreUnlock / stages
    // 已随七个专用能力删除，换成本批存活的引擎参数（模块行绑定 + 只进 layerSettings 的两种）。
    cpSync(FIXTURE_PRESET_SRC, join(dir, 'fixture'), { recursive: true })
    const presetFile = join(dir, 'fixture', 'preset.yml')
    const doc = parseDocument(readFileSync(presetFile, 'utf8'))
    doc.setIn(['layerSettings', 'tool-pipeline', 'toolGitBashEnabled'], false)
    doc.setIn(['layerSettings', 'tool-pipeline', 'strReplaceEditorMaxOutputChars'], 8000)
    doc.setIn(['layerSettings', 'tool-pipeline', 'customToolRequireApproval'], ['shell'])
    doc.get('modules', true).add('tool-config-engine')
    writeFileSync(presetFile, doc.toString(), 'utf8')

    writePreset('PROMPT', makeOptions(dir))

    const pcDir = join(dir, 'fixture', 'prompt-configs')
    const varsFile = join(pcDir, 'variables.yml')
    // 无内容变量（顶层 variables 段为空）时不生成 variables.yml；生成时不得含参数键。
    const vars = existsSync(varsFile) ? parseYaml(readFileSync(varsFile, 'utf8')) : {}
    // params 整段不作为变量源，引擎参数也不得混入 variables.yml。
    for (const key of ['toolGitBashEnabled', 'strReplaceEditorMaxOutputChars', 'customToolRequireApproval',
      // 锚定/引导内容键：writePreset 映射进 promptConfig.params，不得双落盘 variables.yml。
      'buildPattern', 'complexPattern', 'firstTurnBuild', 'firstTurnInspect', 'firstTurnDeep',
      'guideWeak', 'guideDeep']) {
      assert.equal(vars[key], undefined, `variables.yml 不得含参数键 ${key}`)
    }
    // 配置 params 同样不含。
    const configs = readdirSync(pcDir).filter((name) => name.endsWith('.yml') && name !== 'variables.yml')
    for (const name of configs) {
      const parsed = parseYaml(readFileSync(join(pcDir, name), 'utf8'))
      for (const key of ['toolGitBashEnabled', 'strReplaceEditorMaxOutputChars', 'customToolRequireApproval']) {
        assert.equal(parsed.params?.[key], undefined, `配置 params 不得含 ${key}`)
      }
    }
    // 参数桥落点：生成组合的对应模块行应含这些键（`module` 绑定声明生效）。
    // `str-replace-editor` 是 `filesystem-editor` 组行下的嵌套行，故按行 id 递归查找。
    const rows = parseYaml(readFileSync(join(dir, 'fixture', 'agent.cordis.yml'), 'utf8'))
    const flatten = (list) => list.flatMap((row) => [row, ...(Array.isArray(row?.config) ? flatten(row.config) : [])])
    const rowOf = (id) => flatten(rows).find((row) => row?.id === id)
    assert.equal(rowOf('tool-git-bash')?.config?.enabled, false, '参数桥把 toolGitBashEnabled 合并进 tool-git-bash 行')
    assert.equal(rowOf('str-replace-editor')?.config?.maxOutputChars, 8000,
      '参数桥把 strReplaceEditorMaxOutputChars 合并进 str-replace-editor 行（含 editor-default 投影）')
    assert.deepEqual(rowOf('tool-config-engine')?.config?.requireApproval, ['shell'],
      '参数桥把 customToolRequireApproval 合并进 tool-config-engine 行')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('layerSettings 模型参数：读取展平进运行时 params，保存仍按所属层落盘', () => {
  const dir = join(tmpdir(), `prompt-tool-modelseg-${process.pid}-${Date.now()}`)
  const presetDir = join(dir, 'preset')
  try {
    mkdirSync(join(presetDir, 'mseg'), { recursive: true })
    writeFileSync(join(presetDir, 'mseg', 'preset.yml'), [
      'id: mseg',
      'layerSettings:',
      '  agent-request:',
      '    modelProvider: deepseek-official',
      '    modelName: deepseek-v4-pro',
      '    modelMaxTokens: "32000"',
      '  subagent-start:',
      '    subagentModelProvider: p2',
      '  pre-step:',
      '    firstTurnAnchor: true',
      'promptConfigs: []',
    ].join('\n') + '\n', 'utf8')
    // 读取：层级段展平进 params 内部接口。
    const spec = loadPresetSpec(join(presetDir, 'mseg'))
    assert.equal(spec.params?.modelProvider, 'deepseek-official', 'agent-request.modelProvider → modelProvider')
    assert.equal(spec.params?.modelName, 'deepseek-v4-pro')
    assert.equal(spec.params?.modelMaxTokens, '32000')
    assert.equal(spec.params?.subagentModelProvider, 'p2')
    assert.equal(spec.params?.firstTurnAnchor, true, '非模型键保留')
    // 保存：全部引擎键都写入各自所属层。
    savePresetParams(presetDir, 'mseg', { modelTemperature: '0.8', firstTurnAnchor: false }, undefined)
    const doc = parseYaml(readFileSync(join(presetDir, 'mseg', 'preset.yml'), 'utf8'))
    assert.equal(doc.layerSettings['agent-request'].modelTemperature, '0.8')
    assert.equal(doc.params, undefined, '不产生旧 params 段')
    assert.equal(doc.layerSettings['pre-step'].firstTurnAnchor, false)
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
  const userMinimal = join(presetDir, 'pt-minimal')
  try {
    rmSync(userMinimal, { recursive: true, force: true })
    mkdirSync(userMinimal, { recursive: true })
    // 纯元数据副本：无 modules/params/promptConfigs，目录也无 agent.cordis.yml。
    writeFileSync(join(userMinimal, 'preset.yml'), 'name: 极简模式（旧）\ndescription: 旧版种子副本\norder: 3\n', 'utf8')
    const warnings = []
    writePreset('PROMPT', { ...makeOptions(presetDir), presetTemplate: 'pt-minimal', warn: (message) => warnings.push(message) })
    // 回退包内模板渲染成功：组合精确对齐官方 Minimal 基型。
    const cordis = readFileSync(join(userMinimal, 'agent.cordis.yml'), 'utf8')
    assert.deepEqual(parseYaml(cordis).map((row) => row.id), ['persona', 'persistent-shell', 'prompt-config-engine'])
    // 不回写用户参数源：没有迁移，modules 不落盘，用户命名与内容原样保留。
    const spec = parseYaml(readFileSync(join(userMinimal, 'preset.yml'), 'utf8'))
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
  const userPtc = join(presetDir, 'pt-ptc')
  try {
    mkdirSync(userPtc, { recursive: true })
    // 用户配置过（有 layerSettings 段）但不可渲染的副本
    writeFileSync(join(userPtc, 'preset.yml'), 'id: pt-ptc\nname: 用户改过的PTC\nlayerSettings:\n  pre-step:\n    injectPrompt: false\n', 'utf8')
    writePreset('PROMPT', { ...makeOptions(presetDir), presetTemplate: 'pt-ptc' })
    // 参数源未被包内模板覆盖。
    const spec = parseYaml(readFileSync(join(userPtc, 'preset.yml'), 'utf8'))
    assert.equal(spec.name, '用户改过的PTC', '用户命名保留')
    assert.equal(spec.layerSettings['pre-step'].injectPrompt, false, '用户参数保留（不升级不覆盖）')
    assert.ok(existsSync(join(userPtc, 'agent.cordis.yml')), '回退渲染仍产出组合')
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

// —— 由 writepreset-off.test.mjs 并入（2026-09-17 测试归一精简 Wave 2） ——
// 这两条走插件入口 apply()，需要一份 mock cordis ctx 与 settings 值；
// 命名带 Off 前缀，避免与上面的 makeOptions / 其它局部名混淆。

function offSettings(writePreset) {
  return {
    writePreset,
    presetTemplate: 'standard',
    skillOrder: [],
    skillsDirs: [],
    skillRankBase: 250,
    presetOrder: 5,
    fallbackText: '',
  }
}

function makeOffCtx() {
  const makeSctx = () => ({
    settings: {
      describe: () => [],
      configure: () => () => {},
      mutate: async () => {},
    },
    webServer: { register: () => () => {} },
    commands: { register: () => () => {} },
    tools: { register: () => () => {} },
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    on: () => () => {},
    get: () => undefined,
  })
  return {
    logger: { warn: () => {} },
    effect: (fn) => { fn(); return () => {} },
    // 真实 cordis Context 提供事件订阅；本 mock 只覆盖插件订阅的 provider 拓扑事件。
    on: () => () => {},
    skills: { registerProvider: () => {} },
    get: (name) => (name === 'webServer' ? {} : undefined),
    provide: () => () => {},
    baseUrl: 'http://localhost:3000',
    inject: (deps, cb) => { if (!deps.includes('agentPresets')) cb(makeSctx()); return () => {} },
  }
}

test('writePreset 关闭时清空组合为空数组，保留 preset.yml 与预设根（防误删回归 + 官方可挂载回归）', () => {
  const presetDir = join(home, '.agent-presets')
  // 本文件前序用例在同一 DSH_HOME 的预设根下留下了自己的产物（夹具预设 fixture、
  // 以及 root-isolation 等），而本用例对预设根做「恰好五个内置模板」的精确断言：
  // 清空预设根以恢复原用例的前置条件（原文件用的是全新 HOME），不放宽断言。
  rmSync(presetDir, { recursive: true, force: true })
  mkdirSync(join(presetDir, 'standard', 'prompt-configs'), { recursive: true })
  // 内置模板由 ensurePresetSeed 幂等补建，下面的目录断言把补建结果计入期望集合。
  writeFileSync(join(presetDir, 'standard', 'preset.yml'),
    'id: standard\nname: Standard\nmodules: [prompt-config-engine]\n', 'utf8')
  writeFileSync(join(presetDir, 'standard', 'agent.cordis.yml'),
    '- id: x\n  name: ./engine/x.mjs\n', 'utf8')
  writeFileSync(join(presetDir, 'standard', 'prompt-configs', '00-a.yml'), 'id: a\n', 'utf8')

  const value = offSettings(false)
  apply(makeOffCtx(value), Config(value))

  // 组合改写为空数组而非删除：官方 discovery 对缺 agent.cordis.yml 的目录仍占用
  // id 并判 broken（挂载抛 agent-preset/invalid、picker 丢弃该行），导致无法新建
  // 会话与无法切换预设；空组合零行可正常挂载，等价「停止注入」语义。
  const compositionFile = join(presetDir, 'standard', 'agent.cordis.yml')
  assert.equal(existsSync(compositionFile), true, 'agent.cordis.yml 应保留（空组合防 broken）')
  const composition = readFileSync(compositionFile, 'utf8')
  const rows = composition.split('\n').filter((line) => !line.startsWith('#') && line.trim().length > 0)
  assert.equal(rows.length > 0 && rows.every((line) => line.trim() === '[]'), true,
    '组合应为空数组（含注释头），实际为空组合')
  assert.equal(existsSync(join(presetDir, 'standard', 'prompt-configs')), false, 'prompt-configs 应被清理')
  // 参数源与预设根保留——绝不删除整个用户预设目录。
  assert.equal(existsSync(join(presetDir, 'standard', 'preset.yml')), true, 'preset.yml 参数必须保留')
  // ensurePresetSeed 会幂等补建全部内置预设目录，
  // 清理必须逐个保留其 preset.yml，不能删预设目录本身（防误删回归）。
  const dirs = readdirSync(presetDir).filter((name) => !name.startsWith('.')).sort()
  assert.deepEqual(dirs, ['pt-cordis', 'pt-custom', 'pt-minimal', 'pt-ptc', 'pt-standard', 'standard'].sort())
  for (const dir of dirs) {
    assert.equal(existsSync(join(presetDir, dir, 'preset.yml')), true, `${dir} 的 preset.yml 必须保留`)
    // 每个预设目录的组合都必须是空数组（关闭开关作用于全部预设，不只是激活预设）。
    const other = readFileSync(join(presetDir, dir, 'agent.cordis.yml'), 'utf8')
    const otherRows = other.split('\n').filter((line) => !line.startsWith('#') && line.trim().length > 0)
    assert.equal(otherRows.length > 0 && otherRows.every((line) => line.trim() === '[]'), true,
      `${dir} 的组合应为空数组`)
  }
})

test('writePreset 开启时不受影响：预设目录正常生成', () => {
  const presetDir = join(home, '.agent-presets')
  // 激活预设 id 用默认值 pt-standard（与插件默认 presetTemplate 同源）。
  mkdirSync(join(presetDir, 'pt-standard'), { recursive: true })
  writeFileSync(join(presetDir, 'pt-standard', 'preset.yml'),
    'id: pt-standard\nname: Standard\nmodules: [prompt-config-engine]\n', 'utf8')

  const value = offSettings(true)
  apply(makeOffCtx(value), Config(value))

  assert.equal(existsSync(join(presetDir, 'pt-standard', 'preset.yml')), true, 'writePreset=true 预设参数保留')
  const rows = readFileSync(join(presetDir, 'pt-standard', 'agent.cordis.yml'), 'utf8')
    .split('\n').filter((line) => !line.startsWith('#') && line.trim().length > 0)
  assert.equal(rows.length > 0 && rows.every((line) => line.trim() === '[]'), false,
    '重新开启后组合应恢复生成（不再停留在关闭期的空组合）')
})

test('writePreset：输出 id 保持调用方指定，不再运行时探测或改名', () => {
  const outputRoot = mkdtempSync(join(home, 'occupied-'))
  writePreset('', {
      ...makeOptions(outputRoot),
      presetTemplate: FIXTURE_PRESET_ID,
      outputId: 'standard',
    })
  assert.equal(existsSync(join(outputRoot, 'standard', 'agent.cordis.yml')), true)
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
