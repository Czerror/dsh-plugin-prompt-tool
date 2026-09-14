import test from 'node:test'
import assert from 'node:assert/strict'
import { OFFICIAL_UPSTREAM, PRESET_SOURCE_PATH, verifyLatestCompositionSource } from '../../scripts/composition-source.mjs'

const sha = 'a'.repeat(40)
const repo = 'D:/isolated/upstream'
const fakeGit = (head = sha, dirty = '', remote = `${sha}\trefs/heads/master`) => (args) => {
  if (args[0] === 'ls-remote') {
    assert.deepEqual(args, ['ls-remote', OFFICIAL_UPSTREAM, 'refs/heads/master'])
    return remote
  }
  assert.deepEqual(args.slice(0, 2), ['-C', repo])
  if (args[2] === 'rev-parse') return head
  assert.deepEqual(args.slice(2), ['status', '--porcelain', '--untracked-files=all', '--', PRESET_SOURCE_PATH])
  return dirty
}

test('官方来源：接受已核验最新 HEAD，不绑定发布版本号', () => {
  assert.deepEqual(verifyLatestCompositionSource(repo, fakeGit()), { label: 'master', commit: sha })
  const next = 'b'.repeat(40)
  assert.deepEqual(verifyLatestCompositionSource(repo, fakeGit(next, '', `${next}\trefs/heads/master`)), { label: 'master', commit: next })
})

test('官方来源：过期 checkout、预设局部修改和未知远端均拒绝', () => {
  assert.throws(() => verifyLatestCompositionSource(repo, fakeGit('b'.repeat(40))), /source is stale/)
  assert.throws(() => verifyLatestCompositionSource(repo, fakeGit(sha, ' M packages/preset/agent-presets/presets/standard/agent.cordis.yml')), /local changes/)
  assert.throws(() => verifyLatestCompositionSource(repo, fakeGit(sha, '', '')), /invalid remote HEAD/)
  assert.throws(() => verifyLatestCompositionSource(repo, fakeGit(sha, '', `${sha}\trefs/heads/release`)), /invalid remote HEAD/)
})

test('官方来源：网络核验失败不能回落旧版本或继续生成', () => {
  assert.throws(() => verifyLatestCompositionSource(repo, () => { throw new Error('offline') }), /offline/)
})
