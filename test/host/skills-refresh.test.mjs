/** 技能状态刷新装配的行为回归：真实状态文件 + 真实 watcher + 真实重装器。
 *
 *  这里锁住四条曾经写错或容易退化的规则：
 *  1. 状态快照没变（例如只是引用目录里的文件变了）也必须失效清单缓存——旧实现在这里提前返回，
 *     引用目录里新增或删除的技能会永远留在缓存里；
 *  2. **引用目录的候选指纹变化同样要失效候选缓存**——状态快照只来自 skills.yml，引用目录里
 *     新增 / 改写技能不改变快照，不失效就让模型侧永远看不到（界面有、模型没有）；
 *  3. 状态文件读失败不得回落默认状态——否则一个瞬时坏文件会把状态与引用目录一起清空；
 *  4. 状态文件被删除（`exists:false`）按用户重置处理，但必须留下一条告警。
 *
 *  断言全部落在可观察输出上：accept 收到的状态、各依赖的调用次数与告警文本。
 *  状态文件是 v4（只有引用目录）：调用策略逐条写在技能文件里，不再进这个文件。 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createSkillsReloader, readSkillsState, writeSkillsState } from '../../lib/index.mjs'
import { createSkillsWatcher } from '../../src/runtime/skills-watcher.ts'

const tempDirs = []
function makeStateFile() {
  const dir = mkdtempSync(join(tmpdir(), 'pt-skills-refresh-'))
  tempDirs.push(dir)
  return { dir, file: join(dir, 'skills.yml') }
}
after(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }) })

/** 替身只在依赖边界：状态文件、watcher 与缓存失效的调用点都是真实的，回调记录可观察输出。 */
function makeReloader(file, initialState) {
  const calls = { accepted: [], rewatch: 0, invalidateList: 0, invalidateCandidates: 0, warns: [] }
  let snapshot = JSON.stringify(initialState)
  const reloader = createSkillsReloader({
    stateFile: file,
    currentSnapshot: () => snapshot,
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
  const written = writeSkillsState({ folders: ['D:/referenced'] }, file)
  assert.equal(written.ok, true, written.ok ? '' : written.message)

  const { reloader, calls } = makeReloader(file, { version: 4, folders: [] })
  reloader.reload()
  assert.equal(calls.accepted.length, 1)
  assert.equal('blocked' in calls.accepted[0], false, 'v4 状态不再有屏蔽表')
  assert.deepEqual(calls.accepted[0].folders, [resolve('D:/referenced')], '引用目录按宿主机绝对路径规范化')
  assert.equal(calls.rewatch, 1, '引用目录集合可能变了，必须重挂')
  assert.equal(calls.invalidateList, 1)
  assert.equal(calls.invalidateCandidates, 1, '状态变了，候选缓存必须失效')
  assert.deepEqual(calls.warns, [])
})

test('文件事件直接失效候选缓存，不依赖状态变化或时间戳粒度', () => {
  const { file } = makeStateFile()
  writeSkillsState({ folders: [] }, file)
  const current = readSkillsState(file)
  assert.equal(current.ok, true)

  const { reloader, calls } = makeReloader(file, current.state)
  reloader.reload()
  assert.deepEqual(calls.accepted, [], '状态没变不替换内存状态')
  assert.equal(calls.rewatch, 0, '状态没变不需要重挂 watcher')
  assert.equal(calls.invalidateList, 1, '这正是曾经的缺陷：提前返回会让引用目录的新技能永远不出现')
  assert.equal(calls.invalidateCandidates, 1, '事件直接失效，等长改写也能刷新')

  // 引用目录里新增 / 改写技能：状态快照不变，但模型侧候选必须跟着失效。
  reloader.reload()
  assert.equal(calls.accepted.length, 0, '状态快照仍然没变')
  assert.equal(calls.invalidateList, 2)
  assert.equal(calls.invalidateCandidates, 2, '后续事件仍失效候选')
})

test('状态文件损坏：保留上一次有效状态、只告警一次，修好后自动恢复', () => {
  const { file } = makeStateFile()
  writeSkillsState({ folders: ['D:/referenced'] }, file)
  const valid = readSkillsState(file)
  assert.equal(valid.ok, true)

  const { reloader, calls } = makeReloader(file, valid.state)
  // v4 的坏点必须落在 folders（v3 的 blocked 现在被忽略，写坏它不会让读取失败）。
  writeFileSync(file, 'version: 4\nfolders: [oops\n', 'utf8')
  reloader.reload()
  assert.deepEqual(calls.accepted, [], '坏文件不得清空内存里的状态与引用目录')
  assert.equal(calls.invalidateList, 1, '文件系统确实动过，清单缓存仍要失效')
  assert.equal(calls.invalidateCandidates, 1, '读失败沿用有效状态，但文件事件仍失效候选')
  assert.equal(calls.warns.length, 1)
  assert.match(calls.warns[0], /保留上一次有效状态/u)

  reloader.reload()
  assert.equal(calls.warns.length, 1, '同一故障窗口只告警一次，不刷日志')
  assert.equal(calls.invalidateList, 2)

  // 坏文件窗口里引用目录也在变：读失败不该成为候选失效的盲区。
  reloader.reload()
  assert.equal(calls.warns.length, 1, '仍在同一故障窗口内，不重复告警')
  assert.equal(calls.invalidateCandidates, 3, '读失败不阻挡文件事件刷新候选')

  rmSync(file, { force: true })
  writeSkillsState({ folders: [] }, file)
  reloader.reload()
  assert.equal(calls.accepted.length, 1, '恢复后接受新的合法状态')
  assert.deepEqual(calls.accepted[0].folders, [])
  assert.equal(calls.warns.length, 1, '恢复后不再新增告警')
})

test('状态文件被删除：按空状态处理，但要告警一次', () => {
  const { file } = makeStateFile()
  // 初始状态必须非平凡：空状态与「文件消失后的默认状态」逐字相同，就观察不到重置。
  writeSkillsState({ folders: [resolve('D:/referenced')] }, file)
  const valid = readSkillsState(file)
  assert.equal(valid.ok, true)

  const { reloader, calls } = makeReloader(file, valid.state)
  rmSync(file, { force: true })
  reloader.reload()
  assert.equal(calls.accepted.length, 1, '文件消失按用户重置处理')
  assert.deepEqual(calls.accepted[0].folders, [])
  assert.equal(calls.warns.length, 1, '不能让设置悄悄消失')
  assert.match(calls.warns[0], /状态文件不存在/u)

  reloader.reload()
  assert.equal(calls.warns.length, 1, '同一缺失状态只告警一次')
  assert.equal(calls.invalidateCandidates, 2, '状态相同的第二个事件仍失效候选')

  writeSkillsState({ folders: [resolve('D:/referenced')] }, file)
  reloader.reload()
  assert.equal(calls.accepted.length, 2, '文件回来后状态恢复')
  assert.deepEqual(calls.accepted[1].folders, [resolve('D:/referenced')])
  assert.equal(calls.warns.length, 1, '恢复本身不再额外告警')
})

test('watcher：无法监听的目录只报告一次，不阻断其他目录', () => {
  const { dir } = makeStateFile()
  const missing = join(dir, 'not-there')
  const errors = []
  const watcher = createSkillsWatcher(() => [missing, dir], () => {}, (message) => { errors.push(message) })
  try {
    watcher.watch()
    assert.equal(errors.length, 1, '监听失败的目录必须被报告，否则覆盖不完整对调用方不可见')
    assert.match(errors[0], /不会自动刷新/u)
    assert.match(errors[0], /not-there/u)
    watcher.watch()
    assert.equal(errors.length, 1, '重复挂载同一失败目录不重复告警')
  } finally {
    watcher.close()
  }
})

test('真实装配：状态文件写入经 watcher 走完整条刷新链路', async () => {
  const { dir, file } = makeStateFile()
  writeSkillsState({ folders: [] }, file)
  const initial = readSkillsState(file)
  assert.equal(initial.ok, true)

  const { reloader, calls } = makeReloader(file, initial.state)
  const watcher = createSkillsWatcher(() => [dir], () => { reloader.reload() })
  try {
    watcher.watch()
    writeSkillsState({ folders: [resolve('D:/referenced')] }, file)
    const deadline = Date.now() + 5000
    while (calls.accepted.length === 0 && Date.now() < deadline) await sleep(50)
    assert.equal(calls.accepted.length, 1,
      `watcher 事件必须走完整个刷新装配（invalidateList=${calls.invalidateList}，warns=${calls.warns.length}）`)
    assert.deepEqual(calls.accepted[0].folders, [resolve('D:/referenced')])
    assert.equal(calls.invalidateList >= 1, true)
  } finally {
    watcher.close()
  }
})
