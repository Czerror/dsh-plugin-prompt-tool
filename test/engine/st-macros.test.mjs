// ST 变量宏的保留名边界：插值内建与动态宏名不得被 setvar 一族占用。
// 判据与插值同源（engine/interpolate.mjs 的 isReservedInterpolationName），此处只断言
// 调用方观察到的行为：变量帧里没有保留名键、表达式求值为空、宏求值不受影响。
// 另含 ST 模板帧的来源判据（generationKey 只认真实对话消息）与世界书扫描范围。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderStText } from '../../engine/st-macros.mjs'
import { attachStRenderers } from '../../engine/st-render.mjs'
import { stChatMessages, selectStWorldBook } from '../../engine/st-world-book.mjs'

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

test('st-render：generationKey 与 condition 同源——空串来源不参与帧边界，真实来源变化仍换帧', () => {
  // {{incvar}} 只在模板真正求值时递增，因此它是「帧被复用还是被重建」的可观察接缝。
  const configs = attachStRenderers([{
    id: 'frame', layer: 'system-section', promotion: 'none', strategy: 'static',
    dedupe: 'none', enabled: true, texts: ['{{incvar::n}}'], params: { stMacros: true },
  }])
  const session = { id: 'st-frame', header: {}, snapshotEvents: () => [] }
  const agent = { session, options: { model: 'deepseek-chat' } }
  const render = (messages) => configs[0].renderSt(agent, messages)
  const source = (id, plugin) => ({ id, role: 'user', content: [{ type: 'text', text: 'x' }], source: { plugin } })
  const real = { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }

  assert.equal(render([source('p1', '')]), '1', '首帧求值一次')
  // 改前：空串 plugin 被内联判据放行并计入 hash，换 id 即换帧 → 第二次求值 → '2'。
  assert.equal(render([source('p2', '')]), '1', '空串来源的变化不得改变 generationKey（帧必须复用）')
  assert.equal(render([source('p2', ''), real]), '2', '真实来源变化必须换帧（对照：换帧语义仍在）')
  assert.equal(render([source('p2', ''), real]), '2', '同一输入复用帧')
})

/**
 * 桩：`log` 是真值源，`surface.nodes` 按宿主 `foldSurface` 语义维护——只有 replace 会移除节点。
 * 与 `prompt-config-engine.test.mjs` 的同名桩同义，这里只保留本文件用到的动作。
 */
function visibleSession(id) {
  const log = []
  const nodes = []
  return {
    session: { id, header: {}, snapshotEvents: () => log, surface: { nodes } },
    push(event) { log.push(event); nodes.push(log.length - 1) },
    compact(summary) {
      nodes.length = 0
      log.push({ type: 'compaction/end', seq: log.length, data: {} })
      log.push({ type: 'user/message', seq: log.length, data: { message: summary } })
      nodes.push(log.length - 1)
    },
  }
}

test('st-render：generationKey 只看模型可见历史——重复 seq 折叠成一代，压缩遮蔽后换帧', () => {
  // {{incvar}} 只在模板真正求值时递增，是「帧被复用还是被重建」的可观察接缝。
  const configs = attachStRenderers([{
    id: 'frame-surface', layer: 'system-section', promotion: 'none', strategy: 'static',
    dedupe: 'none', enabled: true, texts: ['{{incvar::n}}'], params: { stMacros: true },
  }])
  const store = visibleSession('st-frame-surface')
  const agent = { session: store.session, options: { model: 'deepseek-chat' } }
  const message = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
  // 每步只求值一次：`{{incvar}}` 是「这一步是否重新求值了模板」的可观察接缝。
  const frameOf = () => configs[0].renderSt(agent, [])

  store.push({ type: 'user/message', seq: 0, data: { message: message('u0', '第一句') } })
  assert.equal(frameOf(), '1', '首帧求值一次')
  store.push({ type: 'tool/call', seq: 1, data: { id: 'call-1' } })
  const withTool = frameOf()

  // 位置替换：同一 seq 在 nodes 里占两个位置。tool/call 分支按条数累加会让同一可见历史算出
  // 第二个 generation，帧被无谓重建（连续两次求值会给出不同值）。
  store.session.surface.nodes.push(1)
  const duplicateFrame = frameOf()
  const duplicateFrameAgain = frameOf()
  assert.equal(duplicateFrameAgain, duplicateFrame, '重复 seq 折叠：同一可见历史的 generation 不变，帧必须复用')
  assert.equal(duplicateFrame, withTool, '同一可见历史（含那次 tool/call）仍是同一代')

  store.push({ type: 'user/message', seq: 2, data: { message: message('u1', '第二句') } })
  const changedFrame = frameOf()
  assert.notEqual(changedFrame, duplicateFrameAgain, '可见历史真的变化时必须换帧（对照：换帧语义仍在）')

  // 成功压缩：可见节点塌缩成 `compaction/end` + 摘要 → 模型看到的是新的一段。
  // 换帧的可观察证据是这一步重新求值了模板（generation 变才丢掉 frame.text；不变则沿用缓存值）。
  store.compact(message('summary', '摘要'))
  const compactedFrame = frameOf()
  assert.notEqual(compactedFrame, changedFrame, '压缩遮蔽旧历史后 generation 变、模板重新求值')
})

test('st-world-book：扫描范围 = 模型可见的真实对话——被压缩遮蔽的关键词不再命中', () => {
  // 条目结构取自 `buildWorldBookEntry`（worldbook.ts:37）：`text` 是字符串，匹配键在
  // `params.keys`，ST 触发语义在 `params.stWorldBook`。
  const entry = (id) => ({
    id, name: id, strategy: 'world-book', order: 100, text: 'LORE', layer: 'pre-step',
    position: 'before-all', enabled: true,
    params: { constant: false, keys: ['龙'], stWorldBook: { keys: ['龙'], scanDepth: 2 } },
  })
  const say = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
  const store = visibleSession('st-wb-surface')
  store.push({ type: 'user/message', seq: 0, data: { message: say('u0', '龙现身了') } })
  store.session.surface.nodes.length = 0

  assert.deepEqual(stChatMessages(store.session), [], '遮蔽掉的对话不在扫描 haystack 里')
  assert.equal(selectStWorldBook([entry('lore')], store.session, []).size, 0,
    '关键词只出现在被遮蔽的消息里 → 条目不入选（迁移前读完整历史 → 命中）')

  // 降级对照：无 surface 时退回完整历史，命中行为与迁移前一致。
  assert.equal(selectStWorldBook([entry('lore-degraded')], { snapshotEvents: store.session.snapshotEvents }, []).size, 1,
    '无 surface 的会话仍扫完整历史')
})
