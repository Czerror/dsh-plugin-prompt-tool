import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { decideLinkAction, familyPackages, resolveDshHomeArg } from '../../scripts/link-profile.mjs'

test('decideLinkAction 四个分支', () => {
  assert.equal(decideLinkAction('missing', '/a', null), 'create')
  assert.equal(decideLinkAction('symlink', '/a', '/a'), 'keep')
  assert.equal(decideLinkAction('symlink', '/a', '/b'), 'replace')
  assert.equal(decideLinkAction('dir', '/a', null), 'skip-report')
  assert.equal(decideLinkAction('file', '/a', null), 'skip-report')
})

test('familyPackages 只收 @linxin666 开头的包', () => {
  const root = mkdtempSync(join(tmpdir(), 'lp-test-'))
  const mk = (p, name) => {
    mkdirSync(p, { recursive: true })
    writeFileSync(join(p, 'package.json'), JSON.stringify({ name }))
  }
  mk(join(root, 'packages', 'dsh-web-ui-all'), '@linxin666/dsh-web-ui-all')
  mk(join(root, 'packages', 'skins', 'skin-center'), '@linxin666/dsh-client-ui-skin-center')
  mk(join(root, 'packages', 'other'), 'not-family')
  mkdirSync(join(root, 'packages', 'no-pkg'))
  const found = familyPackages(root).map((p) => p.name).sort()
  assert.deepEqual(found, ['dsh-client-ui-skin-center', 'dsh-web-ui-all'])
  rmSync(root, { recursive: true, force: true })
})

test('resolveDshHomeArg 优先级与官方 resolveDshHome 一致', () => {
  // $DSH_HOME 命中
  assert.equal(resolveDshHomeArg([], { DSH_HOME: 'D:\\AI\\DeepSeek harness\\.dsh' }), 'D:\\AI\\DeepSeek harness\\.dsh')
  // --dsh-home 最高，且支持 ~ 展开
  assert.equal(resolveDshHomeArg(['--dsh-home', '~/x'], { DSH_HOME: '/other' }), join(homedir(), 'x'))
  // 空白 DSH_HOME 视为未设置 → ~/.dsh（不读 HOME）
  assert.equal(resolveDshHomeArg([], { DSH_HOME: '   ', HOME: 'Z:\\fake' }), join(homedir(), '.dsh'))
  // 无任何来源 → ~/.dsh
  assert.equal(resolveDshHomeArg([], {}), join(homedir(), '.dsh'))
})
