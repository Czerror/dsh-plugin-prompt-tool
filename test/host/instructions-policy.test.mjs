// 指令文件卡策略（W2 host 叶子模块）：
// 独立存储、默认放行官方内容、Document API 保留注释与未知字段、乐观并发。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('策略文件缺失：默认放行官方注入且不自动创建文件', () => {
  const file = newFile()
  const snapshot = readInstructionPolicy(file)
  assert.equal(snapshot.exists, false)
  assert.equal(snapshot.revision, null)
  assert.equal(snapshot.error, undefined)
  assert.deepEqual(snapshot.policy, defaultInstructionPolicy())
  assert.deepEqual(snapshot.policy, { files: {} })
  assert.deepEqual(resolveInstructionPolicy(snapshot.policy, 'unconfigured'), { enabled: true })
  // 只读不落盘。
  assert.throws(() => readFileSync(file, 'utf8'), /ENOENT/)
})

test('首次保存（expectedRevision=null）创建文件并读回一致', () => {
  const file = newFile()
  const written = writeInstructionPolicy({
    file,
    expectedRevision: null,
    patch: { files: { f1: { enabled: false, name: '项目规范' } } },
  })
  assert.equal(written.ok, true)
  assert.ok(typeof written.revision === 'string' && written.revision.length === 64)
  const snapshot = readInstructionPolicy(file)
  assert.equal(snapshot.error, undefined)
  assert.deepEqual(snapshot.policy.files.f1, { enabled: false, name: '项目规范' })
  assert.equal(snapshot.revision, written.revision)
})

test('写入保留手写注释与未知字段，恢复默认值即删除该键', () => {
  const file = newFile()
  writeFileSync(file, [
    '# 手写说明：这一行必须保留',
    'schemaVersion: 1',
    'customUnknownKey: keep-me',
    'files:',
    '  f1:',
    '    enabled: false',
    '    name: 项目规范 # 行内注释',
    '',
  ].join('\n'), 'utf8')
  const before = readInstructionPolicy(file)
  assert.equal(before.error, undefined)
  assert.equal(before.policy.files.f1.enabled, false)
  const written = writeInstructionPolicy({
    file,
    expectedRevision: before.revision,
    patch: { files: { f1: { enabled: true } } },
  })
  assert.equal(written.ok, true)
  const raw = readFileSync(file, 'utf8')
  assert.match(raw, /手写说明：这一行必须保留/)
  assert.match(raw, /customUnknownKey: keep-me/)
  assert.match(raw, /# 行内注释/)
  const after_ = readInstructionPolicy(file)
  assert.deepEqual(after_.policy.files, { f1: { name: '项目规范' } })
  assert.equal(resolveInstructionPolicy(after_.policy, 'f1').enabled, true)
  assert.doesNotMatch(raw, /enabled:/, '恢复默认放行后删除显式开关键')
})

test('乐观并发：过期 expectedRevision 返回 409 且文件字节不变', () => {
  const file = newFile()
  const created = writeInstructionPolicy({ file, expectedRevision: null, patch: { files: { f1: { enabled: false } } } })
  assert.equal(created.ok, true)
  const raw = readFileSync(file, 'utf8')
  const stale = writeInstructionPolicy({ file, expectedRevision: null, patch: { files: { f1: { enabled: true } } } })
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
    assert.deepEqual(snapshot.policy, { files: {} }, '错误态不猜测文件开关')
    const refused = writeInstructionPolicy({ file, expectedRevision: snapshot.revision, patch: { files: { f1: { enabled: false } } } })
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
  const refused = writeInstructionPolicy({ file: broken, expectedRevision: brokenRead.revision, patch: { files: { f1: { enabled: true } } } })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'instructions-policy-unreadable')
  assert.equal(readFileSync(broken, 'utf8'), before)

  const future = newFile()
  writeFileSync(future, 'schemaVersion: 99\nenabled: true\n', 'utf8')
  const futureRead = readInstructionPolicy(future)
  assert.match(futureRead.error ?? '', /schemaVersion/)
  assert.equal(writeInstructionPolicy({ file: future, expectedRevision: futureRead.revision, patch: { files: { f1: { enabled: false } } } }).ok, false)
  assert.equal(readFileSync(future, 'utf8'), 'schemaVersion: 99\nenabled: true\n')
})

