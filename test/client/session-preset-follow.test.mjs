import { test } from 'node:test'
import assert from 'node:assert/strict'
// lib/client.js 是宿主 ModuleLoader 注册格式（不可 import）；Node 26 直接类型剥离加载 .ts 源。
import { createSessionPresetFollower } from '../../src/client/data/session-preset-follow.ts'

/** 一次检查的事实与动作记录器（默认：目标可跟随、无草稿、已完成加载）。 */
function harness(overrides = {}) {
  const applied = []
  const warned = []
  return {
    applied,
    warned,
    snapshot: {
      sessionPreset: 'pt-standard',
      currentPreset: 'prompt-tool',
      loadedPreset: 'prompt-tool',
      followable: () => true,
      blocked: () => false,
      apply: (id) => { applied.push(id); return Promise.resolve() },
      warn: (id) => { warned.push(id) },
      ...overrides,
    },
  }
}

test('session-preset-follow：一致、缺会话预设或未加载完成都不动作', async () => {
  const follower = createSessionPresetFollower()

  const same = harness({ sessionPreset: 'prompt-tool' })
  await follower.check(same.snapshot)
  const missing = harness({ sessionPreset: undefined })
  await follower.check(missing.snapshot)
  // 已完成加载的预设与当前预设不同（切换/首屏加载进行中）：fields 还不是可写事实。
  const loading = harness({ loadedPreset: 'other' })
  await follower.check(loading.snapshot)
  const never = harness({ loadedPreset: undefined })
  await follower.check(never.snapshot)

  assert.deepEqual(same.applied, [])
  assert.deepEqual(missing.applied, [])
  assert.deepEqual(loading.applied, [])
  assert.deepEqual(never.applied, [])
  assert.deepEqual(same.warned, [])
})

test('session-preset-follow：目标不在插件管理目录时只提示一次，换 id 再提示', async () => {
  const follower = createSessionPresetFollower()
  const run = harness({ followable: (id) => id.startsWith('pt-') })
  run.snapshot.sessionPreset = 'standard'
  await follower.check(run.snapshot)
  await follower.check(run.snapshot)
  assert.deepEqual(run.warned, ['standard'], '同一 id 只提示一次')
  assert.deepEqual(run.applied, [], '不可跟随不得写盘')

  run.snapshot.sessionPreset = 'shipped-other'
  await follower.check(run.snapshot)
  assert.deepEqual(run.warned, ['standard', 'shipped-other'], '换到另一个不可跟随 id 会再提示')
})

test('session-preset-follow：有未保存草稿时保持当前预设（不写盘、不提示）', async () => {
  const follower = createSessionPresetFollower()
  const run = harness({ blocked: () => true })
  await follower.check(run.snapshot)
  assert.deepEqual(run.applied, [])
  assert.deepEqual(run.warned, [])
})

test('session-preset-follow：正常路径调用一次 apply，参数是会话预设', async () => {
  const follower = createSessionPresetFollower()
  const run = harness()
  await follower.check(run.snapshot)
  await follower.check(run.snapshot)
  assert.deepEqual(run.applied, ['pt-standard', 'pt-standard'], '每次检查各自决定（store 侧一致后即不再触发）')
})

test('session-preset-follow：写盘进行中不重复 apply（防重入）', async () => {
  const follower = createSessionPresetFollower()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const applied = []
  const run = harness({ apply: (id) => { applied.push(id); return gate } })
  const first = follower.check(run.snapshot)
  const second = follower.check(run.snapshot)
  release()
  await Promise.all([first, second])
  assert.deepEqual(applied, ['pt-standard'], '并发检查只有一次真正写盘')
})
