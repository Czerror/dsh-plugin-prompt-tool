import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'

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

test('rematerialize-presets：旧 persona 卡迁移 + 组合/配置/共享引擎重新物化', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-remat-'))
  try {
    const dir = seedPreset(home, 'minimal')
    // 还原旧版形态：顶层 persona 段 → 旧 persona-main 卡。
    const doc = parseDocument(readFileSync(join(dir, 'preset.yml'), 'utf8'))
    doc.delete('persona')
    doc.set('promptConfigs', [{
      id: 'persona-main',
      layer: 'system-section',
      text: '迁移后人设',
      params: { sectionName: 'deployment:persona-prefix' },
    }])
    writeFileSync(join(dir, 'preset.yml'), doc.toString(), 'utf8')
    // 旧产物残留：旧版生成的 persona 配置卡文件必须被重新物化清掉。
    mkdirSync(join(dir, 'prompt-configs'), { recursive: true })
    writeFileSync(join(dir, 'prompt-configs', '0040-persona-main.yml'), 'id: persona-main\n', 'utf8')

    const output = run(home)
    assert.match(output, /1 materialized/)
    assert.match(output, /0 failed/)

    const yml = readFileSync(join(dir, 'preset.yml'), 'utf8')
    assert.match(yml, /persona:\n\s+prefix: 迁移后人设/, '旧卡合并为顶层 persona 段')
    assert.doesNotMatch(yml, /persona-main/, '旧卡已删除')
    const composition = readFileSync(join(dir, 'agent.cordis.yml'), 'utf8')
    assert.match(composition, /# prompt-tool:render v/, '组合带 render 版本戳')
    assert.match(composition, /dsh-persona/)
    assert.match(composition, /迁移后人设/, '顶层 persona 段注入官方 persona 行')
    assert.ok(existsSync(join(home, '.agent-presets', '.engine', '.pt-engine-fingerprint')), '共享引擎已物化')
    assert.equal(
      readdirSync(join(dir, 'prompt-configs')).some((name) => name.includes('persona-main')),
      false,
      '旧 persona 配置卡产物已清理',
    )
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
