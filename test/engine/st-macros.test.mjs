// ST 变量宏的保留名边界：插值内建与动态宏名不得被 setvar 一族占用。
// 判据与插值同源（engine/interpolate.mjs 的 isReservedInterpolationName），此处只断言
// 调用方观察到的行为：变量帧里没有保留名键、表达式求值为空、宏求值不受影响。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderStText } from '../../engine/st-macros.mjs'

test('st-macros：变量宏不得占用插值保留名（不落变量帧，宏求值不受影响）', () => {
  const session = { id: 'st-reserved', header: { cwd: 'C:/host-cwd' } }
  const render = (text) => renderStText(text, { session, sourceId: 'cfg-1' })

  // 主路径（对照，防止误伤）：普通键照常写入并读回，宏求值不受影响。
  assert.equal(render('{{setvar::owner::Mia}}{{getvar::owner}}'), 'Mia')
  assert.match(render('{{time}}'), /^\d{2}:\d{2}$/)
  assert.ok(/^\d+$/.test(render('{{roll::1d6}}')))

  // 关键拒绝：内建名（大小写敏感）与动态宏名（大小写不敏感）都不落变量帧，求值为空。
  const local = {}
  const global = {}
  const warnings = []
  const guarded = renderStText(
    '{{setvar::CWD::FAKE}}{{setglobalvar::CWD::FAKE-G}}{{setvar::time::FAKE-T}}{{setvar::TIME::FAKE-T}}{{setvar::DSH_HOME::FAKE}}{{setvar::owner::Mia}}',
    { session, local, global, sourceId: 'cfg-1', warn: (message) => warnings.push(message) },
  )
  assert.deepEqual({ ...local }, { owner: 'Mia' }, '保留名未落进 local 帧')
  assert.deepEqual({ ...global }, {}, '保留名未落进 global 帧')
  assert.match(warnings.join('\n'), /reserved name blocked: CWD/)
  assert.match(warnings.join('\n'), /reserved name blocked: DSH_HOME/)
  assert.match(warnings.join('\n'), /reserved name blocked: time/)
  assert.match(warnings.join('\n'), /reserved name blocked: TIME/)
  assert.equal(guarded, '', '被拒的变量宏表达式求值为空串')

  // 拒绝后引用仍取事实与宏：{{CWD}} 取宿主 cwd，{{time}} 取宏值。
  assert.equal(render('{{setvar::CWD::FAKE}}{{CWD}}'), 'C:/host-cwd')
  assert.match(render('{{setvar::time::FAKE}}{{time}}'), /^\d{2}:\d{2}$/)
  assert.equal(render('{{setvar::CWD::FAKE}}{{getvar::CWD}}'), '', 'getvar 也读不到保留名')

  // 边界：内建名大小写敏感——`dsh_home` 不是保留名，普通变量行为不变。
  assert.equal(render('{{setvar::dsh_home::lower}}{{dsh_home}}'), 'lower')
})
