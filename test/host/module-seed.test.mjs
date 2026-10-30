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

test('ensureModuleSeed：首次复制内置模板，二次幂等，删除后自动补建', () => {
  const first = ensureModuleSeed()
  assert.ok(first.created.length > 0, '首次应复制内置模板')
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
