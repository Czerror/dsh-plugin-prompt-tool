import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

// 直接验证源码（watcher 未从 lib/index.mjs 导出），不依赖 build。
const watcherUrl = new URL('../../src/runtime/skills-watcher.ts', import.meta.url).href

test('watcher：技能目录被删除后释放句柄，进程能正常退出', () => {
  // Windows 删除被 watch 的目录会持续上报事件（实测每秒十万级）：未关闭句柄时
  // 防抖计时器被反复重置，进程永不退出（曾让 preset-default-sync 用例挂死）。
  // 该症状只在进程退出时机上可见，所以用子进程断言「删目录后能自然退出」。
  const script = `
    import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { createSkillsWatcher } from ${JSON.stringify(watcherUrl)}
    const dir = mkdtempSync(join(tmpdir(), 'pt-watch-child-'))
    mkdirSync(join(dir, 'skill-a'), { recursive: true })
    createSkillsWatcher(() => [dir], () => {}).watch()
    // 等待 OS 侧注册完成，否则删除动作可能早于 watch 生效而观察不到事件。
    await new Promise((resolve) => setTimeout(resolve, 500))
    rmSync(dir, { recursive: true, force: true })
    // 模拟长活宿主：洪泛期间仍有 ref 计时器时，未关闭的 watcher 会永远重置防抖。
    await new Promise((resolve) => setTimeout(resolve, 1500))
  `
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'pipe', timeout: 15000 })
  }, '技能目录被删除后 watcher 必须释放句柄，否则进程无法退出')
})
