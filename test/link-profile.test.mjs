import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decideLinkAction, familyPackages } from '../scripts/link-profile.mjs'

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
