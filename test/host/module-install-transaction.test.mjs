import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tempDir } from '../fixtures/host-harness.mjs'
import { directoryVersionOf } from '../../src/host/preview-revision.ts'
import { installModuleDirectory } from '../../src/host/module-install-transaction.ts'

const definition = (id) => `id: ${id}\n`
const writeDefinition = (dir, id) => writeFileSync(join(dir, 'module.yml'), definition(id))
const makeTarget = (root, id) => {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeDefinition(dir, id)
  return dir
}
const hidden = (root) => readdirSync(root).filter((name) => name.startsWith('.'))

test('create：目标缺失时安装候选，且不残留 stage', () => {
  const root = tempDir('pt-install-tx-')
  const result = installModuleDirectory({
    root,
    id: 'new',
    expectedVersion: null,
    build: (candidate) => {
      writeDefinition(candidate, 'new')
      writeFileSync(join(candidate, 'user.txt'), 'USER')
    },
  })
  assert.deepEqual(result, { state: 'installed' })
  assert.equal(readFileSync(join(root, 'new', 'module.yml'), 'utf8'), definition('new'))
  assert.equal(readFileSync(join(root, 'new', 'user.txt'), 'utf8'), 'USER')
  assert.deepEqual(hidden(root), [])
})

test('target-exists：expectedVersion=null 时目标已存在即冲突，旧目标不动', () => {
  const root = tempDir('pt-install-tx-')
  const target = makeTarget(root, 'existing')
  const before = readFileSync(join(target, 'module.yml'), 'utf8')
  const result = installModuleDirectory({
    root,
    id: 'existing',
    expectedVersion: null,
    build: (candidate) => writeDefinition(candidate, 'replaced'),
  })
  assert.equal(result.state, 'conflict')
  assert.equal(typeof result.actualVersion, 'string')
  assert.equal(readFileSync(join(target, 'module.yml'), 'utf8'), before)
  assert.deepEqual(hidden(root), [])
})

test('replace：版本一致时整目录替换，旧文件不留在新目标', () => {
  const root = tempDir('pt-install-tx-')
  const target = makeTarget(root, 'existing')
  writeFileSync(join(target, 'old.txt'), 'OLD')
  const result = installModuleDirectory({
    root,
    id: 'existing',
    expectedVersion: directoryVersionOf(target),
    build: (candidate) => {
      writeDefinition(candidate, 'existing')
      writeFileSync(join(candidate, 'new.txt'), 'NEW')
    },
  })
  assert.deepEqual(result, { state: 'installed' })
  assert.equal(readFileSync(join(target, 'new.txt'), 'utf8'), 'NEW')
  assert.equal(existsSync(join(target, 'old.txt')), false, '整目录替换不保留旧目标里的文件')
  assert.deepEqual(hidden(root), [])
})

test('version-changed：build 期间目标被改则冲突，不覆盖并发写入', () => {
  const root = tempDir('pt-install-tx-')
  const target = makeTarget(root, 'existing')
  const expectedVersion = directoryVersionOf(target)
  const result = installModuleDirectory({
    root,
    id: 'existing',
    expectedVersion,
    build: (candidate) => {
      writeDefinition(candidate, 'existing')
      writeFileSync(join(target, 'concurrent.txt'), 'CONCURRENT')
    },
  })
  assert.equal(result.state, 'conflict')
  assert.equal(readFileSync(join(target, 'concurrent.txt'), 'utf8'), 'CONCURRENT')
  assert.equal(readFileSync(join(target, 'module.yml'), 'utf8'), definition('existing'))
  assert.deepEqual(hidden(root), [])
})

test('build 抛错：原目标不动，stage 清理后错误原样抛出', () => {
  const root = tempDir('pt-install-tx-')
  const target = makeTarget(root, 'existing')
  const before = readFileSync(join(target, 'module.yml'), 'utf8')
  assert.throws(() => installModuleDirectory({
    root,
    id: 'existing',
    expectedVersion: directoryVersionOf(target),
    build: () => { throw new Error('build failed') },
  }), /build failed/)
  assert.equal(readFileSync(join(target, 'module.yml'), 'utf8'), before)
  assert.deepEqual(hidden(root), [])
})

