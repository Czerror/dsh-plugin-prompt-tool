// 指令文件卡策略（W2 host 叶子模块）：
// 独立存储、默认禁用、Document API 保留注释与未知字段、乐观并发、损坏拒绝写入。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'pt-instructions-policy-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = root
after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  assert.equal(dirname(root), resolve(tmpdir()), '只清理本次隔离临时目录')
  rmSync(root, { recursive: true, force: true })
})

const {
  defaultInstructionPolicy,
  readInstructionPolicy,
  resolveInstructionPolicy,
  instructionPolicyPath,
  validateInstructionPolicyPatch,
  writeInstructionPolicy,
} = await import('../../src/host/instructions-policy.ts')

let counter = 0
const newFile = () => {
  counter += 1
  const dir = join(root, `case-${counter}`)
  mkdirSync(dir, { recursive: true })
  return join(dir, 'instructions.yml')
}

test('策略文件缺失：使用默认值（独立来源默认禁用）且不自动创建文件', () => {
  const file = newFile()
  const snapshot = readInstructionPolicy(file)
  assert.equal(snapshot.exists, false)
  assert.equal(snapshot.revision, null)
  assert.equal(snapshot.error, undefined)
  assert.deepEqual(snapshot.policy, defaultInstructionPolicy())
  assert.deepEqual(snapshot.policy.defaults, {
    order: 30,
    position: 'after-user',
    promotion: 'none',
    audience: null,
    modelScope: 'all',
  })
  // 只读不落盘。
  assert.throws(() => readFileSync(file, 'utf8'), /ENOENT/)
})

test('首次保存（expectedRevision=null）创建文件并读回一致', () => {
  const file = newFile()
  const written = writeInstructionPolicy({
    file,
    expectedRevision: null,
    patch: { enabled: true, files: { f1: { order: 40, position: 'before-all', name: '项目规范' } } },
  })
  assert.equal(written.ok, true)
  assert.ok(typeof written.revision === 'string' && written.revision.length === 64)
  const snapshot = readInstructionPolicy(file)
  assert.equal(snapshot.error, undefined)
  assert.equal(snapshot.policy.enabled, true)
  assert.deepEqual(snapshot.policy.files.f1, { order: 40, position: 'before-all', name: '项目规范' })
  assert.equal(snapshot.revision, written.revision)
})

test('写入保留手写注释与未知字段，恢复默认值即删除该键', () => {
  const file = newFile()
  writeFileSync(file, [
    '# 手写说明：这一行必须保留',
    'schemaVersion: 1',
    'enabled: true',
    'customUnknownKey: keep-me',
    'defaults:',
    '  order: 45 # 行内注释',
    'files:',
    '  f1:',
    '    promotion: main',
    '',
  ].join('\n'), 'utf8')
  const before = readInstructionPolicy(file)
  assert.equal(before.error, undefined)
  assert.equal(before.policy.defaults.order, 45)
  const written = writeInstructionPolicy({
    file,
    expectedRevision: before.revision,
    patch: { defaults: { order: 30 }, files: { f1: null } },
  })
  assert.equal(written.ok, true)
  const raw = readFileSync(file, 'utf8')
  assert.match(raw, /手写说明：这一行必须保留/)
  assert.match(raw, /customUnknownKey: keep-me/)
  const after_ = readInstructionPolicy(file)
  assert.equal(after_.policy.defaults.order, 30)
  assert.deepEqual(after_.policy.files, {})
  assert.doesNotMatch(raw, /^defaults:/m, '恢复默认后不留空壳 defaults')
  assert.doesNotMatch(raw, /^files:/m, '删除唯一覆盖后不留空壳 files')
})

