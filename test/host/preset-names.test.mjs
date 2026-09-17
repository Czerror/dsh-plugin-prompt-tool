import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

const home = mkdtempSync(join(tmpdir(), 'pt-preset-names-'))
process.env.DSH_HOME = home
const { cloneBuiltinPreset, ensurePresetSeed, packagePresetDir } = await import('../../src/host/manifest.ts')
const { writePreset } = await import('../../src/host/write-preset.ts')
const { DEFAULT_PRESET_ID } = await import('../../src/shared/preset-ids.ts')
const ids = ['pt-cordis', 'pt-custom', 'pt-minimal', 'pt-ptc', 'pt-standard']
test.after(() => rmSync(home, { recursive: true, force: true }))

test('包内预设目录和定义 ID 直接使用 pt-* 命名', () => {
  assert.equal(DEFAULT_PRESET_ID, 'pt-standard')
  const dirs = readdirSync(packagePresetDir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  assert.deepEqual(dirs, ids)
  for (const id of ids) {
    assert.equal(parse(readFileSync(join(packagePresetDir(), id, 'preset.yml'), 'utf8')).id, id)
  }
})

test('种子化仅补缺失的单个目录，已有定义、组合和资源逐字保留', () => {
  const root = mkdtempSync(join(home, 'seed-'))
  const preserved = new Map()
  for (const id of ids.filter((id) => id !== 'pt-ptc')) {
    mkdirSync(join(root, id), { recursive: true })
    for (const file of ['preset.yml', 'agent.cordis.yml', 'resource.txt']) {
      const path = join(root, id, file)
      const content = `${id}/${file}: USER CONTENT\n`
      writeFileSync(path, content)
      preserved.set(path, content)
    }
  }
  mkdirSync(join(root, 'standard'))
  writeFileSync(join(root, 'standard', 'legacy.txt'), 'legacy stays')
  assert.deepEqual(ensurePresetSeed(root).created, ['pt-ptc'])
  assert.ok(existsSync(join(root, 'pt-ptc', 'preset.yml')))
  assert.deepEqual(ensurePresetSeed(root).created, [])
  for (const [path, content] of preserved) assert.equal(readFileSync(path, 'utf8'), content)
  assert.equal(readFileSync(join(root, 'standard', 'legacy.txt'), 'utf8'), 'legacy stays')
})

test('新建按包内同名复制，递增副本也不改写定义正文', () => {
  const root = mkdtempSync(join(home, 'clone-'))
  const source = readFileSync(join(packagePresetDir(), 'pt-custom', 'preset.yml'), 'utf8')
  assert.deepEqual(cloneBuiltinPreset('pt-custom', false, root), { ok: true, id: 'pt-custom' })
  assert.equal(readFileSync(join(root, 'pt-custom', 'preset.yml'), 'utf8'), source)
  assert.equal(cloneBuiltinPreset('pt-custom', false, root).ok, false)
  assert.deepEqual(cloneBuiltinPreset('pt-custom', true, root), { ok: true, id: 'pt-custom-2' })
  assert.equal(readFileSync(join(root, 'pt-custom-2', 'preset.yml'), 'utf8'), source)
  assert.equal(cloneBuiltinPreset('custom', false, root).ok, false)
})

test('物化 pt-standard 读取自身变量和能力模块，不读取其他同源预设', () => {
  const root = mkdtempSync(join(home, 'render-'))
  for (const [id, value, module] of [
    ['pt-standard', 'ACTIVE', 'promoted-code-mode'],
    ['standard', 'OTHER', 'tool-bootstrap'],
  ]) {
    mkdirSync(join(root, id))
    writeFileSync(join(root, id, 'preset.yml'),
      `id: ${id}\nmodules: [prompt-config-engine, ${module}]\nvariables:\n  owner: ${value}\n`, 'utf8')
  }
  writePreset('', { presetDir: root, presetTemplate: 'pt-standard', presetOrder: 5, promptConfigs: [] })
  const rows = parse(readFileSync(join(root, 'pt-standard', 'agent.cordis.yml'), 'utf8'))
  assert.ok(rows.some((row) => row.id === 'promoted-code-mode'))
  assert.ok(!rows.some((row) => row.id === 'tool-bootstrap'))
  assert.deepEqual(parse(readFileSync(join(root, 'pt-standard', 'prompt-configs', 'variables.yml'), 'utf8')), { owner: 'ACTIVE' })
  assert.equal(existsSync(join(root, 'standard', 'agent.cordis.yml')), false)
})
