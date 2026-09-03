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

test('interpolateStatic：ST 运行时宏无会话上下文时替换为空（不残留字面）', () => {
  assert.equal(interpolateStatic('{{日期}} 的事', { 日期: '' }), ' 的事', '空值占位变量替换为空串不留字面')
  assert.equal(interpolateStatic('{{日期}}', {}), '{{日期}}', '未登记键保留字面')
  assert.equal(interpolateStatic('用户：{{lastusermessage}}', {}), '用户：')
  assert.equal(interpolateStatic('{{lastusermessage}}', { lastusermessage: '覆盖' }), '覆盖', 'variables 优先')
})

test('interpolateStatic：动态宏（roll/random/pick/chance/time/date）', () => {
  // roll：骰子范围 + 修正值。
  for (let i = 0; i < 20; i++) {
    const value = Number(interpolateStatic('{{roll::1d6}}', {}))
    assert.ok(value >= 1 && value <= 6, `1d6 应在 1-6：${value}`)
  }
  assert.ok(/^\d+$/.test(interpolateStatic('{{roll::2d6+3}}', {})), '2d6+3 为数字')
  assert.equal(interpolateStatic('{{roll::非法}}', {}), '非法', '非法表达式原样')
  // pick / random：从列表选一个。
  for (let i = 0; i < 10; i++) {
    assert.ok(['a', 'b', 'c'].includes(interpolateStatic('{{pick::a,b,c}}', {})), 'pick 列表内')
    assert.ok(['1', '2', '3'].includes(interpolateStatic('{{random::1,2,3}}', {})), 'random 列表内')
  }
  // chance：0 恒 false，100 恒 true。
  assert.equal(interpolateStatic('{{chance::0}}', {}), 'false')
  assert.equal(interpolateStatic('{{chance::100}}', {}), 'true')
  // time/date 格式。
  assert.match(interpolateStatic('{{time}}', {}), /^\d{2}:\d{2}$/)
  assert.match(interpolateStatic('{{date}}', {}), /^\d{4}-\d{2}-\d{2}$/)
  assert.match(interpolateStatic('{{weekday}}', {}), /^星期[日一二三四五六]$/)
  // 字面宏。
  assert.equal(interpolateStatic('a{{newline}}b', {}), 'a\nb')
  assert.equal(interpolateStatic('{{pipe}}', {}), '|')
})

test('interpolateVariables：ST 运行时宏（大小写不敏感）从会话事件提取', () => {
  const session = {
    header: { cwd: '/cwd' },
    snapshotEvents: () => [
      { type: 'user/message', data: { message: { content: [{ type: 'text', text: '第一条用户' }] } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '角色回复' }] } } },
      { type: 'user/message', data: { message: { content: [{ type: 'text', text: '最新用户' }] } } },
    ],
  }
  assert.equal(interpolateVariables('{{lastusermessage}}', {}, session), '最新用户', '取最后用户消息')
  assert.equal(interpolateVariables('{{lastUserMessage}}', {}, session), '最新用户', '大小写变体')
  assert.equal(interpolateVariables('{{lastcharmessage}}', {}, session), '角色回复', '取最后角色消息')
  assert.equal(interpolateVariables('{{lastCharMessage}}', {}, session), '角色回复', '大小写变体')
  assert.equal(interpolateVariables('{{charIfNotGroup}}', {}, session), '', '无角色名来源 → 空串')
  // 配置 variables 优先于运行时宏。
  assert.equal(interpolateVariables('{{lastusermessage}}', { lastusermessage: '覆盖' }, session), '覆盖')
})