test('null 文件覆盖：可替换为合法映射并保留注释与未知字段', () => {
  const file = newFile()
  writeFileSync(file, '# 手写说明\nschemaVersion: 1\ncustomUnknownKey: keep-me\nfiles:\n  f1: null # 继承默认\n  f2:\n    order: 60\n')
  const before = readInstructionPolicy(file)
  assert.equal(before.error, undefined)
  assert.equal(before.policy.files.f1, undefined)
  const written = writeInstructionPolicy({ file, expectedRevision: before.revision, patch: { files: { f1: { order: 40 } } } })
  assert.equal(written.ok, true)
  const current = readInstructionPolicy(file)
  assert.equal(current.error, undefined)
  assert.deepEqual(current.policy.files, { f1: { order: 40 }, f2: { order: 60 } })
  assert.equal(current.revision, written.revision)
  const raw = readFileSync(file, 'utf8')
  assert.match(raw, /# 手写说明/)
  assert.match(raw, /# 继承默认/)
  assert.match(raw, /customUnknownKey: keep-me/)
})

test('乐观并发：过期 expectedRevision 返回 409 且文件字节不变', () => {
  const file = newFile()
  const created = writeInstructionPolicy({ file, expectedRevision: null, patch: { enabled: true } })
  assert.equal(created.ok, true)
  const raw = readFileSync(file, 'utf8')
  const stale = writeInstructionPolicy({ file, expectedRevision: null, patch: { enabled: false } })
  assert.equal(stale.ok, false)
  assert.equal(stale.status, 409)
  assert.equal(stale.code, 'instructions-policy-conflict')
  assert.equal(readFileSync(file, 'utf8'), raw)
})

test('非法 UTF-8：revision 区分原始字节，读取报错且拒绝覆盖', () => {
  const file = newFile()
  const bytes = (byte) => Buffer.concat([Buffer.from('schemaVersion: 1\nenabled: true\n# '), Buffer.from([byte]), Buffer.from('\n')])
  writeFileSync(file, bytes(0xff))
  const before = readInstructionPolicy(file)
  const changed = bytes(0xfe)
  writeFileSync(file, changed)
  const current = readInstructionPolicy(file)
  assert.notEqual(current.revision, before.revision, '不同非法字节不能折叠成同一 revision')
  for (const snapshot of [before, current]) {
    assert.equal(snapshot.exists, true)
    assert.match(snapshot.revision, /^[a-f0-9]{64}$/)
    assert.match(snapshot.error ?? '', /UTF-8/)
    assert.equal(snapshot.policy.enabled, false, '错误态回退缺省（关闭）')
    const refused = writeInstructionPolicy({ file, expectedRevision: snapshot.revision, patch: { enabled: false } })
    assert.equal(refused.ok, false)
    assert.equal(refused.status, 409)
    assert.equal(refused.code, 'instructions-policy-unreadable')
    assert.deepEqual(readFileSync(file), changed)
  }
})

test('YAML 损坏或 schemaVersion 不支持：读取进入错误态，写入拒绝且不覆盖', () => {
  const broken = newFile()
  writeFileSync(broken, 'enabled: [unclosed\n', 'utf8')
  const brokenRead = readInstructionPolicy(broken)
  assert.match(brokenRead.error ?? '', /YAML/)
  const before = readFileSync(broken, 'utf8')
  const refused = writeInstructionPolicy({ file: broken, expectedRevision: brokenRead.revision, patch: { enabled: true } })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'instructions-policy-unreadable')
  assert.equal(readFileSync(broken, 'utf8'), before)

  const future = newFile()
  writeFileSync(future, 'schemaVersion: 99\nenabled: true\n', 'utf8')
  const futureRead = readInstructionPolicy(future)
  assert.match(futureRead.error ?? '', /schemaVersion/)
  assert.equal(writeInstructionPolicy({ file: future, expectedRevision: futureRead.revision, patch: { enabled: false } }).ok, false)
  assert.equal(readFileSync(future, 'utf8'), 'schemaVersion: 99\nenabled: true\n')
})

test('未解析 YAML alias：读取返回错误快照，写入拒绝且不覆盖', () => {
  for (const field of ['defaults', 'customUnknownKey']) {
    const file = newFile()
    const raw = Buffer.from(`schemaVersion: 1\nenabled: true\n${field}: *missing\n`)
    writeFileSync(file, raw)
    const snapshot = readInstructionPolicy(file)
    assert.equal(snapshot.exists, true)
    assert.match(snapshot.revision, /^[a-f0-9]{64}$/)
    assert.match(snapshot.error ?? '', /YAML/)
    assert.equal(snapshot.policy.enabled, false, '错误态回退缺省（关闭）')
    const refused = writeInstructionPolicy({ file, expectedRevision: snapshot.revision, patch: { enabled: false } })
    assert.equal(refused.ok, false)
    assert.equal(refused.status, 409)
    assert.equal(refused.code, 'instructions-policy-unreadable')
    assert.deepEqual(readFileSync(file), raw)
  }
})

test('写盘准备：再次读取失败或文档变坏时规范拒绝，不覆盖外部字节', async (t) => {
  for (const [name, replacement] of [
    ['未解析 alias', Buffer.from('schemaVersion: 1\nenabled: *missing\n')],
    ['非法 UTF-8', Buffer.concat([Buffer.from('enabled: true\n# '), Buffer.from([0xff])])],
    ['非法 YAML', Buffer.from('enabled: [unclosed\n')],
    ['读取失败', new Error('模拟策略文件读取失败')],
  ]) {
    await t.test(name, (t) => {
      const file = newFile()
      const raw = Buffer.from('schemaVersion: 1\nenabled: true\n')
      writeFileSync(file, raw)
      const before = readInstructionPolicy(file)
      const originalRead = fs.readFileSync
      let reads = 0
      const mocked = t.mock.method(fs, 'readFileSync', (...args) => {
        if (args[0] === file && ++reads === 2) {
          if (replacement instanceof Error) throw replacement
          writeFileSync(file, replacement)
        }
        return originalRead(...args)
      })
      syncBuiltinESMExports()
      t.after(() => { mocked.mock.restore(); syncBuiltinESMExports() })
      const refused = writeInstructionPolicy({ file, expectedRevision: before.revision, patch: { enabled: false } })
      assert.equal(refused.ok, false)
      assert.equal(refused.status, 409)
      assert.equal(refused.code, 'instructions-policy-unreadable')
      assert.deepEqual(readFileSync(file), replacement instanceof Error ? raw : replacement)
    })
  }
})

test('YAML 序列化失败：返回规范写入失败且不改原文件', () => {
  const file = newFile()
  const raw = Buffer.from('schemaVersion: 1\nenabled: &switch true\ncustomUnknownKey: *switch\n')
  writeFileSync(file, raw)
  const before = readInstructionPolicy(file)
  assert.equal(before.error, undefined)
  // enabled: false 现在等于「恢复默认」→ 删除锚点节点，让 *switch 别名悬空以触发序列化失败。
  const refused = writeInstructionPolicy({ file, expectedRevision: before.revision, patch: { enabled: false } })
  assert.equal(refused.ok, false)
  assert.equal(refused.status, 409)
  assert.equal(refused.code, 'instructions-policy-write-failed')
  assert.deepEqual(readFileSync(file), raw)
})

test('请求白名单：未知字段、非法枚举与非有限 order 一律拒绝', () => {
  const cases = [
    [{ text: '正文不得进策略文件' }, /未知字段/],
    [{ revision: 'r1' }, /未知字段/],
    [{ defaults: { path: 'D:/repo/AGENTS.md' } }, /未知字段/],
    [{ defaults: { order: Number.NaN } }, /order/],
    [{ defaults: { order: -1 } }, /order/],
    [{ defaults: { position: 'sideways' } }, /position/],
    [{ defaults: { promotion: 'all' } }, /promotion/],
    [{ defaults: { audience: 'everyone' } }, /audience/],
    [{ defaults: { modelScope: 'turbo' } }, /modelScope/],
    [{ enabled: 'yes' }, /enabled/],
    [{ files: { f1: { enabled: 1 } } }, /enabled/],
    [{ files: { f1: { name: '' } } }, /name/],
    [{ files: { f1: { dedupe: 'session' } } }, /未知字段/],
    [{ files: { ' ': { order: 1 } } }, /fileId/],
  ]
  for (const [input, pattern] of cases) {
    const result = validateInstructionPolicyPatch(input)
    assert.equal(result.ok, false, `应拒绝：${JSON.stringify(input)}`)
    assert.match(result.message, pattern)
  }
  assert.equal(validateInstructionPolicyPatch({ enabled: true, defaults: { audience: null }, files: { f1: null } }).ok, true)
})

test('有效策略：每文件覆盖 defaults，部署级 enabled 优先，name 只作显示', () => {
  const policy = {
    enabled: true,
    defaults: { order: 30, position: 'after-user', promotion: 'none', audience: null, modelScope: 'all' },
    files: { f1: { order: 40, name: '项目规范' }, f2: { enabled: false } },
  }
  assert.deepEqual(resolveInstructionPolicy(policy, 'f1'), {
    order: 40,
    position: 'after-user',
    promotion: 'none',
    audience: null,
    modelScope: 'all',
    name: '项目规范',
    enabled: true,
  })
  assert.equal(resolveInstructionPolicy(policy, 'f2').enabled, false)
  assert.equal(resolveInstructionPolicy(policy, 'unknown').enabled, true)
  assert.equal(resolveInstructionPolicy({ ...policy, enabled: false }, 'f1').enabled, false, '部署级关闭优先于每文件开关')
})

test('策略路径只在 host/paths 之外有一处定义，并落在 DSH_HOME 下', () => {
  const path = instructionPolicyPath('D:/home/.dsh')
  assert.equal(path.replaceAll('\\', '/'), 'D:/home/.dsh/.prompt-tool/instructions.yml')
})

test('文件覆盖删除后回到默认，正文仍不落入策略文件', () => {
  const file = newFile()
  const created = writeInstructionPolicy({ file, expectedRevision: null, patch: { enabled: true, files: { f1: { order: 60 } } } })
  assert.equal(created.ok, true)
  const removed = writeInstructionPolicy({ file, expectedRevision: created.revision, patch: { files: { f1: null } } })
  assert.equal(removed.ok, true)
  assert.equal(readInstructionPolicy(file).policy.defaults.order, 30)
  assert.deepEqual(readInstructionPolicy(file).policy.files, {})
})

test('共享 null 锚点不能因局部更新改变其他字段，拒写时保持原字节', () => {
  const file = newFile()
  const raw = Buffer.from('schemaVersion: 1\nenabled: true\nfiles:\n  f1: &inherit null\n  f2:\n    audience: *inherit\n')
  writeFileSync(file, raw)
  const before = readInstructionPolicy(file)
  assert.equal(before.error, undefined)
  assert.equal(before.policy.files.f2.audience, null)
  const refused = writeInstructionPolicy({ file, expectedRevision: before.revision, patch: { files: { f1: { order: 40 } } } })
  assert.deepEqual(readFileSync(file), raw, '不能先写坏共享锚点，再在读回阶段报告失败')
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'instructions-policy-invalid')
  assert.match(refused.message, /引用/)
  assert.deepEqual(readInstructionPolicy(file), before)

  const unshared = newFile()
  writeFileSync(unshared, 'schemaVersion: 1\nfiles:\n  f1: &unused null\n')
  const unsharedBefore = readInstructionPolicy(unshared)
  const saved = writeInstructionPolicy({ file: unshared, expectedRevision: unsharedBefore.revision, patch: { files: { f1: { order: 40 } } } })
  assert.equal(saved.ok, true, '未被引用的 null 锚点仍可正常更新')
  assert.equal(saved.policy.files.f1.order, 40)
})
