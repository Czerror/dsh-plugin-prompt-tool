/** 技能状态刷新装配的行为回归：真实状态文件 + 真实 watcher + 真实重装器。
 *
 *  这里锁住四条曾经写错或容易退化的规则：
 *  1. 状态快照没变（例如只是引用目录里的文件变了）也必须失效清单缓存——旧实现在这里提前返回，
 *     引用目录里新增或删除的技能会永远留在缓存里；
 *  2. **引用目录的候选指纹变化同样要失效候选缓存**——状态快照只来自 skills.yml，引用目录里
 *     新增 / 改写技能不改变快照，不失效就让模型侧永远看不到（界面有、模型没有）；
 *  3. 状态文件读失败不得回落默认状态——否则一个瞬时坏文件会把屏蔽表与引用目录一起清空；
 *  4. 状态文件被删除（`exists:false`）按用户重置处理，但必须留下一条告警。
 *
 *  断言全部落在可观察输出上：accept 收到的状态、各依赖的调用次数与告警文本。 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createSkillsReloader, readSkillsState, writeSkillsState } from '../../lib/index.mjs'
import { createSkillsWatcher } from '../../src/runtime/skills-watcher.ts'

const AT = '2026-09-18T00:00:00.000Z'
const tempDirs = []
function makeStateFile() {
  const dir = mkdtempSync(join(tmpdir(), 'pt-skills-refresh-'))
  tempDirs.push(dir)
  return { dir, file: join(dir, 'skills.yml') }
}
after(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }) })

/** 替身只在依赖边界：状态文件、watcher 与缓存失效的调用点都是真实的，回调记录可观察输出。 */
function makeReloader(file, initialState, candidatesFingerprint = () => 'refs:v1') {
  const calls = { accepted: [], rewatch: 0, invalidateList: 0, invalidateCandidates: 0, warns: [] }
  let snapshot = JSON.stringify(initialState)
  const reloader = createSkillsReloader({
    stateFile: file,
    currentSnapshot: () => snapshot,
    candidatesFingerprint,
    // 与 index.ts 一致：接受后内存快照随之更新，下一次同样内容不再重复替换。
    accept: (state, next) => { calls.accepted.push(state); snapshot = next },
    rewatch: () => { calls.rewatch += 1 },
    invalidateList: () => { calls.invalidateList += 1 },
    invalidateCandidates: () => { calls.invalidateCandidates += 1 },
    warn: (message) => { calls.warns.push(message) },
  })
  return { reloader, calls }
}

test('状态文件变化：替换状态、重挂 watcher 并失效清单与候选缓存', () => {
  const { file } = makeStateFile()
  const written = writeSkillsState({ blocked: [{ name: 'demo', at: AT }], folders: ['D:/referenced'] }, file)
  assert.equal(written.ok, true, written.ok ? '' : written.message)

  const { reloader, calls } = makeReloader(file, { version: 3, blocked: [], folders: [] })
  reloader.reload()
  assert.equal(calls.accepted.length, 1)
  assert.deepEqual(calls.accepted[0].blocked.map((item) => item.name), ['demo'])
  assert.deepEqual(calls.accepted[0].folders, [resolve('D:/referenced')], '引用目录按宿主机绝对路径规范化')
  assert.equal(calls.rewatch, 1, '引用目录集合可能变了，必须重挂')
  assert.equal(calls.invalidateList, 1)
  assert.equal(calls.invalidateCandidates, 1, '屏蔽表变了，候选缓存必须失效')
  assert.deepEqual(calls.warns, [])
})

test('引用目录指纹变化（状态未变）也必须失效候选缓存', () => {
  const { file } = makeStateFile()
  writeSkillsState({ blocked: [{ name: 'demo', at: AT }], folders: [] }, file)
  const current = readSkillsState(file)
  assert.equal(current.ok, true)

  let fingerprint = 'refs:v1'
  const { reloader, calls } = makeReloader(file, current.state, () => fingerprint)
  reloader.reload()
  assert.deepEqual(calls.accepted, [], '状态没变不替换内存状态')
  assert.equal(calls.rewatch, 0, '状态没变不需要重挂 watcher')
  assert.equal(calls.invalidateList, 1, '这正是曾经的缺陷：提前返回会让引用目录的新技能永远不出现')
  assert.equal(calls.invalidateCandidates, 0, '引用目录没变时不让官方提供者重扫')

  // 引用目录里新增 / 改写技能：状态快照不变，但模型侧候选必须跟着失效。
  fingerprint = 'refs:v2'
  reloader.reload()
  assert.equal(calls.accepted.length, 0, '状态快照仍然没变')
  assert.equal(calls.invalidateList, 2)
  assert.equal(calls.invalidateCandidates, 1, '引用目录变了，候选缓存必须失效，否则模型侧看不到新技能')
})