test('signal：build 期间取消则不碰目标，stage 清理', () => {
  const root = tempDir('pt-install-tx-')
  const target = makeTarget(root, 'existing')
  const before = readFileSync(join(target, 'module.yml'), 'utf8')
  const controller = new AbortController()
  assert.throws(() => installModuleDirectory({
    root,
    id: 'existing',
    expectedVersion: directoryVersionOf(target),
    signal: controller.signal,
    build: (candidate) => {
      writeDefinition(candidate, 'existing')
      controller.abort()
    },
  }), /abort/i)
  assert.equal(readFileSync(join(target, 'module.yml'), 'utf8'), before)
  assert.deepEqual(hidden(root), [])
})

test('非法 id 在创建 stage 前拒绝', () => {
  const root = tempDir('pt-install-tx-')
  assert.throws(() => installModuleDirectory({
    root,
    id: '../escape',
    expectedVersion: null,
    build: () => {},
  }), /非法模块 id/)
  assert.deepEqual(hidden(root), [])
})

const basenameOf = (path) => String(path).split(/[\\/]/).pop()

function withPatchedFs({ rename, rm }, action) {
  const originalRename = fs.renameSync
  const originalRm = fs.rmSync
  if (rename !== undefined) fs.renameSync = rename(originalRename)
  if (rm !== undefined) fs.rmSync = rm(originalRm)
  syncBuiltinESMExports()
  try {
    return action()
  } finally {
    fs.renameSync = originalRename
    fs.rmSync = originalRm
    syncBuiltinESMExports()
  }
}

test('swap 与恢复都失败：返回 recovery-required，备份保留', () => {
  const root = tempDir('pt-install-tx-')
  const target = makeTarget(root, 'existing')
  const result = withPatchedFs({
    rename: (original) => (from, to) => {
      if (to === target && basenameOf(from) === 'existing') throw new Error('swap failed')
      if (to === target && basenameOf(from) === 'previous') throw new Error('restore failed')
      return original(from, to)
    },
  }, () => installModuleDirectory({
    root,
    id: 'existing',
    expectedVersion: directoryVersionOf(target),
    build: (candidate) => writeDefinition(candidate, 'existing'),
  }))
  assert.equal(result.state, 'recovery-required')
  assert.equal(existsSync(result.backupPath), true)
  assert.equal(readFileSync(join(result.backupPath, 'module.yml'), 'utf8'), definition('existing'))
  assert.equal(existsSync(target), false, '恢复失败时目标暂时缺失，备份是唯一旧副本')
  assert.ok(result.backupPath.includes('.install-'), '备份留在本次 stage 内')
  assert.ok(hidden(root).length > 0, '恢复失败不得清理 stage')
})

test('交换成功但清理失败：返回 installed + leftoverStage', () => {
  const root = tempDir('pt-install-tx-')
  const target = makeTarget(root, 'existing')
  let leftoverStage
  const result = withPatchedFs({
    rm: (original) => (path, options) => {
      if (String(path).includes('.install-')) throw new Error('cleanup failed')
      return original(path, options)
    },
  }, () => installModuleDirectory({
    root,
    id: 'existing',
    expectedVersion: directoryVersionOf(target),
    build: (candidate) => writeDefinition(candidate, 'existing'),
  }))
  assert.equal(result.state, 'installed')
  assert.equal(typeof result.leftoverStage, 'string')
  assert.equal(readFileSync(join(target, 'module.yml'), 'utf8'), definition('existing'))
  leftoverStage = result.leftoverStage
  rmSync(leftoverStage, { recursive: true, force: true })
  assert.deepEqual(hidden(root), [])
})
