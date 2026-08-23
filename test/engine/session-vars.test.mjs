import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SESSION_VARS_KEY, clearSessionVars, getSessionVar, sessionVarsSnapshot, setSessionVar } from '../../engine/session-vars.mjs'

test('session-vars：设置/读取/快照/清除（挂在 session 对象上）', () => {
  const session = { id: 's1' }
  assert.deepEqual(sessionVarsSnapshot(session), {}, '初始空')
  assert.equal(getSessionVar(session, '心情'), undefined)
  setSessionVar(session, '心情', '😊')
  setSessionVar(session, '接受值', '42')
  assert.equal(getSessionVar(session, '心情'), '😊')
  assert.deepEqual(sessionVarsSnapshot(session), { 心情: '😊', 接受值: '42' })
  // 值转字符串。
  setSessionVar(session, '数字', 7)
  assert.equal(getSessionVar(session, '数字'), '7')
  // 单键清除。
  clearSessionVars(session, '心情')
  assert.equal(getSessionVar(session, '心情'), undefined)
  assert.equal(getSessionVar(session, '接受值'), '42', '其余保留')
  // 全部清除。
  clearSessionVars(session)
  assert.deepEqual(sessionVarsSnapshot(session), {})
  // 无 session（非对象）安全。
  assert.deepEqual(sessionVarsSnapshot(undefined), {})
  assert.equal(SESSION_VARS_KEY.startsWith('__pt_'), true, '键常量跨实例一致')
})
