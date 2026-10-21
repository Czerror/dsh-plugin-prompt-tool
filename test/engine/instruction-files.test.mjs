/**
 * 指令文件探测判据：纯字符串，不读盘。
 * 真值源是「cwd 到项目根链」的规格本身——断言手算目录关系，不依赖仓库结构。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join, resolve, sep } from 'node:path'
import {
  PROJECT_INSTRUCTION_CANDIDATES,
  USER_GLOBAL_INSTRUCTION_FILE,
  ancestorDirs,
  instructionPlan,
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
  assert.equal(dirs.at(-1), resolve(sep), '末项是根目录')
  assert.equal(dirname(dirs.at(-1)), dirs.at(-1), '根目录的父目录是它自己')
  for (let index = 1; index < dirs.length; index += 1) {
    assert.equal(dirname(dirs[index - 1]), dirs[index], dirs[index - 1] + ' 的父目录应是 ' + dirs[index])
  }
})

test('instructionPlan：最近的含 marker 祖先胜出，没有 marker 回落 cwd', () => {
  assert.deepEqual(instructionPlan(deep, new Set([repo])), {
    root: repo,
    dirs: [repo, packages, join(packages, 'app'), deep],
  })
  assert.deepEqual(instructionPlan(deep, new Set([repo, packages])).root, packages, '最近者胜出')
  assert.deepEqual(instructionPlan(deep, new Set()), { root: deep, dirs: [deep] }, '没有 marker 时根就是 cwd')
})

test('instructionPlan：root 不是 cwd 的祖先时只回落 cwd，不猜', () => {
  assert.deepEqual(instructionPlan(deep, new Set([join(workspace, 'other')])), { root: deep, dirs: [deep] })
})

test('instructionPlan：UNC 前缀在 win32 下停在共享名根，不越过服务器名', { skip: process.platform !== 'win32' }, () => {
  // 手写 parentPath 以前会一路切到服务器名一级；node:path 的 dirname 停在共享名根。
  // 用 charCode 拼 UNC 前缀，避免在测试源码里堆转义。
  const bs = String.fromCharCode(92)
  // win32 的 dirname 对 UNC 子路径返回带尾分隔符的共享名根，并停在它自己不越级。
  const shareRoot = bs + bs + 'srv' + bs + 'share' + bs
  const nested = shareRoot + 'dir'
  assert.deepEqual(ancestorDirs(nested), [nested, shareRoot], '不切到服务器名一级')
  assert.equal(dirname(shareRoot), shareRoot, '共享名根的父目录是它自己')
  assert.deepEqual(instructionPlan(nested, new Set([shareRoot])), { root: shareRoot, dirs: [shareRoot, nested] })
})
