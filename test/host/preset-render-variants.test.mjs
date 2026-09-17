// 合并自 builtin-presets-parity.test.mjs(7) + persona-render.test.mjs(4) + official-preset.test.mjs(3)
//（2026-09-17 测试归一精简 Wave 2）。三份共用同一隔离 DSH_HOME：原本静态 import lib 的
// builtin-presets-parity 改为在隔离 HOME 下动态 import（它只吃显式 dir，不读 DSH_HOME，语义等价）；
// official-preset 的三个子进程用例各自建自己的临时 HOME，不受顶层 HOME 影响。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'

// 隔离 DSH_HOME：lib/index.mjs 顶层解析默认预设根，不能读到真实用户目录。
const home = mkdtempSync(join(tmpdir(), 'pt-preset-render-'))
process.env.DSH_HOME = home
const root = fileURLToPath(new URL('../..', import.meta.url))
const libUrl = new URL('../../lib/index.mjs', import.meta.url).href
const { loadPresetSpec, removePresetModule, renderComposition } = await import('../../lib/index.mjs')
test.after(() => rmSync(home, { recursive: true, force: true }))

// —— 内置基型对齐官方预设（原 builtin-presets-parity.test.mjs） ——

function rowsOf(id) {
  const dir = join(root, 'preset', id)
  return parse(renderComposition(loadPresetSpec(dir), {}, dir), { logLevel: 'silent' })
}

const idsOf = (rows) => rows.map((row) => row.id)

