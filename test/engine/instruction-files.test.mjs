/**
 * 指令文件探测计划：纯字符串判据，不读盘。
 * 真值源是「cwd 到项目根链」的规格本身——每个断言手算目录关系，不依赖仓库结构。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join, resolve, sep } from 'node:path'
import {
  PROJECT_INSTRUCTION_CANDIDATES,
  USER_GLOBAL_INSTRUCTION_FILE,
  ancestorDirs,
  instructionDirs,
  resolveProjectRoot,
} from '../../engine/instruction-files.mjs'

const workspace = resolve(sep + 'work')
const repo = join(workspace, 'repo')
const packages = join(repo, 'packages')
const deep = join(packages, 'app', 'src')

test('候选清单只有一份：项目四个 + 用户级 AGENTS.md', () => {
  assert.deepEqual(PROJECT_INSTRUCTION_CANDIDATES, ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md'])
  assert.equal(USER_GLOBAL_INSTRUCTION_FILE, 'AGENTS.md')
})

test('ancestorDirs：含自身、逐级向上、止于文件系统根', () => {
  const dirs = ancestorDirs(deep)
  assert.equal(dirs[0], deep)
  assert.ok(dirs.includes(repo))
  assert.equal(dirs.at(-1), resolve(sep))
  assert.equal(dirname(dirs.at(-1)), dirs.at(-1), '根目录的父目录是它自己')
  for (let index = 1; index < dirs.length; index += 1) {
    assert.equal(dirname(dirs[index - 1]), dirs[index], dirs[index - 1] + ' 的父目录应是 ' + dirs[index])
  }
})

test('resolveProjectRoot：最近的含 marker 祖先胜出，没有 marker 回落 cwd', () => {
  assert.equal(resolveProjectRoot(deep, new Set([repo])), repo)
  assert.equal(resolveProjectRoot(deep, new Set([repo, packages])), packages)
  assert.equal(resolveProjectRoot(deep, new Set([deep])), deep)
  assert.equal(resolveProjectRoot(deep, new Set()), deep)
  // 祖先链之外的 marker 不算：other 与 repo 并列，不是 deep 的祖先。
  assert.equal(resolveProjectRoot(deep, new Set([join(workspace, 'other')])), deep)
})

test('instructionDirs：广到窄，首项项目根、末项 cwd', () => {
  assert.deepEqual(instructionDirs(deep, repo), [repo, packages, join(packages, 'app'), deep])
  assert.deepEqual(instructionDirs(deep, deep), [deep])
})

test('instructionDirs：root 不是 cwd 的祖先时只回落 cwd，不猜', () => {
  assert.deepEqual(instructionDirs(deep, join(workspace, 'other')), [deep])
})
