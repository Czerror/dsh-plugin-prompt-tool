/**
 * present-as 行的行为回归。
 *
 * 真值源是官方 `ToolRuntime.presentAs` 的既有契约（scoped ctx、mode 枚举、ptc 需要运行时）
 * 与本行自己的配置契约；断言落在**调用方观察到的效果**上——桩 ctx 记录 `presentAs` 被调成
 * 什么、以及是否真的等过 `ptcRuntime`，不看实现细节。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, configContract, inject, name as pluginName } from '../../engine/present-as.mjs'

/** 记录 presentAs 调用与 inject 等待的桩 ctx；`runtime` 决定 ptcRuntime 是否就绪。 */
function makeCtx({ runtime = true } = {}) {
  const calls = []
  const waits = []
  const ctx = {
    tools: { presentAs: (mode) => { calls.push(mode); return () => {} } },
    inject: (deps, callback) => {
      waits.push([...deps])
      if (runtime) callback(ctx)
    },
  }
  return { ctx, calls, waits }
}

test('present-as：ptc 等 ptcRuntime 就绪后才声明，等不到就不声明', () => {
  const pending = makeCtx({ runtime: false })
  apply(pending.ctx, { enabled: true, mode: 'ptc' })
  assert.deepEqual(pending.waits, [['ptcRuntime']], 'ptc 必须先等运行时')
  assert.deepEqual(pending.calls, [], '运行时未就绪时不得声明（停在 pending，不退回 native）')

  const ready = makeCtx({ runtime: true })
  apply(ready.ctx, { enabled: true, mode: 'ptc' })
  assert.deepEqual(ready.calls, ['ptc'], '运行时就绪后声明 ptc')
})

test('present-as：native 不依赖 ptcRuntime，直接声明', () => {
  const h = makeCtx({ runtime: false })
  apply(h.ctx, { enabled: true, mode: 'native' })
  assert.deepEqual(h.waits, [], 'native 与运行时无关，不得等待')
  assert.deepEqual(h.calls, ['native'])
})

test('present-as：主子模式独立，缺省仍继承旧 mode', () => {
  const config = { enabled: true, mode: 'ptc', mainMode: 'native', subagentMode: 'ptc' }
  for (const [depth, expected] of [[0, 'native'], [1, 'ptc'], [2, 'ptc']]) {
    const h = makeCtx()
    apply(h.ctx, config, { agent: { session: { header: { delegationDepth: depth } } } })
    assert.deepEqual(h.calls, [expected])
  }
  const legacy = makeCtx()
  apply(legacy.ctx, { enabled: true, mode: 'native' }, { agent: { session: { header: { delegationDepth: 1 } } } })
  assert.deepEqual(legacy.calls, ['native'])
  assert.deepEqual(config, { enabled: true, mode: 'ptc', mainMode: 'native', subagentMode: 'ptc' }, '共享配置不得被某个受众改写')
})

test('present-as：未声明 enabled 即关闭；非法配置挂载期拒绝', () => {
  const off = makeCtx()
  apply(off.ctx, { mode: 'ptc' })
  apply(off.ctx, { enabled: false, mode: 'ptc' })
  assert.deepEqual(off.calls, [], '关闭时不得声明呈现')

  assert.throws(() => apply(off.ctx, { enabled: true, mode: 'both' }), /mode must be one of/)
  // mode 必填（官方同一取舍）：缺它的行等于白装，静默缺省会让「开了 PTC」的装配以部署默认跑。
  assert.throws(() => apply(off.ctx, { enabled: true }), /mode must be one of/)
  assert.throws(() => apply(off.ctx, undefined), /mode must be one of/)
  assert.throws(() => apply(off.ctx, { enabled: 'yes', mode: 'ptc' }), /enabled must be a boolean/)
  assert.throws(() => apply(off.ctx, { enabled: true, mode: 'ptc', extra: 1 }), /unknown config key/)
  assert.throws(() => apply(off.ctx, { enabled: true, mode: 'ptc', subagentMode: 'both' }), /subagentMode must be one of/)
})

test('present-as：契约面——插件名、inject 声明与配置键集', () => {
  assert.equal(pluginName, 'present-as')
  assert.deepEqual(inject, ['tools'], 'ptcRuntime 刻意不进 inject：native 行必须能在没有运行时的部署挂载')
  assert.deepEqual([...configContract.allowedKeys].sort(), ['enabled', 'mainMode', 'mode', 'subagentMode'])
})
