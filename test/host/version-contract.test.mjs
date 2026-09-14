/**
 * 官方发布基线与依赖声明契约（W0）。
 *
 * 锁三件事：
 *   1. 版本判定本身——`^0.1.5-alpha.1` 本来就接受 rc.2，开发基线则必须精确等值；
 *   2. 解析目标——已安装官方包必须来自仓库 node_modules（.pnpm 真实目录），
 *      不能是 `link:../deepseek-harness/...` 的源码目录；
 *   3. 声明完整性——package.json 的 peer/dev 面与源码实际消费的官方包一致，
 *      且本轮新增依赖都有真实消费者。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  CORDIS_BASELINE,
  DSH_BASELINE,
  OFFICIAL_SCOPE,
  dependencyVersionProblems,
  expectedDevBaseline,
  isExactBaseline,
  isRepoLocalResolution,
  moduleImports,
  officialImports,
  peerRangeAccepts,
} from '../../scripts/host-contracts-lib.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

test('semver：预发布范围判定不再误诊 rc.2', () => {
  assert.equal(peerRangeAccepts('^0.1.5-alpha.1', '0.1.5-rc.2'), true, 'alpha.1 下限本来就接受 rc.2')
  assert.equal(peerRangeAccepts('^0.1.5-alpha.1', '0.1.5-rc.1'), true)
  assert.equal(peerRangeAccepts('^0.1.5-rc.2', '0.1.5-rc.2'), true)
  assert.equal(peerRangeAccepts('^0.1.5-rc.2', '0.1.5-rc.1'), false, 'rc.2 下限拒绝 rc.1')
  assert.equal(peerRangeAccepts('^0.1.5-rc.2', '0.1.5-alpha.1'), false, 'rc.2 下限拒绝 alpha.1')
  assert.equal(peerRangeAccepts('^0.1.5-rc.2', '0.2.0'), false, '0.x 的 caret 不跨次版本')
  assert.equal(peerRangeAccepts('^0.1.5-rc.2', 'not-a-version'), false, '非法版本必须拒绝')
})

test('semver：精确开发基线拒绝不同版本与无效解析结果', () => {
  assert.equal(isExactBaseline('0.1.5-rc.2', '0.1.5-rc.2'), true)
  for (const version of ['0.1.5-rc.1', '0.1.5-alpha.1', '0.1.5', 'nope']) {
    assert.equal(isExactBaseline(version, '0.1.5-rc.2'), false)
  }
  for (const version of [undefined, null, 123, {}, '', 'latest', '*', 'v1.2.3', ' 1.2.3 ', '01.2.3', '1.2.3-rc.01']) {
    assert.equal(isExactBaseline(version, version), false, `${String(version)} 不是精确 semver`)
  }
  assert.equal(isExactBaseline('nope', null), false, '解析失败不能命中空基线')
  assert.equal(isExactBaseline('1.2.3+build.1', '1.2.3+build.1'), true)
  assert.equal(isExactBaseline('1.2.3+build.1', '1.2.3+build.2'), false)
})

function versionManifest(dsh, cordis) {
  return {
    devDependencies: {
      '@deepseek-ai/dsh-agent': dsh,
      '@deepseek-ai/dsh-tools': dsh,
      '@deepseek-ai/cordis': cordis,
    },
    peerDependencies: {
      '@deepseek-ai/dsh-tools': `^${dsh}`,
      '@deepseek-ai/dsh-system-prompt': `^${dsh}`,
      '@deepseek-ai/cordis': `^${cordis}`,
    },
    dependencies: { '@deepseek-ai/dsh-api-remotes': `^${dsh}` },
  }
}

test('发布基线：跟随 manifest 显式选择，不把 rc.2 固化为永久版本', () => {
  for (const [dsh, cordis] of [
    ['0.1.5-rc.2', '4.0.2'],
    ['0.1.5', '4.0.3'],
    ['0.2.0-rc.1', '5.0.0-beta.2'],
    ['1.0.0+build.1', '6.0.0+build.2'],
  ]) {
    const selected = versionManifest(dsh, cordis)
    assert.equal(expectedDevBaseline('@deepseek-ai/dsh-agent', selected), dsh)
    assert.equal(expectedDevBaseline('@deepseek-ai/dsh-tools', selected), dsh)
    assert.equal(expectedDevBaseline('@deepseek-ai/cordis', selected), cordis)
    for (const [section, dependencies] of Object.entries(selected)) {
      for (const name of Object.keys(dependencies)) {
        const installed = name === '@deepseek-ai/cordis' ? cordis : dsh
        assert.deepEqual(dependencyVersionProblems(name, section, installed, selected), [], `${section}.${name}@${installed}`)
      }
    }
  }
})

test('发布基线：缺失、标签、范围和非法 semver 必须失败', () => {
  for (const name of ['@deepseek-ai/dsh-agent', '@deepseek-ai/cordis']) {
    for (const version of [undefined, null, 123, {}, '', 'latest', 'next', '*', '^0.2.0', '~0.2.0', '>=0.2.0', '0.2', 'v0.2.0', ' 0.2.0 ', '0.2.0-rc.01', 'nope']) {
      const selected = versionManifest('0.2.0', '4.1.0')
      selected.devDependencies[name] = version
      assert.throws(() => expectedDevBaseline(name, selected), /精确 semver/, `${name}: ${String(version)}`)
    }
    assert.throws(() => expectedDevBaseline(name, {}), /精确 semver/)
  }
})

test('发布基线：保留内部导出，非 DSH 包不误用 DSH 版本', () => {
  assert.equal(DSH_BASELINE, manifest.devDependencies['@deepseek-ai/dsh-agent'])
  assert.equal(CORDIS_BASELINE, manifest.devDependencies['@deepseek-ai/cordis'])
  assert.equal(expectedDevBaseline('@deepseek-ai/dsh-tools'), DSH_BASELINE)
  assert.equal(expectedDevBaseline('@deepseek-ai/cordis'), CORDIS_BASELINE)
  assert.equal(expectedDevBaseline('@deepseek-ai/schemastery'), undefined)
  assert.equal(expectedDevBaseline('yaml'), undefined)
})

test('依赖版本：DSH 与 Cordis 安装必须命中已选版本，不能只满足宽范围', () => {
  const selected = versionManifest('0.2.0', '4.1.0')
  for (const [section, dependencies] of Object.entries(selected)) {
    for (const name of Object.keys(dependencies)) {
      const drift = name === '@deepseek-ai/cordis' ? '4.1.1' : '0.2.1'
      for (const installed of [drift, undefined, null, 'nope']) {
        assert.ok(dependencyVersionProblems(name, section, installed, selected).some((problem) => problem.includes('不等于基线')))
      }
    }
  }
})

test('依赖版本：官方 dev 声明必须精确，DSH 必须与主 dsh-agent 一致', () => {
  const selected = versionManifest('0.2.0', '4.1.0')
  for (const range of ['latest', '*', '^0.2.0', '0.2.1', null, undefined, 'nope']) {
    selected.devDependencies['@deepseek-ai/dsh-tools'] = range
    assert.ok(dependencyVersionProblems('@deepseek-ai/dsh-tools', 'devDependencies', '0.2.0', selected).some((problem) => problem.includes('dev 声明')))
  }
  const name = '@deepseek-ai/schemastery'
  selected.devDependencies[name] = '3.19.0'
  assert.deepEqual(dependencyVersionProblems(name, 'devDependencies', '3.19.0', selected), [])
  selected.devDependencies[name] = '^3.19.0'
  assert.ok(dependencyVersionProblems(name, 'devDependencies', '3.19.0', selected).some((problem) => problem.includes('精确 semver')))
})

test('依赖版本：命中基线也不能跳过 peer 与运行依赖的声明范围', () => {
  const selected = versionManifest('0.2.0', '4.1.0')
  const name = '@deepseek-ai/dsh-tools'
  for (const section of ['peerDependencies', 'dependencies']) {
    selected[section][name] = '^0.3.0'
    assert.ok(dependencyVersionProblems(name, section, '0.2.0', selected).some((problem) => problem.includes(`不满足 ${section} 范围`)))
  }
})

test('解析目标：只接受仓库内 node_modules，拒绝同级源码 link', () => {
  const repoRoot = 'D:\\work\\plugin'
  assert.equal(
    isRepoLocalResolution('D:\\work\\plugin\\node_modules\\.pnpm\\dsh-tools@0.1.5-rc.2\\node_modules\\@deepseek-ai\\dsh-tools', repoRoot),
    true,
  )
  assert.equal(isRepoLocalResolution('D:\\work\\deepseek-harness\\packages\\core\\tools', repoRoot), false, '同级源码目录必须失败')
  assert.equal(isRepoLocalResolution('D:\\work\\plugin\\packages\\tools', repoRoot), false, '仓库内非 node_modules 也失败')
  assert.equal(isRepoLocalResolution('', repoRoot), false)
  assert.equal(isRepoLocalResolution(undefined, repoRoot), false)
})

test('模块边提取：只认 import 形式，字符串常量不算消费', () => {
  const source = [
    "import type { Context } from '@deepseek-ai/dsh-tools'",
    "import { emit } from '@deepseek-ai/dsh-client-ui-slots/client'",
    "const lazy = await import('@deepseek-ai/dsh-client-locale')",
    "const FALLBACK_BUNDLE = '@deepseek-ai/dsh-web-app'",
    '// 官方行名 @deepseek-ai/dsh-persona 由顶层 persona 段表达',
    "import { createRequire } from 'node:module'",
    "import semver from 'semver'",
  ].join('\n')
  assert.deepEqual(officialImports(source), [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-tools',
  ])
  assert.deepEqual(moduleImports(source), [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-tools',
    'semver',
  ])
})

test('package.json：peer 接受基线，dev 精确锁定基线', () => {
  const isDshPackage = (name) => name.startsWith(`${OFFICIAL_SCOPE}dsh-`)
  const peers = Object.entries(manifest.peerDependencies).filter(([name]) => isDshPackage(name))
  assert.ok(peers.length > 0, 'peer 声明不能为空')
  for (const [name, range] of peers) {
    assert.equal(peerRangeAccepts(range, DSH_BASELINE), true, `${name} 的 peer 范围 ${range} 必须接受 ${DSH_BASELINE}`)
  }
  assert.equal(peerRangeAccepts(manifest.peerDependencies['@deepseek-ai/cordis'], CORDIS_BASELINE), true)

  const devs = Object.entries(manifest.devDependencies).filter(([name]) => isDshPackage(name))
  assert.ok(devs.length > 0, 'dev 声明不能为空')
  for (const [name, range] of devs) {
    assert.equal(range, expectedDevBaseline(name), `${name} 的 dev 声明必须是精确基线`)
  }
  assert.equal(manifest.devDependencies['@deepseek-ai/cordis'], CORDIS_BASELINE)
})

test('新增直接依赖都有真实消费者（D-02）', () => {
  const consumed = new Set()
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.name === 'node_modules' || item.name === 'fixtures') continue
      const target = join(dir, item.name)
      if (item.isDirectory()) walk(target)
      else if (/\.(?:ts|tsx|mts|mjs)$/.test(item.name)) {
        for (const name of moduleImports(readFileSync(target, 'utf8'))) consumed.add(name)
      }
    }
  }
  for (const dir of ['src', 'scripts', 'test']) walk(join(ROOT, dir))

  const added = [
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-agent-default-model',
    '@deepseek-ai/dsh-subagent',
    '@deepseek-ai/dsh-tool-subagent',
    '@deepseek-ai/dsh-package-manifest',
    '@deepseek-ai/dsh-client-locale',
    'semver',
  ]
  for (const name of added) {
    assert.ok(Object.hasOwn(manifest.devDependencies, name), `${name} 应在 devDependencies`)
    assert.ok(consumed.has(name), `${name} 已声明但没有消费方（需 import／类型测试／脚本使用）`)
  }
})
