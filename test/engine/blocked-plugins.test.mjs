/**
 * blockedPlugins：按 `source.plugin` 屏蔽第三方注入（B8 ④ / T8）。
 *
 * ## 拍板语义（2026-09-22 用户选定，方案 A）
 *
 * 仅当来源 `kind` 为 `plugin` 时，把 `source.plugin` 与名单项做**大小写不敏感的精确等值**
 * 比较（两侧统一小写后全等）——**不做子串、不做正则、不做 glob**。理由是 `source.plugin`
 * 是插件自报的稳定身份，精确匹配可预测、无误伤；需要覆盖某个插件时必须写全名。
 *
 * 被否决的方案 B（小写子串包含）不保留任何实现路径：本文件里 `mnemon` 与
 * `dsh-mnemon-helper` 两条断言正是两种语义的**分界**，它们一旦变红就说明有人把子串匹配塞了回来。
 *
 * ## 与白名单的关系
 *
 * `blockPlugins` 与 `sources` / `keepKinds` **正交**、可共存：白名单决定「留哪些 kind」，
 * 本名单决定「再剔掉哪些插件」。未声明或**空名单 = 关闭**——注意这与白名单「空 = 全拦」
 * 的语义相反（空集没有可剔对象），不要沿用邻居语义。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileDeclarations, mountDeclarations } from '../../engine/trigger-spec.mjs'

const PLUGIN = 'blocked-plugins-test'

/** 记录监听器的 ctx：`on` 只记 handler 与选项；顺序语义由本文件手动串联（mock 不实现 waterfall）。 */
function makeCtx() {
  const listeners = new Map()
  return {
    ctx: {
      on(type, handler, options) {
        const list = listeners.get(type) ?? []
        list.push({ handler, options })
        listeners.set(type, list)
        return () => {}
      },
    },
    listeners,
  }
}

const pluginMessage = (plugin, text = 'x') => ({ id: `m-${plugin}-${text}`, source: { kind: 'plugin', plugin } })
const kindMessage = (kind, text = 'x') => ({ id: `m-${kind}-${text}`, source: { kind } })

const declarationOf = (doFields) => ({
  id: 'blocked-plugins',
  channel: 'agent/pre-step',
  channelOrder: 0,
  waterfallPosition: 'outermost',
  do: { kind: 'pre-step-filter', id: 'blocked-plugins', ...doFields },
})

/** 挂载一条声明并取出 agent/pre-step 的监听器（未注册时返回 undefined）。 */
function mountOne(doFields) {
  const { ctx, listeners } = makeCtx()
  mountDeclarations(ctx, compileDeclarations([declarationOf(doFields)], { ctx }), { plugin: PLUGIN })
  return (listeners.get('agent/pre-step') ?? [])[0]?.handler
}

const ids = (decision) => decision.messages.map((message) => message.id)

test('未声明或空名单 = 不注册监听（零开销；与白名单「空 = 全拦」相反）', () => {
  for (const value of [undefined, []]) {
    assert.equal(mountOne(value === undefined ? {} : { blockPlugins: value }), undefined,
      `${JSON.stringify(value)} 不应注册监听`)
  }
})

test('分界语义：只剥离精确同名（大小写不敏感），子串与扩展名一律不生效', () => {
  const messages = [
    pluginMessage('dsh-mnemon', 'hit'),
    pluginMessage('mnemon', 'substring'),
    pluginMessage('dsh-mnemon-helper', 'extension'),
    pluginMessage('DSH-Mnemon', 'case'),
    kindMessage('user', 'claimed'),
    kindMessage('goal', 'goal'),
    pluginMessage('other', 'other'),
  ]
  const handler = mountOne({ blockPlugins: ['dsh-mnemon'] })
  return handler({ messages }, async () => ({ kind: 'enter', messages })).then((decision) => {
    assert.deepEqual(ids(decision), [
      'm-mnemon-substring',
      'm-dsh-mnemon-helper-extension',
      'm-user-claimed',
      'm-goal-goal',
      'm-other-other',
    ], '精确等值：`mnemon` 与 `dsh-mnemon-helper` 不得被剥离（方案 B 的分界断言）；大小写不同仍命中；其它 kind 与插件保留')
  })
})

test('reject 步原样返回，不改判定', () => {
  const rejected = { kind: 'reject', reason: 'downstream said no' }
  const handler = mountOne({ blockPlugins: ['dsh-mnemon'] })
  return handler({ messages: [pluginMessage('dsh-mnemon')] }, async () => rejected).then((decision) => {
    assert.equal(decision, rejected, 'reject 必须原样透传')
  })
})

test('过滤自身出错时保留全部消息（永不吞上下文）', () => {
  const handler = mountOne({ blockPlugins: ['dsh-mnemon'] })
  // `source` 是抛错的 getter：读取即失败，模拟过滤自身异常。
  const hostile = { id: 'm-hostile', get source() { throw new Error('boom') } }
  const messages = [hostile]
  return handler({ messages }, async () => ({ kind: 'enter', messages })).then((decision) => {
    assert.deepEqual(ids(decision), ['m-hostile'], '异常必须保留全部消息，宁可少拦不可吞内容')
  })
})

test('与 sources 白名单正交共存：先按 kind 放行，再按插件剔除', () => {
  const handler = mountOne({ sources: ['plugin', 'user'], blockPlugins: ['dsh-mnemon'] })
  const messages = [pluginMessage('dsh-mnemon'), pluginMessage('other'), kindMessage('user'), kindMessage('goal')]
  return handler({ messages }, async () => ({ kind: 'enter', messages })).then((decision) => {
    assert.deepEqual(ids(decision), ['m-other-x', 'm-user-x'],
      '白名单放行 plugin/user，随后剔掉被屏蔽插件；两维度互不干扰')
  })
})

test('与相位无关：声明不挂 when，动作不读任何相位状态', () => {
  const compiled = compileDeclarations([declarationOf({ blockPlugins: ['dsh-mnemon'] })], { ctx: makeCtx().ctx })
  assert.equal(compiled[0].when, undefined, 'blockPlugins 是独立维度，不该被挂上相位条件')
  assert.equal(compiled[0].waterfallPosition, 'outermost', '剥离是否决型动作，须落在普通注册之外')
})

test('名单项必须是非空字符串（非法数组在挂载期 fail loud，不静默降级为全拦）', () => {
  assert.throws(() => mountOne({ blockPlugins: 'dsh-mnemon' }), /blockPlugins/)
  assert.throws(() => mountOne({ blockPlugins: [''] }), /blockPlugins/)
  assert.throws(() => mountOne({ blockPlugins: [42] }), /blockPlugins/)
})
