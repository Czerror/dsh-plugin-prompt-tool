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

test('semver：精确开发基线拒绝 alpha/rc.1/非法版本', () => {
  assert.equal(isExactBaseline(DSH_BASELINE, DSH_BASELINE), true)
  assert.equal(isExactBaseline('0.1.5-rc.1', DSH_BASELINE), false)
  assert.equal(isExactBaseline('0.1.5-alpha.1', DSH_BASELINE), false)
  assert.equal(isExactBaseline('0.1.5', DSH_BASELINE), false)
  assert.equal(isExactBaseline('nope', DSH_BASELINE), false)
  assert.equal(expectedDevBaseline('@deepseek-ai/dsh-tools'), DSH_BASELINE)
  assert.equal(expectedDevBaseline('@deepseek-ai/cordis'), CORDIS_BASELINE)
  assert.equal(expectedDevBaseline('yaml'), undefined)
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
  assert.equal(manifest.peerDependencies['@deepseek-ai/schemastery'], '^3.18.1', 'schemastery 不随 DSH 系列升版')

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
    assert.ok(manifest.devDependencies[name] === DSH_BASELINE || manifest.devDependencies[name] === '7.8.5', `${name} 应在 devDependencies`)
    assert.ok(consumed.has(name), `${name} 已声明但没有消费方（需 import／类型测试／脚本使用）`)
  }
})
