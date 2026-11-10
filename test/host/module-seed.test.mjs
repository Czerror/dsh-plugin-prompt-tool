import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { isolatedHome, tempDir } from '../fixtures/host-harness.mjs'

// 种子化只发生在预设根内：隔离 DSH_HOME 验证补建、幂等与安全边界（清理与还原由夹具登记）。
const { home } = isolatedHome('pt-seed-')
const { storageRootOf } = await import('../../src/host/paths.ts')
const { cloneBuiltinModule, duplicateUserModule, ensureModuleSeed } = await import('../../src/host/module-catalog.ts')
const { packageModulesDir } = await import('../../src/host/module-dirs.ts')

const PRESETS_DIR = join(storageRootOf(home), 'modules')

test('核心破限模块只补缺失定义，两条身份规则默认关闭且不启用模块', async () => {
  const root = tempDir('pt-limit-breaker-seed-')
  assert.ok(ensureModuleSeed(root).created.includes('limit-breaker'))
  const definition = join(root, 'limit-breaker', 'module.yml')
  const spec = parseYaml(readFileSync(definition, 'utf8'))
  assert.equal(spec.name, '核心破限模块')
  assert.deepEqual(spec.rules.map(rule => [rule.id, rule.enabled]), [['purge-4', false], ['purge-25', false]])
  const { readModuleRules, editModuleRules } = await import('../../src/host/module-rules.ts')
  const snapshot = readModuleRules(join(root, 'limit-breaker'))
  assert.deepEqual(snapshot.rules.map(rule => rule.source), [
    { format: 'dsh-purge', id: 4, name: 'SYSTEM_PROMPT_PERSONA', path: 'lib/patches/prompt.mjs', commit: '126caa2c99297223a7e0e87e604aecfc802f396e' },
    { format: 'dsh-purge', id: 25, name: 'HARNESS_IDENTITY_STRIP', path: 'lib/patches/new-tools.mjs', commit: '126caa2c99297223a7e0e87e604aecfc802f396e' },
  ])
  const saved = editModuleRules(join(root, 'limit-breaker'), { expectedRevisions: snapshot.revisions, activateRuleId: 'purge-4' })
  assert.equal(saved.rules[0].enabled, true)
  assert.deepEqual(saved.rules[0].source, snapshot.rules[0].source)
  const { readStorageConfig } = await import('../../src/host/config-store.ts')
  assert.equal(readStorageConfig(root).source.enabled.includes('limit-breaker'), false)
  const user = 'id: limit-breaker\nname: USER\nmodules: []\nrules: []\n'
  writeFileSync(definition, user)
  assert.equal(ensureModuleSeed(root).created.includes('limit-breaker'), false)
  assert.equal(readFileSync(definition, 'utf8'), user)
})

test('ensureModuleSeed：首次复制内置模板，二次幂等，删除后自动补建', () => {
  const first = ensureModuleSeed()
  assert.ok(first.created.length > 0, '首次应复制内置模板')
  assert.equal(existsSync(join(PRESETS_DIR, 'soul', 'assets')), false, '内置资产不随定义物化')
  assert.ok(existsSync(join(PRESETS_DIR, 'soul', 'rules')), '规则切片照常生成')
  // 二次调用幂等：全部存在时不重复复制。
  assert.deepEqual(ensureModuleSeed().created, [])
  // 删除某个内置预设后，种子化自动补建（无「永不恢复」闸门）。
  const id = first.created[0]
  assert.ok(typeof id === 'string' && id.length > 0)
  rmSync(join(PRESETS_DIR, id), { recursive: true, force: true })
  assert.ok(ensureModuleSeed().created.includes(id), '删除的内置预设应被补建恢复')
})

test('ensureModuleSeed：已存在的内置模块即使被用户改过也不覆盖', () => {
  ensureModuleSeed()
  const id = readdirSync(packageModulesDir()).find((name) => !name.startsWith('.'))
  assert.ok(id, '包内至少应有一个内置模块')
  const target = join(PRESETS_DIR, id)
  assert.ok(existsSync(join(target, 'module.yml')), '前置：内置模块已补建')
  const definition = join(target, 'module.yml')
  const userFile = join(target, 'user.txt')
  writeFileSync(definition, 'id: ' + id + '\nname: USER EDITED\nmodules: []\n', 'utf8')
  writeFileSync(userFile, 'USER\n', 'utf8')
  const before = readFileSync(definition, 'utf8')
  const again = ensureModuleSeed()
  assert.equal(again.created.includes(id), false, '已存在的模块不应被重新补建')
  assert.equal(readFileSync(definition, 'utf8'), before, '用户改过的定义逐字节保留')
  assert.equal(readFileSync(userFile, 'utf8'), 'USER\n', '用户资产保留')
})

test('种子化不写状态文件，也不改动 DSH_HOME 根下其他文件', () => {
  // 模拟 DSH_HOME 根下官方/用户文件（settings.yaml、AGENTS.md、profiles/ 等）。
  const settingsYaml = join(home, 'settings.yaml')
  const agentsMd = join(home, 'AGENTS.md')
  const profilesDir = join(home, 'profiles', 'web')
  writeFileSync(settingsYaml, 'appId: deepseek-harness\n', 'utf8')
  writeFileSync(agentsMd, '# AGENTS\n', 'utf8')
  mkdirSync(profilesDir, { recursive: true })
  writeFileSync(join(profilesDir, 'profile.yml'), 'id: web\n', 'utf8')

  const snapshot = () => ({
    settingsYaml: readFileSync(settingsYaml, 'utf8'),
    agentsMd: readFileSync(agentsMd, 'utf8'),
    profileYml: readFileSync(join(profilesDir, 'profile.yml'), 'utf8'),
    rootEntries: readdirSync(home).sort(),
  })
  const before = snapshot()

  ensureModuleSeed()

  assert.deepEqual(snapshot(), before, 'DSH_HOME 根下其他文件必须逐字节不变、无新增/删除')
})

