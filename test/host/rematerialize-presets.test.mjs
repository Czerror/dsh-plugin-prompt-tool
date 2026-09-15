import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml, parseDocument } from 'yaml'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts', 'rematerialize-presets.mjs')

function run(home, ...extra) {
  return execFileSync(process.execPath, [SCRIPT, '--dsh-home', home, ...extra], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home },
  })
}

/** 用包内模板播种一个插件格式用户预设目录。 */
function seedPreset(home, name, template = 'minimal') {
  const dir = join(home, '.agent-presets', name)
  mkdirSync(dir, { recursive: true })
  cpSync(join(ROOT, 'preset', template), dir, { recursive: true })
  return dir
}

test('rematerialize-presets：按当前 preset.yml 重新物化组合与共享引擎', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-remat-'))
  try {
    const dir = seedPreset(home, 'minimal')
    const output = run(home)
    assert.match(output, /1 materialized/)
    assert.match(output, /0 failed/)

    const composition = readFileSync(join(dir, 'agent.cordis.yml'), 'utf8')
    assert.match(composition, /# prompt-tool:render v/, '组合带 render 版本戳')
    assert.ok(Array.isArray(parseYaml(composition)), '组合是 YAML 数组')
    assert.ok(existsSync(join(home, '.agent-presets', '.engine', '.pt-engine-fingerprint')), '共享引擎已物化')
    assert.ok(existsSync(join(dir, 'prompt-configs')), '提示词配置目录已物化')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('rematerialize-presets：手写/官方格式预设（无 modules/params）跳过，不覆盖组合', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-remat-'))
  try {
    const dir = join(home, '.agent-presets', 'liangshen')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'preset.yml'), 'name: 梁神模式\ndescription: 手写预设\norder: 9\n', 'utf8')
    const composition = '# hand-written composition\n[]\n'
    writeFileSync(join(dir, 'agent.cordis.yml'), composition, 'utf8')

    const output = run(home)
    assert.match(output, /1 skipped/)
    assert.equal(readFileSync(join(dir, 'agent.cordis.yml'), 'utf8'), composition, '手写组合不被覆盖')
    assert.match(readFileSync(join(dir, 'preset.yml'), 'utf8'), /手写预设/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('rematerialize-presets：dry-run 只报告不写盘', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-remat-'))
  try {
    const dir = seedPreset(home, 'minimal')
    const before = readFileSync(join(dir, 'preset.yml'), 'utf8')
    const output = run(home, '--dry-run')
    assert.match(output, /dry-run/)
    assert.match(output, /would materialize minimal/)
    assert.equal(readFileSync(join(dir, 'preset.yml'), 'utf8'), before, 'dry-run 不写 preset.yml')
    assert.equal(existsSync(join(dir, 'agent.cordis.yml')), false, 'dry-run 不生成组合')
    assert.equal(existsSync(join(home, '.agent-presets', '.engine')), false, 'dry-run 不物化引擎')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('rematerialize-presets：引擎参数按 preset.yml 解析，不回落 writePreset 默认值', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-remat-'))
  try {
    const dir = seedPreset(home, 'anchored', 'anchored')
    const doc = parseDocument(readFileSync(join(dir, 'preset.yml'), 'utf8'))
    doc.setIn(['params', 'firstTurnAnchor'], true)
    doc.setIn(['params', 'injectPrompt'], false)
    writeFileSync(join(dir, 'preset.yml'), doc.toString(), 'utf8')

    const output = run(home)
    assert.match(output, /1 materialized/)
    const configs = join(dir, 'prompt-configs')
    assert.match(readFileSync(join(configs, '0000-near-anchor.yml'), 'utf8'), /enabled: true/)
    assert.match(readFileSync(join(configs, '0020-prompt-injector.yml'), 'utf8'), /enabled: false/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('rematerialize-presets：预设内嵌 skills 漂移只报告，不覆盖本机副本', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-remat-'))
  try {
    const dir = seedPreset(home, 'creative', 'creative')
    const skill = join(dir, 'skills', 'editing-cordis-compositions', 'SKILL.md')
    assert.ok(existsSync(skill), '模板自带预设内嵌技能')
    writeFileSync(skill, '本机改动\n', 'utf8')

    const output = run(home)
    assert.match(output, /stale skills creative/, '漂移必须被报告')
    assert.match(output, /1 stale skills/)
    assert.equal(readFileSync(skill, 'utf8'), '本机改动\n', '默认不得覆盖用户副本')
    assert.equal(readdirSync(dir).filter((name) => name.startsWith('skills.bak-')).length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('rematerialize-presets：--refresh-skills 先备份再按包内模板刷新', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-remat-'))
  try {
    const dir = seedPreset(home, 'creative', 'creative')
    const skill = join(dir, 'skills', 'editing-cordis-compositions', 'SKILL.md')
    const packaged = readFileSync(skill, 'utf8')
    writeFileSync(skill, '本机改动\n', 'utf8')

    const output = run(home, '--refresh-skills')
    assert.match(output, /refreshed skills creative/)
    assert.equal(readFileSync(skill, 'utf8'), packaged, '按包内模板刷新')
    const backups = readdirSync(dir).filter((name) => name.startsWith('skills.bak-'))
    assert.equal(backups.length, 1, '原副本先备份为 skills.bak-<时间戳>')
    assert.equal(readFileSync(join(dir, backups[0], 'editing-cordis-compositions', 'SKILL.md'), 'utf8'), '本机改动\n',
      '备份保留本机改动')

    const second = run(home)
    assert.match(second, /0 stale skills/, '刷新后不再报告漂移')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
