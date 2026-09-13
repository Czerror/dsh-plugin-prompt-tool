import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
/** 固定上游输入：0.1.5-rc.2 tag 导出，不读取开发机 ../deepseek-harness。 */
const FIXTURE = join(ROOT, 'test', 'fixtures', 'dsh', '0.1.5-rc.2')
const FIXTURE_PRESETS = join(FIXTURE, 'packages', 'preset', 'agent-presets', 'presets')
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
  cpSync(join(FIXTURE, 'packages'), join(target, 'packages'), { recursive: true })
  return target
}

function run(root, upstream) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'rebuild-composition.mjs'), upstream], {
    cwd: root,
    encoding: 'utf8',
  })
}

function listFixtureFiles(dir, prefix = '') {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...listFixtureFiles(join(dir, entry.name), relative))
    else files.push(relative)
  }
  return files
}

test('固定上游 fixture 与 PROVENANCE 指纹一致（禁止本地 master 冒充 rc.2）', () => {
  const provenance = readFileSync(join(FIXTURE, 'PROVENANCE.md'), 'utf8')
  const listed = new Map()
  for (const match of provenance.matchAll(/^\| `([^`]+)` \| (\d+) \| `([0-9a-f]{64})` \|$/gm)) {
    listed.set(match[1], { size: Number(match[2]), sha256: match[3] })
  }
  assert.ok(listed.size >= 4, 'PROVENANCE 必须列出全部 fixture 文件')

  const actual = listFixtureFiles(FIXTURE_PRESETS)
  for (const relative of actual) {
    const entry = listed.get(relative)
    assert.ok(entry !== undefined, `${relative} 未登记在 PROVENANCE.md`)
    const bytes = readFileSync(join(FIXTURE_PRESETS, relative))
    assert.equal(bytes.length, entry.size, `${relative} 字节数与固定输入不符`)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${relative} 内容与固定输入不符`)
  }
  for (const relative of listed.keys()) {
    assert.ok(actual.includes(relative), `PROVENANCE 登记的 ${relative} 在 fixture 中缺失`)
  }
  assert.match(provenance, /fb2c4b9e698e30edb738bca4cf0618587db7d203/, 'PROVENANCE 必须记录来源提交')
})

test('rebuild-composition：动态发现官方预设并拒绝缺行、重复和乱序', () => {
  const root = fixture()
  try {
    const upstream = upstreamFixture(root)
    const first = run(root, upstream)
    assert.equal(first.status, 0, first.stderr || first.stdout)

    // C-01/C-03：官方 minimal 已删除 filesystem 行，本地编辑能力改为 source/local 模块。
    const library = join(root, 'engine', 'compositions', 'library')
    const localModules = join(root, 'engine', 'compositions', 'source', 'local')
    assert.equal(existsSync(join(library, 'bootstrap-filesystem.yml')), false, 'library 不得再切分官方 minimal filesystem 行')
    assert.equal(existsSync(join(localModules, 'bootstrap-filesystem.yml')), true, '本地 bootstrap-filesystem 必须存在')
    // C-02：rc.2 的 present 行必须被覆盖，且来源行记录固定 tag 与提交。
    const present = readFileSync(join(library, 'present.yml'), 'utf8')
    // 临时上游目录不带 PROVENANCE.md，来源行只保证指向 minimal 之外的官方基型；
    // tag/commit 由上面「固定上游 fixture 与 PROVENANCE 指纹一致」用例锁定。
    assert.match(present, /^# source: .*\/packages\/preset\/agent-presets\/presets\/standard\/agent\.cordis\.yml$/m)

    const before = readFileSync(join(library, 'tool-web.yml'), 'utf8')
    const file = join(root, 'preset', 'standard', 'preset.yml')
    const original = readFileSync(file, 'utf8')
    writeFileSync(file, original.replace('  - tool-web\n', ''), 'utf8')
    const missing = run(root, upstream)
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr + missing.stdout, /modules do not match official standard order/)
    // C-04：失败必须原子回滚，原生成目录逐字节保留。
    assert.equal(readFileSync(join(library, 'tool-web.yml'), 'utf8'), before, '失败的重建不得改写原生成目录')
    assert.equal(existsSync(`${library}.rebuild-tmp`), false, '失败后不得残留临时目录')

    writeFileSync(file, original.replace('  - tool-web\n', '  - tool-web\n  - tool-web\n'), 'utf8')
    const duplicate = run(root, upstream)
    assert.notEqual(duplicate.status, 0)
    assert.match(duplicate.stderr + duplicate.stdout, /duplicate modules: tool-web/)

    writeFileSync(file, original.replace('  - present\n  - prompt-config-engine\n', '  - prompt-config-engine\n  - present\n'), 'utf8')
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