test('状态文件损坏：保留上一次有效状态、只告警一次，修好后自动恢复', () => {
  const { file } = makeStateFile()
  writeSkillsState({ blocked: [{ name: 'demo', at: AT }], folders: ['D:/referenced'] }, file)
  const valid = readSkillsState(file)
  assert.equal(valid.ok, true)

  const { reloader, calls } = makeReloader(file, valid.state)
  writeFileSync(file, 'version: 3\nblocked: [oops\n', 'utf8')
  reloader.reload()
  assert.deepEqual(calls.accepted, [], '坏文件不得清空内存里的屏蔽表与引用目录')
  assert.equal(calls.invalidateList, 1, '文件系统确实动过，清单缓存仍要失效')
  assert.equal(calls.invalidateCandidates, 0, '读不出状态就不该动候选缓存')
  assert.equal(calls.warns.length, 1)
  assert.match(calls.warns[0], /保留上一次有效状态/u)

  reloader.reload()
  assert.equal(calls.warns.length, 1, '同一故障窗口只告警一次，不刷日志')
  assert.equal(calls.invalidateList, 2)

  rmSync(file, { force: true })
  writeSkillsState({ blocked: [], folders: [] }, file)
  reloader.reload()
  assert.equal(calls.accepted.length, 1, '恢复后接受新的合法状态')
  assert.deepEqual(calls.accepted[0].blocked, [])
  assert.equal(calls.warns.length, 1, '恢复后不再新增告警')
})

test('状态文件被删除：按空状态处理，但要告警一次', () => {
  const { file } = makeStateFile()
  writeSkillsState({ blocked: [{ name: 'demo', at: AT }], folders: [] }, file)
  const valid = readSkillsState(file)
  assert.equal(valid.ok, true)

  const { reloader, calls } = makeReloader(file, valid.state)
  rmSync(file, { force: true })
  reloader.reload()
  assert.equal(calls.accepted.length, 1, '文件消失按用户重置处理')
  assert.deepEqual(calls.accepted[0].blocked, [])
  assert.equal(calls.warns.length, 1, '不能让设置悄悄消失')
  assert.match(calls.warns[0], /状态文件不存在/u)

  reloader.reload()
  assert.equal(calls.warns.length, 1, '同一缺失状态只告警一次')
  assert.equal(calls.invalidateCandidates, 1, '第二次快照已同步，不再算变化')

  writeSkillsState({ blocked: [{ name: 'demo', at: AT }], folders: [] }, file)
  reloader.reload()
  assert.equal(calls.accepted.length, 2, '文件回来后状态恢复')
  assert.equal(calls.warns.length, 1, '恢复本身不再额外告警')
})

test('真实装配：状态文件写入经 watcher 走完整条刷新链路', async () => {
  const { dir, file } = makeStateFile()
  writeSkillsState({ blocked: [], folders: [] }, file)
  const initial = readSkillsState(file)
  assert.equal(initial.ok, true)

  const { reloader, calls } = makeReloader(file, initial.state)
  const watcher = createSkillsWatcher(() => [dir], () => { reloader.reload() })
  try {
    watcher.watch()
    writeSkillsState({ blocked: [{ name: 'demo', at: AT }], folders: [] }, file)
    const deadline = Date.now() + 5000
    while (calls.accepted.length === 0 && Date.now() < deadline) await sleep(50)
    assert.equal(calls.accepted.length, 1,
      `watcher 事件必须走完整个刷新装配（invalidateList=${calls.invalidateList}，warns=${calls.warns.length}）`)
    assert.deepEqual(calls.accepted[0].blocked.map((item) => item.name), ['demo'])
    assert.equal(calls.invalidateList >= 1, true)
  } finally {
    watcher.close()
  }
})
