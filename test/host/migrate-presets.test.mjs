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
