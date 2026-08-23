import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpolateStatic, interpolateVariables } from '../../engine/interpolate.mjs'

test('interpolateStatic：配置 variables 替换 {{key}}，未注册保留字面', () => {
  assert.equal(interpolateStatic('剧情{{wordsCloud}}字 {{缺失}}', { wordsCloud: '1500' }), '剧情1500字 {{缺失}}')
  assert.equal(interpolateStatic('{{a}}/{{b}}', { a: '1', b: '2' }), '1/2')
  assert.equal(interpolateStatic('无变量', {}), '无变量')
})

test('interpolateVariables：variables 优先，内置 DSH_HOME/WORKSPACE/CWD 兜底', () => {
  process.env.DSH_HOME = '/tmp/dsh'
  process.env.DSH_WORKSPACE = '/ws'
  const session = { header: { cwd: '/cwd' } }
  assert.equal(
    interpolateVariables('{{DSH_HOME}} {{WORKSPACE}} {{CWD}} {{自定义}}', { 自定义: '值' }, session),
    '/tmp/dsh /ws /cwd 值',
  )
  // 配置 variables 优先于内置同名键。
  assert.equal(interpolateVariables('{{CWD}}', { CWD: '覆盖' }, session), '覆盖')
  // session 缺省时 WORKSPACE/CWD 回退 process.cwd()。
  assert.equal(interpolateVariables('{{CWD}}', {}, undefined), process.cwd())
})

test('interpolateStatic：中文键替换', () => {
  assert.equal(interpolateStatic('{{词汇}}', { 词汇: '中文' }), '中文')
})