test('内置预设集合移除 liangshen 与 anchored，保留四个官方基型 + custom', () => {
  const dirs = readdirSync(join(root, 'preset'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  assert.deepEqual(dirs, ['creative', 'custom', 'minimal', 'ptc', 'standard'])
  assert.equal(existsSync(join(root, 'preset', 'liangshen')), false)
  assert.equal(existsSync(join(root, 'preset', 'anchored')), false, 'anchored 预设已下线，不再随包分发')
})

test('standard 对齐官方 Standard，以官方 dsh-persona 行承载人设', () => {
  const ids = idsOf(rowsOf('standard'))
  assert.deepEqual(ids, [
    'persona', 'agent-instructions', 'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search',
    'tool-jobs', 'skill-filesystem', 'tool-skill', 'command-goal', 'tool-goal',
    'planning', 'compaction', 'delegation', 'tool-ask-user', 'tool-todo', 'tool-web', 'present', 'prompt-config-engine',
  ])
})

test('rc.2 新增 present 行：standard / ptc / creative 按官方层内顺序覆盖，minimal 不含', () => {
  assert.deepEqual(idsOf(rowsOf('standard')).slice(-2), ['present', 'prompt-config-engine'])
  assert.deepEqual(idsOf(rowsOf('ptc')).slice(-2), ['present', 'prompt-config-engine'])
  assert.deepEqual(idsOf(rowsOf('creative')).slice(-2), ['present', 'prompt-config-engine'])
  assert.equal(idsOf(rowsOf('minimal')).includes('present'), false, 'minimal 基型没有 present 行')
})

test('ptc 使用官方 alpha.4 呈现与 delegation 变体，不重复挂 promoted-code-mode', () => {
  const rows = rowsOf('ptc')
  const ids = idsOf(rows)
  assert.deepEqual(ids, [
    'persona', 'agent-instructions', 'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search',
    'tool-jobs', 'skill-filesystem', 'tool-skill', 'command-goal', 'tool-goal',
    'planning', 'compaction', 'delegation', 'tool-ask-user', 'tool-todo', 'tool-web',
    'tool-presentation', 'present', 'prompt-config-engine',
  ])
  const presentation = rows.find((row) => row.id === 'tool-presentation')
  assert.equal(presentation.config.mode, 'ptc')
  assert.equal(ids.includes('promoted-code-mode'), false, '官方 tool-presentation 已承担 PTC 呈现，不重复注册')
  const delegation = rows.find((row) => row.id === 'delegation')
  assert.equal(delegation.config.find((row) => row.id === 'tool-workflow').disabled, true)
})

test('creative 基础行顺序对齐官方 Cordis，但不再复制 tool-cordis（避免全局 provider 重复注册）', () => {
  const ids = idsOf(rowsOf('creative'))
  assert.deepEqual(ids, [
    'persona', 'agent-instructions', 'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search',
    'tool-jobs', 'command-goal', 'tool-goal', 'planning', 'compaction', 'delegation',
    'tool-ask-user', 'tool-todo', 'tool-web', 'skill-filesystem', 'tool-skill', 'present', 'prompt-config-engine',
  ])
  assert.ok(!ids.includes('tool-cordis'), 'tool-cordis 由官方 shipped「创造模式」(cordis) 预设提供')
  const skill = readFileSync(join(root, 'preset/creative/skills/editing-cordis-compositions/SKILL.md'), 'utf8')
  assert.match(skill, /supplies `standard`, `ptc`, `minimal`, and `cordis`/)
  assert.doesNotMatch(skill, /supplies `standard`, `code`, `minimal`/)
})

test('minimal 对齐 rc.2 单 shell 基型，以顶层 persona 段驱动官方 dsh-persona 行', () => {
  const rows = rowsOf('minimal')
  const ids = idsOf(rows)
  assert.deepEqual(ids, ['persona', 'persistent-shell', 'prompt-config-engine'])
  const spec = loadPresetSpec(join(root, 'preset', 'minimal'))
  assert.equal(spec.persona.prefix, 'You are a helpful software engineer assistant.')
  assert.equal(spec.persona.complete, true)
  assert.equal(spec.persona.includeRuntimeContext, false)
  const row = rows.find((item) => item.id === 'persona')
  assert.equal(row.name, '@deepseek-ai/dsh-persona')
  assert.deepEqual(row.config, {
    prefix: 'You are a helpful software engineer assistant.',
    complete: true,
    includeRuntimeContext: false,
  })
})

test('官方基型不默认装配 ST 管理工具与自定义工具引擎', () => {
  const ids = idsOf(rowsOf('standard'))
  for (const id of ['character-tools', 'world-book-tools', 'session-var-tools', 'tool-config-engine']) {
    assert.equal(ids.includes(id), false, `官方基型不应默认装配 ST 工具 ${id}`)
  }
})

// —— 人设渲染与模块移除（原 persona-render.test.mjs） ——

test('renderComposition：人设直接来自预设字段，不存在 persona 模块入口', () => {
  const persona = { prefix: 'USER PERSONA', suffix: 'USER SUFFIX', complete: true, includeRuntimeContext: false }
  const spec = { id: 'st-style', modules: [], persona }
  const rows = parse(renderComposition(spec, {}))
  assert.deepEqual(rows, [{ id: 'persona', name: '@deepseek-ai/dsh-persona', config: persona }])
  assert.deepEqual(spec.modules, [], '渲染不向预设模块清单补回 persona')
  assert.deepEqual(parse(renderComposition({ id: 'empty', modules: [] }, {})), [])
  assert.throws(() => renderComposition({ id: 'old-module', modules: ['persona'] }, {}), /persona.*not found/)
})

test('renderComposition：已撤销模块名全部拒绝，不补别名或改写模块清单', () => {
  const removed = ['persona', 'official-agent-instructions', 'official-tool-bash', 'official-tool-skill',
    'official-persistent-shell', 'official-tool-presentation', 'official-tool-cordis',
    'official-skill-filesystem-cordis', 'present', 'bootstrap-filesystem', 'custom-bash',
    'code-presentation', 'cot-drip', 'str-replace-editor']
  for (const name of removed) {
    const spec = { id: 'obsolete', modules: [name] }
    assert.throws(() => renderComposition(spec, {}), /composition module .* not found/, name)
    assert.deepEqual(spec.modules, [name], '不迁移调用者的模块清单')
  }
})

test('renderComposition：空人设不继承标准库默认文本，ST 段保持开放', () => {
  const rows = parse(renderComposition({ id: 'st', modules: ['prompt-config-engine'], persona: { prefix: '', complete: false } }, {}))
  assert.equal(rows.filter((row) => row.name === '@deepseek-ai/dsh-persona').length, 1)
  assert.deepEqual(rows[0].config, { prefix: '' })
})

test('removePresetModule：从 modules 清单移除模块并保留其余字段与注释', () => {
  const dir = join(home, '.agent-presets', 'sample')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'preset.yml'), [
    '# 用户注释',
    'name: 样例',
    'modules:',
    '  - keep-a',
    '  - tool-cordis',
    '  - keep-b',
    'params:',
    '  maxDepth: ""',
    '',
  ].join('\n'))
  assert.equal(removePresetModule(dir, 'tool-cordis'), true)
  const out = readFileSync(join(dir, 'preset.yml'), 'utf8')
  assert.doesNotMatch(out, /tool-cordis/)
  assert.match(out, /# 用户注释/)
  assert.match(out, /keep-a/)
  assert.match(out, /keep-b/)
  assert.match(out, /maxDepth/)
  assert.equal(removePresetModule(dir, 'tool-cordis'), false, '重复调用应为 no-op')
})

// —— 官方格式预设与本地模块（原 official-preset.test.mjs） ——

/** 子进程隔离验证：官方格式预设（preset.yml 仅元数据 + agent.cordis.yml）导入后可用。 */
test('官方格式预设：无 id 回退目录名，无 modules/composition 回退 agent.cordis.yml 渲染', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-official-'))
  try {
    // 构造官方格式预设（preset.yml 无 id；组合文件在预设目录）。
    const presetDir = join(home, '.agent-presets', 'official-demo')
    mkdirSync(presetDir, { recursive: true })
    writeFileSync(join(presetDir, 'preset.yml'), [
      'name: 官方格式演示',
      'description: preset.yml 仅元数据',
      'order: 7',
      '',
    ].join('\n'), 'utf8')
    writeFileSync(join(presetDir, 'agent.cordis.yml'), [
      '- id: demo-row',
      "  name: '@deepseek-ai/dsh-demo'",
      '',
    ].join('\n'), 'utf8')
    // 官方格式预设可引用模板目录内的本地模块（./xxx.mjs 相对路径）。
    writeFileSync(join(presetDir, 'demo-local.mjs'), 'export function apply() {}\n', 'utf8')

    const script = `
      import { readFileSync, existsSync } from 'node:fs'
      import { join } from 'node:path'
      const { listPresets, writePreset, resolvePresetDir } = await import(${JSON.stringify(libUrl)})
      const found = listPresets().find((p) => p.id === 'official-demo')
      if (!found) throw new Error('official-demo 未出现在预设清单')
      if (found.name !== '官方格式演示') throw new Error('name 读取错误')
      if (!resolvePresetDir('official-demo').includes('.agent-presets')) throw new Error('resolvePresetDir 未指向预设根')
      const gen = join(process.env.DSH_HOME, '.agent-presets')
      writePreset('PROMPT', {
        presetDir: gen, presetTemplate: 'official-demo', presetOrder: 7,
        firstTurnAnchor: false, firstTurnText: '', firstTurnCustom: false,
        guideText: '', guideCustom: false, injectPrompt: true,
        modelProvider: '', subagentModelProvider: '', subagentModelName: '', modelName: '',
        bootstrapMaxTokens: 0, usePtcMode: true,
        promptConfigs: [],
      })
      const cordis = readFileSync(join(gen, 'official-demo', 'agent.cordis.yml'), 'utf8')
      if (!cordis.includes('demo-row')) throw new Error('组合未回退 agent.cordis.yml')
      if (/__[A-Za-z0-9_]+__/.test(cordis)) throw new Error('存在未解析 token')
      if (!existsSync(join(gen, 'official-demo', 'demo-local.mjs'))) throw new Error('模板目录本地模块未复制到生成目录')
      console.log('OK')
    `
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, DSH_HOME: home },
      encoding: 'utf8',
    })
    if (res.status !== 0) throw new Error(`probe failed: ${res.stderr || res.stdout}`)
    assert.match(res.stdout, /OK/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

/** filesystem-editor 内嵌编辑器参数化：params 覆盖默认 16000，嵌套 row 不改名。 */
test('本地 filesystem-editor 行：装配嵌套编辑器并覆盖 maxOutputChars', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-editor-param-'))
  try {
    const presetDir = join(home, '.agent-presets', 'editor-param')
    mkdirSync(presetDir, { recursive: true })
    writeFileSync(join(presetDir, 'preset.yml'), [
      'id: editor-param',
      'name: 编辑器参数覆盖',
      'modules:',
      '  - filesystem-editor',
      '  - prompt-config-engine',
      'params:',
      '  strReplaceEditorMaxOutputChars: 32000',
      '',
    ].join('\n'), 'utf8')

    const script = `
      import { readFileSync } from 'node:fs'
      import { join } from 'node:path'
      const { writePreset } = await import(${JSON.stringify(libUrl)})
      const gen = join(process.env.DSH_HOME, '.agent-presets')
      writePreset('PROMPT', {
        presetDir: gen, presetTemplate: 'editor-param', presetOrder: 1,
        firstTurnAnchor: false, firstTurnText: '', firstTurnCustom: false,
        guideText: '', guideCustom: false, injectPrompt: true,
        modelProvider: '', subagentModelProvider: '', subagentModelName: '', modelName: '',
        bootstrapMaxTokens: 0, usePtcMode: true,
        promptConfigs: [],
      })
      const cordis = readFileSync(join(gen, 'editor-param', 'agent.cordis.yml'), 'utf8')
      if (!cordis.includes('maxOutputChars: 32000')) throw new Error('params 覆盖未生效: ' + cordis)
      if (/__[A-Za-z0-9_]+__/.test(cordis)) throw new Error('存在未解析 token')
      console.log('OK')
    `
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, DSH_HOME: home },
      encoding: 'utf8',
    })
    if (res.status !== 0) throw new Error(`probe failed: ${res.stderr || res.stdout}`)
    assert.match(res.stdout, /OK/)
    const rows = parse(readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8'))
    assert.deepEqual(rows.map((row) => row.id), ['filesystem-editor', 'prompt-config-engine'])
    assert.equal(rows[0].group, true)
    assert.deepEqual(rows[0].isolate, { fs: true })
    assert.deepEqual(rows[0].config.map((row) => row.id), ['fs-local', 'str-replace-editor'])
    assert.equal(rows[0].config[1].name, '@deepseek-ai/dsh-tool-str-replace-editor')
    assert.equal(rows[0].config[1].config.maxOutputChars, 32000)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('旧 str-replace-editor 模块名明确拒绝，不归一也不改写预设', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-editor-alias-'))
  try {
    const presetDir = join(home, '.agent-presets', 'editor-alias')
    mkdirSync(presetDir, { recursive: true })
    writeFileSync(join(presetDir, 'preset.yml'), [
      'id: editor-alias',
      'name: 旧编辑器别名',
      'modules:',
      '  - str-replace-editor',
      '  - prompt-config-engine',
      '',
    ].join('\n'), 'utf8')
    const before = readFileSync(join(presetDir, 'preset.yml'), 'utf8')

    const script = `
      import assert from 'node:assert/strict'
      import { join } from 'node:path'
      const { writePreset } = await import(${JSON.stringify(libUrl)})
      const gen = join(process.env.DSH_HOME, '.agent-presets')
      assert.throws(() => writePreset('PROMPT', {
        presetDir: gen, presetTemplate: 'editor-alias', presetOrder: 1,
        firstTurnAnchor: false, firstTurnText: '', firstTurnCustom: false,
        guideText: '', guideCustom: false, injectPrompt: true,
        modelProvider: '', subagentModelProvider: '', subagentModelName: '', modelName: '',
        bootstrapMaxTokens: 0, usePtcMode: true, promptConfigs: [],
      }), /composition module str-replace-editor not found/)
      console.log('OK')
    `
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, DSH_HOME: home },
      encoding: 'utf8',
    })
    if (res.status !== 0) throw new Error(`probe failed: ${res.stderr || res.stdout}`)
    assert.match(res.stdout, /OK/)
    assert.equal(readFileSync(join(presetDir, 'preset.yml'), 'utf8'), before)
    assert.equal(existsSync(join(presetDir, 'agent.cordis.yml')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
