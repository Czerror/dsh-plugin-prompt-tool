import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts', 'migrate-presets.mjs')

function makePresetDir(home, name) {
  const dir = join(home, '.agent-presets', name)
  mkdirSync(dir, { recursive: true })
  return dir
}

test('migrate-presets：旧 worldBook/扁平模型键/旧参数别名/覆盖文件一次性迁移，写盘前备份', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-migrate-home-'))
  try {
    const dir = makePresetDir(home, 'beta')
    const before = [
      'id: beta',
      'name: Beta',
      'modules: [str-replace-editor, bootstrap-filesystem, str-replace-editor]',
      'params:',
      '  modelProvider: deepseek-official',
      '  modelName: deepseek-v4-pro',
      '  modelTemperature: "0.7"',
      '  guideComplexPattern: "old"',
      '  keepMe: v',
      'promptConfigs:',
      '  - id: keep-config',
      '    text: keep',
      '  - id: persona-main',
      '    layer: system-section',
      '    text: 主会话人设文本',
      '    params:',
      '      sectionName: deployment:persona',
      '      complete: true',
      '      suppressRuntimeContext: true',
      '  - id: persona-suffix',
      '    layer: system-section',
      '    text: 人设后缀文本',
      '    params:',
      '      sectionName: deployment:persona-suffix',
      '  - id: sub-persona',
      '    layer: system-section',
      '    audience: subagent',
      '    text: 子代理人设文本',
      '    params:',
      '      sectionName: deployment:persona-prefix',
      'worldBook:',
      '  injectMode: keyword',
      '  entries:',
      '    - id: wb-1',
      '      name: 世界书条目',
      '      text: 内容',
      '      keys: [foo]',
      '',
    ].join('\n')
    writeFileSync(join(dir, 'preset.yml'), before, 'utf8')
    writeFileSync(join(dir, 'prompt-tool.overrides.yml'), 'firstTurnAnchor: true\n', 'utf8')

    const output = execFileSync(process.execPath, [SCRIPT], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' })
    assert.match(output, /1 migrated/)
    assert.match(output, /personaCard=2 subagentPersona=1/)

    const doc = readFileSync(join(dir, 'preset.yml'), 'utf8')
    // 扁平模型键迁移为顶层段，旧别名删除。
    assert.match(doc, /model:\n\s+provider: deepseek-official/)
    assert.match(doc, /name: deepseek-v4-pro/)
    assert.match(doc, /temperature: "0\.7"/)
    assert.doesNotMatch(doc, /guideComplexPattern/)
    assert.match(doc, /keepMe: v/, '无关参数保留')
    // worldBook 段删除并转为 promptConfigs。
    assert.doesNotMatch(doc, /worldBook:/)
    assert.match(doc, /strategy: world-book/)
    assert.match(doc, /id: keep-config/, '已有 promptConfigs 应保留')
    // 旧 persona 卡合并为顶层 persona 段；子代理卡进 tool-subagent.persona（运行时不再兼容）。
    assert.match(doc, /persona:\n\s+suffix: 人设后缀文本\n\s+prefix: 主会话人设文本\n\s+complete: true\n\s+includeRuntimeContext: false/)
    assert.match(doc, /tool-subagent:\n\s+persona: 子代理人设文本/)
    assert.doesNotMatch(doc, /id: persona-main/)
    assert.doesNotMatch(doc, /id: persona-suffix/)
    assert.doesNotMatch(doc, /id: sub-persona/)
    assert.doesNotMatch(doc, /sectionName:/)
    // 覆盖文件并入后归档 .bak。
    assert.match(doc, /firstTurnAnchor: true/)
    assert.match(doc, /modules:\n\s+- bootstrap-filesystem/)
    assert.doesNotMatch(doc, /str-replace-editor/)
    assert.equal(existsSync(join(dir, 'prompt-tool.overrides.yml')), false, '覆盖文件已归档')
    assert.ok(readdirSync(dir).some((name) => name.startsWith('preset.yml.bak-')), 'preset.yml 写盘前有备份')
    assert.equal(readdirSync(dir).some((name) => name.includes('.tmp-')), false, '原子写盘临时文件应清理')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('migrate-presets：dry-run 不写盘；无迁移目标零操作退出 0', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-migrate-home-'))
  try {
    const dir = makePresetDir(home, 'beta')
    writeFileSync(join(dir, 'preset.yml'), 'id: beta\nparams:\n  keepMe: v\n', 'utf8')
    const output = execFileSync(process.execPath, [SCRIPT, '--dry-run'], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' })
    assert.match(output, /0 migrated/)
    assert.equal(readFileSync(join(dir, 'preset.yml'), 'utf8'), 'id: beta\nparams:\n  keepMe: v\n', 'dry-run 不写盘')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('migrate-presets：旧 persona 卡合并为顶层 persona 段并保留注释', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-migrate-home-'))
  try {
    const dir = makePresetDir(home, 'gamma')
    writeFileSync(join(dir, 'preset.yml'), [
      'id: gamma',
      '# 保留注释',
      'promptConfigs:',
      '  - id: persona-main',
      '    params:',
      '      sectionName: deployment:persona',
      '    text: 人设文本',
      '',
    ].join('\n'), 'utf8')
    const output = execFileSync(process.execPath, [SCRIPT], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' })
    assert.match(output, /personaCard=1 subagentPersona=0/)
    const doc = readFileSync(join(dir, 'preset.yml'), 'utf8')
    assert.match(doc, /# 保留注释/, '未知注释保留')
    assert.match(doc, /persona:\n\s+prefix: 人设文本/)
    assert.doesNotMatch(doc, /persona-main/)
    assert.doesNotMatch(doc, /sectionName:/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('migrate-presets：多张无文本旧 persona 卡全部删除，不写空 persona 段', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-migrate-home-'))
  try {
    const dir = makePresetDir(home, 'empty-persona')
    writeFileSync(join(dir, 'preset.yml'), [
      'id: empty-persona',
      'promptConfigs:',
      '  - id: old-persona',
      '    layer: system-section',
      '    params:',
      '      sectionName: deployment:persona',
      '  - id: bare-persona',
      '    layer: system-section',
      '    params:',
      '      sectionName: persona',
      '  - id: keep-config',
      '    text: keep',
      '',
    ].join('\n'), 'utf8')
    const output = execFileSync(process.execPath, [SCRIPT], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' })
    assert.match(output, /personaCard=0 subagentPersona=0/)
    const doc = readFileSync(join(dir, 'preset.yml'), 'utf8')
    assert.doesNotMatch(doc, /sectionName: '?deployment:persona'?\s*$/m)
    assert.doesNotMatch(doc, /sectionName: '?persona'?\s*$/m)
    assert.doesNotMatch(doc, /^persona:/m, '空文本卡不写空 persona 段')
    assert.match(doc, /id: keep-config/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('migrate-presets：texts 数组形态旧 persona 卡迁进顶层 persona 段，不丢文本', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-migrate-home-'))
  try {
    const dir = makePresetDir(home, 'texts-persona')
    writeFileSync(join(dir, 'preset.yml'), [
      'id: texts-persona',
      'promptConfigs:',
      '  - id: persona-main',
      '    layer: system-section',
      '    strategy: static',
      '    texts:',
      '      - 第一段人设',
      '      - 第二段人设',
      '    params:',
      '      sectionName: deployment:persona-prefix',
      '      complete: true',
      '      suppressRuntimeContext: true',
      '  - id: keep-config',
      '    text: keep',
      '',
    ].join('\n'), 'utf8')
    const output = execFileSync(process.execPath, [SCRIPT], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' })
    assert.match(output, /personaCard=1 subagentPersona=0/)
    const doc = readFileSync(join(dir, 'preset.yml'), 'utf8')
    assert.match(doc, /^persona:/m, 'texts 卡必须写出顶层 persona 段')
    assert.match(doc, /第一段人设/)
    assert.match(doc, /第二段人设/)
    assert.match(doc, /complete: true/)
    assert.match(doc, /includeRuntimeContext: false/)
    assert.doesNotMatch(doc, /persona-main/)
    assert.match(doc, /id: keep-config/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('migrate-presets：坏 YAML 非零退出且保留原文件', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-migrate-bad-'))
  try {
    const dir = makePresetDir(home, 'broken')
    const original = 'id: broken\nworldBook: [unclosed\n'
    writeFileSync(join(dir, 'preset.yml'), original, 'utf8')
    assert.throws(
      () => execFileSync(process.execPath, [SCRIPT], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' }),
      (error) => error.status !== 0,
    )
    assert.equal(readFileSync(join(dir, 'preset.yml'), 'utf8'), original, '坏 YAML 不写盘不动原文件')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('migrate-presets：旧版合并单段 persona 拆回官方 suffix/prefix 两键（suffix 在上）', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-migrate-merged-'))
  try {
    const dir = makePresetDir(home, 'merged-persona')
    writeFileSync(join(dir, 'preset.yml'), [
      'id: merged-persona',
      'persona:',
      '  prefix: You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.',
      'params:',
      '  keepMe: v',
      '',
    ].join('\n'), 'utf8')
    const output = execFileSync(process.execPath, [SCRIPT], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' })
    assert.match(output, /personaMerge=1/)
    const doc = readFileSync(join(dir, 'preset.yml'), 'utf8')
    assert.match(
      doc,
      /persona:\n\s+suffix: Your working directory is \{\{cwd\}\}\.\n\s+prefix: You are a coding agent powered by the \{\{model\}\} model\./,
      'suffix 在上、prefix 在下，且合并文本已拆开',
    )
    assert.match(doc, /keepMe: v/, '无关字段保留')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('migrate-presets：多段合并 persona 只摘 suffix 句，其余段落保留', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-migrate-merged-multi-'))
  try {
    const dir = makePresetDir(home, 'merged-multi')
    writeFileSync(join(dir, 'preset.yml'), [
      'id: merged-multi',
      'persona:',
      '  prefix: |-',
      '    You are a coding agent powered by the {{model}} model, running on the DeepSeek Harness. Your working directory is {{cwd}}.',
      '',
      '    You can read and modify the harness you run on.',
      '',
    ].join('\n'), 'utf8')
    const output = execFileSync(process.execPath, [SCRIPT], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' })
    assert.match(output, /personaMerge=1/)
    const doc = readFileSync(join(dir, 'preset.yml'), 'utf8')
    assert.match(doc, /suffix: Your working directory is \{\{cwd\}\}\./)
    assert.match(doc, /You are a coding agent powered by the \{\{model\}\} model, running on the\s+DeepSeek Harness\./)
    assert.doesNotMatch(doc, /Harness\. Your working directory/, 'suffix 句已从 prefix 摘出')
    assert.match(doc, /You can read and modify the harness you run on\./, '其余段落保留')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('migrate-presets：不含库行默认 suffix 的自定义 persona 原样保留', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-migrate-merged-keep-'))
  try {
    const dir = makePresetDir(home, 'custom-persona')
    const original = 'id: custom-persona\npersona:\n  prefix: 自定义人设文本。\n'
    writeFileSync(join(dir, 'preset.yml'), original, 'utf8')
    const output = execFileSync(process.execPath, [SCRIPT], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' })
    assert.match(output, /0 migrated/)
    assert.equal(readFileSync(join(dir, 'preset.yml'), 'utf8'), original)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
