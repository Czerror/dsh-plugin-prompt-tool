import assert from 'node:assert/strict'
import test from 'node:test'
import * as contracts from '../../scripts/host-contracts-lib.mjs'

const name = '@deepseek-ai/dsh-agent'
const version = '0.2.3-alpha.2'
const manifest = { devDependencies: { [name]: version } }
const locked = { specifier: version, version }

test('registry 锁定版本与安装版本一致时通过，漂移时失败', () => {
  assert.deepEqual(contracts.dependencyVersionProblems(name, 'devDependencies', version, manifest, locked), [])
  assert.ok(contracts.dependencyVersionProblems(name, 'devDependencies', '0.2.3-alpha.3', manifest, locked).length > 0)
})

test('file 源码 hook 不能替代 registry 锁定输入', () => {
  const source = { path: '.scratch/harness/packages/agent.tgz', version }
  const fileLock = { specifier: `file:${source.path}`, version: `file:${source.path}` }
  assert.ok(contracts.dependencyVersionProblems(name, 'devDependencies', version, manifest, fileLock, source).length > 0)
})

test('registry 图记录必须有对应版本及完整性，拒绝 file 产物', () => {
  const record = { resolution: { integrity: 'sha512-dGVzdA==' } }
  assert.deepEqual(contracts.registryPackageProblems(name, version, { packages: { [`${name}@${version}`]: record } }), [])
  assert.ok(contracts.registryPackageProblems(name, version, { packages: {} }).length > 0)
  assert.ok(contracts.registryPackageProblems(name, version, { packages: { [`${name}@${version}`]: { resolution: {} } } }).length > 0)
  assert.ok(contracts.registryPackageProblems(name, version, { packages: { [`${name}@${version}`]: { resolution: { ...record.resolution, tarball: 'file:agent.tgz' } } } }).length > 0)
})

test('根安装图允许仓库内 pnpm 实例，拒绝仓库外源码 link', () => {
  assert.equal(contracts.isRepoLocalResolution('D:/repo/node_modules/.pnpm/pkg/node_modules/pkg', 'D:/repo'), true)
  assert.equal(contracts.isRepoLocalResolution('D:/deepseek-harness/packages/pkg', 'D:/repo'), false)
})