test('请求白名单：未知或退役字段与非法逐文件开关、显示名一律拒绝', () => {
  const cases = [
    [{ text: '正文不得进策略文件' }, /未知字段/],
    [{ revision: 'r1' }, /未知字段/],
    [{ defaults: { order: 30 } }, /未知字段/],
    [{ enabled: true }, /未知字段/],
    [{ files: { f1: { enabled: 1 } } }, /enabled/],
    [{ files: { f1: { name: '' } } }, /name/],
    [{ files: { f1: { name: ' ' } } }, /name/],
    [{ files: { f1: { name: null } } }, /name/],
    [{ files: { f1: { dedupe: 'session' } } }, /未知字段/],
    [{ files: { ' ': { enabled: false } } }, /fileId/],
    [{ files: [] }, /files/],
    [{ files: { f1: false } }, /f1/],
    [null, /对象/],
  ]
  for (const [input, pattern] of cases) {
    const result = validateInstructionPolicyPatch(input)
    assert.equal(result.ok, false, `应拒绝：${JSON.stringify(input)}`)
    assert.match(result.message, pattern)
  }
  assert.deepEqual(validateInstructionPolicyPatch({ files: { f1: null, f2: { enabled: false, name: '项目规范' } } }), {
    ok: true,
    patch: { files: { f1: null, f2: { enabled: false, name: '项目规范' } } },
  })
})

test('有效策略：仅显式 false 关闭文件，name 只作显示', () => {
  const policy = {
    files: { f1: { name: '项目规范' }, f2: { enabled: false }, f3: { enabled: true } },
  }
  assert.deepEqual(resolveInstructionPolicy(policy, 'f1'), {
    name: '项目规范',
    enabled: true,
  })
  assert.equal(resolveInstructionPolicy(policy, 'f2').enabled, false)
  assert.equal(resolveInstructionPolicy(policy, 'f3').enabled, true)
  assert.equal(resolveInstructionPolicy(policy, 'unknown').enabled, true)
})

test('文件覆盖删除后回到默认，正文仍不落入策略文件', () => {
  const file = newFile()
  const created = writeInstructionPolicy({ file, expectedRevision: null, patch: { files: { f1: { enabled: false } } } })
  assert.equal(created.ok, true)
  const removed = writeInstructionPolicy({ file, expectedRevision: created.revision, patch: { files: { f1: null } } })
  assert.equal(removed.ok, true)
  assert.equal(resolveInstructionPolicy(readInstructionPolicy(file).policy, 'f1').enabled, true)
  assert.deepEqual(readInstructionPolicy(file).policy.files, {})
  assert.doesNotMatch(readFileSync(file, 'utf8'), /^files:/m, '删除唯一覆盖后不留空壳 files')
})

test('共享 null 锚点不能因局部更新改变其他字段，拒写时保持原字节', () => {
  const file = newFile()
  const raw = Buffer.from('schemaVersion: 1\nfiles:\n  f1: &inherit null\ncustomUnknownKey: *inherit\n')
  writeFileSync(file, raw)
  const before = readInstructionPolicy(file)
  assert.equal(before.error, undefined)
  assert.deepEqual(before.policy.files, {})
  const refused = writeInstructionPolicy({ file, expectedRevision: before.revision, patch: { files: { f1: { enabled: false } } } })
  assert.deepEqual(readFileSync(file), raw, '不能先写坏共享锚点，再在读回阶段报告失败')
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'instructions-policy-invalid')
  assert.match(refused.message, /引用/)
  assert.deepEqual(readInstructionPolicy(file), before)

  const unshared = newFile()
  writeFileSync(unshared, 'schemaVersion: 1\nfiles:\n  f1: &unused null\n')
  const unsharedBefore = readInstructionPolicy(unshared)
  const savedNullAnchor = writeInstructionPolicy({ file: unshared, expectedRevision: unsharedBefore.revision, patch: { files: { f1: { enabled: false } } } })
  assert.equal(savedNullAnchor.ok, true)

  // 页面真实载荷（fileId 是路径 sha256 前 16 位）：文件不存在时新建文档还没有
  // files / files[fileId] 集合，而 `enabled: true` 是缺省态要 deleteIn 删键 ——
  // deleteIn 不会自建中间集合，曾整条请求以 400 空响应结束（webserver 兜底）。
  const fresh = newFile()
  const enabledDefault = writeInstructionPolicy({
    file: fresh,
    expectedRevision: null,
    patch: { files: { a46fcc520645f05a: { enabled: true } } },
  })
  assert.equal(enabledDefault.ok, true, '首次保存 enabled:true 必须成功而不是抛 YAML collection 异常')
  assert.equal(enabledDefault.policy.files.a46fcc520645f05a, undefined, 'true = 缺省态，不落键')

  // 显式 false 与空覆盖各走一条：前者写入键，后者因无剩余字段而整条清掉。
  const explicit = writeInstructionPolicy({
    file: fresh,
    expectedRevision: enabledDefault.revision,
    patch: { files: { a46fcc520645f05a: { enabled: false }, deadbeefdeadbeef: {} } },
  })
  assert.equal(explicit.ok, true)
  assert.equal(explicit.policy.files.a46fcc520645f05a.enabled, false)
  assert.equal(explicit.policy.files.deadbeefdeadbeef, undefined, '只写了缺省态的空覆盖不留空壳')
})
