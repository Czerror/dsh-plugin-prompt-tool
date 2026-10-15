/**
 * 机器路径事实的单一来源：三个键怎么推导，以及**曾经分叉的那个消费点**是否与它同答案。
 *
 * 断言停在 `machinePaths` 的 interface 上，并显式传 `env` 替身——不读真实环境。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { machinePaths } from '../../engine/machine-paths.mjs'
import { buildEnv } from '../../engine/run-code-env.mjs'

const env = { USERPROFILE: 'C:\\Users\\tester' }

test('machinePaths：DSH_HOME 显式优先 → 用户主目录推导 → 空串', () => {
  assert.equal(machinePaths(undefined, { ...env, DSH_HOME: 'D:\\home' }).DSH_HOME, 'D:\\home')
  assert.equal(machinePaths(undefined, env).DSH_HOME, 'C:\\Users\\tester\\.dsh')
  assert.equal(machinePaths(undefined, {}).DSH_HOME, '', '都没有时空串（不是 undefined，调用方自行折回缺省）')
})

test('machinePaths：CWD 与会话头同源，WORKSPACE 显式优先', () => {
  const session = { header: { cwd: 'D:\\work' } }
  assert.equal(machinePaths(session, env).CWD, 'D:\\work')
  assert.equal(machinePaths(session, env).WORKSPACE, 'D:\\work')
  assert.equal(machinePaths(session, { ...env, DSH_WORKSPACE: 'D:\\ws' }).WORKSPACE, 'D:\\ws')
  assert.ok(machinePaths(undefined, env).CWD.length > 0, '无会话时回退进程 cwd')
})

test('run-code-env 的 DSH_HOME 与唯一来源同答案（修掉「未设时不落键」的分歧）', () => {
  const saved = { DSH_HOME: process.env.DSH_HOME, USERPROFILE: process.env.USERPROFILE }
  delete process.env.DSH_HOME
  process.env.USERPROFILE = 'C:\\Users\\tester'
  try {
    const session = { header: { cwd: 'D:\\work' } }
    const env2 = buildEnv(undefined, [], { session })
    assert.equal(env2.DSH_HOME, machinePaths(session).DSH_HOME, '与唯一来源同答案')
    assert.equal(env2.DSH_HOME, 'C:\\Users\\tester\\.dsh', '未设 DSH_HOME 时按用户主目录推导（此前这里是空的）')
  } finally {
    if (saved.DSH_HOME === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved.DSH_HOME
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = saved.USERPROFILE
  }
})
