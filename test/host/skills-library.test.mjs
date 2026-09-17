import { after, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const home = mkdtempSync(join(tmpdir(), 'pt-skills-library-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})
const { readSkillsConfig } = await import('../../src/host/skills-config.ts')
const { readManagedSkills, reconcileSkillsLibrary, updateSkillsLibrary } = await import('../../src/host/skills-library.ts')

function fixture(name, text = '---\n# 保留注释\nname: demo\ndescription: demo\ncustom: keep\n---\n正文\n') {
  const root = join(home, name, 'skills')
  const entity = join(root, '.system', 'demo')
  mkdirSync(entity, { recursive: true })
  writeFileSync(join(entity, 'SKILL.md'), text)
  return { root, entity, file: join(entity, 'SKILL.md'), config: join(root, '.system', 'skills.yml') }
}
const state = (patch = {}) => ({ path: 'demo', link: 'demo', enabled: true, modelInvocable: true, userInvocable: true, ...patch })
const register = (root, patch) => updateSkillsLibrary(root, (config) => ({ ...config, skills: { demo: state(patch) } }))

test('受管实体保留正文，启停只增删链接且幂等', () => {
  const f = fixture('toggle')
  const original = readFileSync(f.file, 'utf8')
  const registered = register(f.root)
  assert.equal(registered.ok, true, registered.message)
  assert.equal(lstatSync(join(f.root, 'demo')).isSymbolicLink(), true)
  assert.equal(resolve(readlinkSync(join(f.root, 'demo'))), resolve(f.entity))
  assert.equal(readManagedSkills(f.root)[0].folder, 'demo')
  assert.equal(register(f.root, { enabled: false }).ok, true)
  assert.equal(existsSync(join(f.root, 'demo')), false)
  assert.equal(readManagedSkills(f.root)[0].disabled, true)
  assert.equal(readFileSync(f.file, 'utf8'), original)
  assert.equal(register(f.root, { enabled: false }).ok, true)
  assert.equal(register(f.root).ok, true)
  assert.equal(readManagedSkills(f.root)[0].disabled, undefined)
})

test('YAML 权威同步两项官方权限，保留正文、注释和未知字段，外部偏差只提示一次', () => {
  const f = fixture('permissions')
  assert.equal(register(f.root, { modelInvocable: false, userInvocable: false }).ok, true)
  const expected = readFileSync(f.file, 'utf8')
  assert.match(expected, /disable-model-invocation: true/)
  assert.match(expected, /user-invocable: false/)
  assert.match(expected, /# 保留注释/)
  assert.match(expected, /custom: keep/)
  assert.ok(expected.endsWith('---\n正文\n'))
  const warnings = []
  for (let n = 0; n < 2; n++) {
    writeFileSync(f.file, expected.replace('disable-model-invocation: true', 'disable-model-invocation: false'))
    assert.equal(reconcileSkillsLibrary(f.root, (message) => warnings.push(message)).ok, true)
    assert.equal(readFileSync(f.file, 'utf8'), expected)
  }
  assert.equal(warnings.length, 1)
})

test('任一链接目标冲突在写正文和配置前失败，不收养未知同目标链接', () => {
  for (const symbolic of [false, true]) {
    const f = fixture(`conflict-${symbolic}`)
    if (symbolic) symlinkSync(f.entity, join(f.root, 'demo'), 'junction')
    else mkdirSync(join(f.root, 'demo'))
    const original = readFileSync(f.file, 'utf8')
    const result = register(f.root, { modelInvocable: false })
    assert.equal(result.ok, false)
    assert.match(result.message, /冲突|未受管/)
    assert.equal(readFileSync(f.file, 'utf8'), original)
    assert.equal(existsSync(f.config), false)
    assert.equal(existsSync(join(f.root, 'demo')), true)
    assert.equal(register(f.root, { enabled: false }).ok, false, '停用状态也不能凭空收养已存在链接')
  }
})

test('损坏 YAML、路径逃逸和实体符号链接均不修改实物', () => {
  const f = fixture('invalid')
  assert.equal(register(f.root).ok, true)
  const original = readFileSync(f.file, 'utf8')
  writeFileSync(f.config, 'skills: *undefined\n')
  assert.equal(reconcileSkillsLibrary(f.root).ok, false)
  assert.equal(readFileSync(f.file, 'utf8'), original)
  assert.equal(lstatSync(join(f.root, 'demo')).isSymbolicLink(), true)
  const g = fixture('escape')
  assert.equal(register(g.root, { path: '../outside' }).ok, false)
  symlinkSync(g.entity, join(g.root, '.system', 'alias'), 'junction')
  assert.equal(register(g.root, { path: 'alias' }).ok, false)
  assert.equal(existsSync(g.config), false)
})

test('写锁拒绝并发事务；已有记录丢失链接时管理条目仍呈停用', () => {
  const f = fixture('lock')
  assert.equal(register(f.root).ok, true)
  writeFileSync(join(f.root, '.system', '.skills.lock'), 'other-process')
  assert.equal(register(f.root, { enabled: false }).ok, false)
  assert.equal(readSkillsConfig(f.config).config.skills.demo.enabled, true)
  assert.equal(readFileSync(join(f.root, '.system', '.skills.lock'), 'utf8'), 'other-process')
  rmSync(join(f.root, '.system', '.skills.lock'))
  rmSync(join(f.root, 'demo'))
  assert.equal(readManagedSkills(f.root)[0].disabled, true)
})

test('最终 YAML 提交失败时回滚权限和已取消链接，完整保留旧状态', () => {
  const f = fixture('rollback')
  assert.equal(register(f.root).ok, true)
  const original = readFileSync(f.file, 'utf8')
  const yaml = readFileSync(f.config, 'utf8')
  const rename = fs.renameSync
  const fault = mock.method(fs, 'renameSync', (from, to) => {
    if (resolve(to) === resolve(f.config)) throw new Error('injected config commit failure')
    return rename(from, to)
  })
  syncBuiltinESMExports()
  try {
    const result = register(f.root, { enabled: false, modelInvocable: false, userInvocable: false })
    assert.equal(result.ok, false)
    assert.match(result.message, /injected config commit failure/)
    assert.equal(readFileSync(f.config, 'utf8'), yaml)
    assert.equal(readFileSync(f.file, 'utf8'), original)
    assert.equal(lstatSync(join(f.root, 'demo')).isSymbolicLink(), true)
    assert.equal(resolve(readlinkSync(join(f.root, 'demo'))), resolve(f.entity))
    assert.equal(existsSync(join(f.root, '.system', '.skills.lock')), false)
  } finally {
    fault.mock.restore()
    syncBuiltinESMExports()
  }
})

test('对齐隔离损坏技能并保留 YAML 意图，健康技能继续同步；显式修改坏技能失败', () => {
  const f = fixture('quarantine')
  const good = join(f.root, '.system', 'good')
  mkdirSync(good)
  writeFileSync(join(good, 'SKILL.md'), '---\nname: good\ndescription: good\n---\nhealthy\n')
  assert.equal(updateSkillsLibrary(f.root, (config) => ({ ...config, skills: {
    demo: state(), good: state({ path: 'good', link: 'good', modelInvocable: false }),
  } })).ok, true)
  writeFileSync(f.file, '---\nname: demo\ndescription: *missing\n---\nbroken\n')
  writeFileSync(join(good, 'SKILL.md'), '---\nname: good\ndescription: good\n---\nhealthy\n')
  const warnings = []
  const result = reconcileSkillsLibrary(f.root, (message) => warnings.push(message))
  assert.equal(result.ok, true, result.message)
  assert.equal(result.config.skills.demo.enabled, true, 'YAML 用户启用意图不因损坏被改写')
  assert.equal(existsSync(join(f.root, 'demo')), false)
  assert.equal(existsSync(join(f.root, 'good')), true)
  assert.match(readFileSync(join(good, 'SKILL.md'), 'utf8'), /disable-model-invocation: true/)
  const bad = readManagedSkills(f.root).find((entry) => entry.id === 'demo')
  assert.equal(bad.valid, false)
  assert.equal(bad.disabled, true)
  assert.match(bad.issue, /解析|alias|Alias/)
  assert.ok(warnings.some((message) => message.includes('demo')))
  const explicit = updateSkillsLibrary(f.root, (config) => {
    config.skills.demo.modelInvocable = false
    return config
  })
  assert.equal(explicit.ok, false)
  assert.match(explicit.message, /demo/)
  assert.equal(readSkillsConfig(f.config).config.skills.demo.modelInvocable, true)
  writeFileSync(f.file, '---\nname: demo\ndescription: repaired\n---\nrepaired\n')
  assert.equal(reconcileSkillsLibrary(f.root).ok, true)
  assert.equal(existsSync(join(f.root, 'demo')), true, '修复后恢复原启用意图')
})

test('parentId 使用实体路径最近受管祖先，与不相关稳定 ID 分离', () => {
  const f = fixture('parents')
  for (const path of ['demo/part', 'demo/part/deep']) {
    const dir = join(f.root, '.system', path)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${path.split('/').at(-1)}\ndescription: child\n---\nbody\n`)
  }
  const result = updateSkillsLibrary(f.root, (config) => ({ ...config, skills: {
    unrelated: state(), second: state({ path: 'demo/part', link: 'part' }), third: state({ path: 'demo/part/deep', link: 'deep' }),
  } }))
  assert.equal(result.ok, true, result.message)
  const entries = new Map(readManagedSkills(f.root).map((entry) => [entry.id, entry]))
  assert.equal(entries.get('unrelated').parentId, undefined)
  assert.equal(entries.get('second').parentId, 'unrelated')
  assert.equal(entries.get('third').parentId, 'second')
})

test('技能身份可以是 Object.prototype 上的名字，整库仍完整可读可启停', () => {
  const root = join(home, 'proto-names', 'skills')
  for (const id of ['prototype', 'constructor']) {
    const dir = join(root, '.system', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: ${id}\n---\nbody\n`)
  }
  const state = (id) => ({ path: id, link: id, enabled: true, modelInvocable: true, userInvocable: true })
  const result = updateSkillsLibrary(root, (config) => ({ ...config, skills: { prototype: state('prototype'), constructor: state('constructor') } }))
  assert.equal(result.ok, true, result.message)
  const entries = new Map(readManagedSkills(root).map((entry) => [entry.id, entry]))
  assert.deepEqual([...entries.keys()].sort(), ['constructor', 'prototype'], '两个技能都进入管理面，不被当成保留名丢弃')
  assert.equal(entries.get('prototype').valid, true)
  assert.equal(entries.get('prototype').linked, true)
  // 停用 / 重新启用按稳定 id 定位，继承属性不会伪造出不存在的技能。
  assert.equal(updateSkillsLibrary(root, (config) => { config.skills.prototype.enabled = false; return config }).ok, true)
  assert.equal(existsSync(join(root, 'prototype')), false)
  assert.equal(readManagedSkills(root).find((entry) => entry.id === 'prototype').disabled, true)
  assert.equal(readManagedSkills(root).some((entry) => entry.id === 'tostring'), false)
})
