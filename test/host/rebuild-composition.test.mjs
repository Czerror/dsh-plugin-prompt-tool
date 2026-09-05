import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const UPSTREAM = join(ROOT, '..', 'deepseek-harness')
const SCRIPT = join(ROOT, 'scripts', 'rebuild-composition.mjs')

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pt-rebuild-composition-'))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  cpSync(SCRIPT, join(root, 'scripts', 'rebuild-composition.mjs'))
  cpSync(join(ROOT, 'engine', 'compositions'), join(root, 'engine', 'compositions'), { recursive: true })
  cpSync(join(ROOT, 'preset'), join(root, 'preset'), { recursive: true })
  cpSync(join(ROOT, 'node_modules', 'yaml'), join(root, 'node_modules', 'yaml'), { recursive: true })
  return root
}

function upstreamFixture(root) {
  const target = join(root, 'upstream')
  const source = join(UPSTREAM, 'packages', 'preset', 'agent-presets', 'presets')
  mkdirSync(join(target, 'packages', 'preset', 'agent-presets'), { recursive: true })
  cpSync(source, join(target, 'packages', 'preset', 'agent-presets', 'presets'), { recursive: true })
  return target
}

function run(root, upstream) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'rebuild-composition.mjs'), upstream], {
    cwd: root,
    encoding: 'utf8',
  })
}

test('rebuild-composition：动态发现官方预设并拒绝缺行、重复和乱序', () => {
  const root = fixture()
  try {
    const upstream = upstreamFixture(root)
    const first = run(root, upstream)
    assert.equal(first.status, 0, first.stderr || first.stdout)

    const file = join(root, 'preset', 'standard', 'preset.yml')
    const original = readFileSync(file, 'utf8')
    writeFileSync(file, original.replace('  - tool-web\n', ''), 'utf8')
    const missing = run(root, upstream)
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr + missing.stdout, /modules do not match official standard order/)

    writeFileSync(file, original.replace('  - tool-web\n', '  - tool-web\n  - tool-web\n'), 'utf8')
    const duplicate = run(root, upstream)
    assert.notEqual(duplicate.status, 0)
    assert.match(duplicate.stderr + duplicate.stdout, /duplicate modules: tool-web/)

    writeFileSync(file, original.replace('  - tool-web\n  - prompt-config-engine\n', '  - prompt-config-engine\n  - tool-web\n'), 'utf8')
    const reordered = run(root, upstream)
    assert.notEqual(reordered.status, 0)
    assert.match(reordered.stderr + reordered.stdout, /modules do not match official standard order/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rebuild-composition：缺失官方预设或必要技能资产时 fail loud', () => {
  const root = fixture()
  try {
    const upstream = upstreamFixture(root)
    rmSync(join(root, 'preset', 'creative', 'skills', 'editing-cordis-compositions', 'SKILL.md'))
    const missingAsset = run(root, upstream)
    assert.notEqual(missingAsset.status, 0)
    assert.match(missingAsset.stderr + missingAsset.stdout, /required asset missing/)

    const extra = join(upstream, 'packages', 'preset', 'agent-presets', 'presets', 'new-preset')
    mkdirSync(extra, { recursive: true })
    writeFileSync(join(extra, 'agent.cordis.yml'), '- id: demo\n  name: demo\n', 'utf8')
    const missingTarget = run(root, upstream)
    assert.notEqual(missingTarget.status, 0)
    assert.match(missingTarget.stderr + missingTarget.stdout, /no local target preset\/new-preset\/preset\.yml/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