test('新建空白模块：引擎内组装出 module.yml，目录名=id，冲突时递增', () => {
  const root = tempDir('pt-blank-clone-')
  const cloned = cloneBuiltinModule('blank', true, root)
  assert.equal(cloned.ok, true, cloned.message)
  assert.equal(cloned.id, 'blank', '目录名 = id')
  const definition = readFileSync(join(root, 'blank', 'module.yml'), 'utf8')
  const spec = parseYaml(definition)
  assert.equal(spec.id, 'blank')
  assert.equal(spec.name, '默认模块')
  assert.deepEqual(spec.modules, ['rule-engine'])
  assert.equal(spec.order, 9)
  // 同名已占用时按 id-2 / id-3 递增，定义身份跟着目录名走。
  const again = cloneBuiltinModule('blank', true, root)
  assert.equal(again.ok, true, again.message)
  assert.equal(again.id, 'blank-2')
  assert.equal(parseYaml(readFileSync(join(root, 'blank-2', 'module.yml'), 'utf8')).id, 'blank-2')
  assert.equal(parseYaml(readFileSync(join(root, 'blank-2', 'module.yml'), 'utf8')).name, '默认模块')
})

test('内置同名只建定义，改名复制合并有效资产，自建模块独立复制', () => {
  const root = tempDir('pt-builtin-assets-')
  assert.deepEqual(cloneBuiltinModule('soul', false, root), { ok: true, id: 'soul' })
  assert.equal(existsSync(join(root, 'soul', 'assets')), false)
  mkdirSync(join(root, 'soul', 'assets'))
  writeFileSync(join(root, 'soul', 'assets', 'criteria.md'), 'USER CRITERIA')
  assert.deepEqual(duplicateUserModule('soul', root), { ok: true, id: 'soul-copy' })
  assert.equal(readFileSync(join(root, 'soul-copy', 'assets', 'criteria.md'), 'utf8'), 'USER CRITERIA')
  assert.ok(existsSync(join(root, 'soul-copy', 'assets', 'reference', 'README.md')), '复制补齐包内资产')
  assert.deepEqual(cloneBuiltinModule('soul', true, root), { ok: true, id: 'soul-2' })
  assert.ok(existsSync(join(root, 'soul-2', 'assets', 'manifest.yml')))
  assert.deepEqual(duplicateUserModule('soul-copy', root), { ok: true, id: 'soul-copy-copy' })
  assert.equal(readFileSync(join(root, 'soul-copy-copy', 'assets', 'criteria.md'), 'utf8'), 'USER CRITERIA')
  assert.deepEqual(cloneBuiltinModule('blank', false, root), { ok: true, id: 'blank' })
  mkdirSync(join(root, 'blank', 'assets'))
  writeFileSync(join(root, 'blank', 'assets', 'custom.md'), 'CUSTOM')
  assert.deepEqual(duplicateUserModule('blank', root), { ok: true, id: 'blank-copy' })
  assert.equal(readFileSync(join(root, 'blank-copy', 'assets', 'custom.md'), 'utf8'), 'CUSTOM')
})

test('新建空白模块：安装成功但清理失败时向调用方告警', (t) => {
  const root = tempDir('pt-blank-leftover-')
  const warnings = []
  const original = fs.rmSync.bind(fs)
  t.mock.method(fs, 'rmSync', (path, ...args) => {
    if (dirname(String(path)) === root && String(path).includes('.install-')) throw new Error('cleanup failed')
    return original(path, ...args)
  })
  syncBuiltinESMExports()
  try {
    const cloned = cloneBuiltinModule('blank', true, root, message => warnings.push(message))
    assert.equal(cloned.ok, true, cloned.message)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /暂存目录清理失败/)
})

test('复制模块：安装成功但清理失败时向调用方告警', (t) => {
  const root = tempDir('pt-copy-leftover-')
  assert.equal(cloneBuiltinModule('blank', false, root).ok, true)
  const warnings = []
  const original = fs.rmSync.bind(fs)
  t.mock.method(fs, 'rmSync', (path, ...args) => {
    if (dirname(String(path)) === root && String(path).includes('.install-')) throw new Error('cleanup failed')
    return original(path, ...args)
  })
  syncBuiltinESMExports()
  try {
    const copied = duplicateUserModule('blank', root, message => warnings.push(message))
    assert.equal(copied.ok, true, copied.message)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /暂存目录清理失败/)
})

test('种子化：安装成功但清理失败时向调用方告警', (t) => {
  const root = tempDir('pt-seed-leftover-')
  const warnings = []
  const original = fs.rmSync.bind(fs)
  t.mock.method(fs, 'rmSync', (path, ...args) => {
    if (dirname(String(path)) === root && String(path).includes('.install-')) throw new Error('cleanup failed')
    return original(path, ...args)
  })
  syncBuiltinESMExports()
  try {
    const seeded = ensureModuleSeed(root, message => warnings.push(message))
    assert.ok(seeded.created.length > 0)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.ok(warnings.length > 0)
  assert.match(warnings[0], /暂存目录清理失败/)
})

test('新建空白模块：未知模板 id 仍被拒，模块根不留痕迹', () => {
  const root = tempDir('pt-blank-unknown-')
  const before = readdirSync(root).sort()
  const rejected = cloneBuiltinModule('no-such-template', true, root)
  assert.equal(rejected.ok, false, '未知模板 id 不得组装出模块')
  assert.deepEqual(readdirSync(root).sort(), before, '被拒的新建不得留下候选目录')
})
