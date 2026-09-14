// 指令文件卡策略（W2 host 叶子模块）：
// 独立存储、默认禁用、Document API 保留注释与未知字段、乐观并发、损坏拒绝写入。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultInstructionPolicy,
  readInstructionPolicy,
  resolveInstructionPolicy,
  instructionPolicyPath,
  validateInstructionPolicyPatch,
  writeInstructionPolicy,
} from '../../src/host/instructions-policy.ts'

const root = mkdtempSync(join(tmpdir(), 'pt-instructions-policy-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

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
