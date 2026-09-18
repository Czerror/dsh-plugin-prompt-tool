import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createSkillsReloader } from '../../src/host/skills-refresh.ts'
import { readSkillsState, writeSkillsState } from '../../src/host/skills-config.ts'
import { createSkillsWatcher } from '../../src/runtime/skills-watcher.ts'

const sandbox = mkdtempSync(join(process.cwd(), 'pt-refresh-'))
after(() => rmSync(sandbox, { recursive: true, force: true }))

function reloader(file, initial) {
  let state = initial
  const warnings = []
  let accepted = 0
  const reader = createSkillsReloader({ stateFile: file, currentSnapshot: () => JSON.stringify(state),
    accept: (next) => { state = next; accepted++ }, warn: (message) => warnings.push(message) })
  return { ...reader, warnings, get state() { return state }, get accepted() { return accepted } }
}

test('损坏状态保留最后有效引用，恢复后接受新值，删除重置且各故障窗口仅告警一次', () => {
  const file = join(sandbox, 'state.yml')
  writeSkillsState({ folders: [join(sandbox, 'reference')] }, file)
  const reader = reloader(file, readSkillsState(file).state)
  writeFileSync(file, 'version: 4\nfolders: [broken\n')
  reader.reload()
  reader.reload()
  assert.deepEqual(reader.state.folders, [join(sandbox, 'reference')])
  assert.equal(reader.accepted, 0)
  assert.equal(reader.warnings.length, 1)
  writeFileSync(file, `version: 4\nfolders: []\n`)
  reader.reload()
  assert.deepEqual(reader.state.folders, [])
  assert.equal(reader.accepted, 1)
  writeSkillsState({ folders: [join(sandbox, 'next')] }, file)
  reader.reload()
  rmSync(file)
  reader.reload()
  reader.reload()
  assert.deepEqual(reader.state.folders, [])
  assert.equal(reader.warnings.length, 2)
  assert.match(reader.warnings[1], /状态文件不存在/)
})

test('状态 watcher 覆盖缺失文件创建、原子替换、删除恢复，close 后停止回调', async () => {
  const file = join(sandbox, 'missing', 'skills.yml')
  const reader = reloader(file, { version: 4, folders: [] })
  let calls = 0
  const watcher = createSkillsWatcher(file, () => { calls++; reader.reload() })
  const until = async (check) => {
    const deadline = Date.now() + 5000
    while (!check() && Date.now() < deadline) await delay(25)
    assert.ok(check())
  }
  try {
    writeSkillsState({ folders: [join(sandbox, 'one')] }, file)
    await until(() => reader.state.folders[0] === join(sandbox, 'one'))
    writeSkillsState({ folders: [join(sandbox, 'two')] }, `${file}.replacement`)
    renameSync(`${file}.replacement`, file)
    await until(() => reader.state.folders[0] === join(sandbox, 'two'))
    rmSync(file)
    await until(() => reader.state.folders.length === 0)
    writeSkillsState({ folders: [join(sandbox, 'restored')] }, file)
    await until(() => reader.state.folders[0] === join(sandbox, 'restored'))
    watcher.close()
    const before = calls
    writeSkillsState({ folders: [] }, file)
    await delay(300)
    assert.equal(calls, before)
  } finally { watcher.close() }
})
