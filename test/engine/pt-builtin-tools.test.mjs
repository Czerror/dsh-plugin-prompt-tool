import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, name } from '../../engine/pt-builtin-tools.mjs'

/** mock 组合行 scope ctx：get 查服务表，effect 收集 disposer，warn 记录。 */
function makeScopeCtx(services) {
  const state = {
    warnings: [],
    disposers: [],
    ctx: {
      get: (key) => services[key],
      logger: { warn: (message) => state.warnings.push(message) },
      effect: (fn) => {
        const dispose = fn()
        if (typeof dispose === 'function') state.disposers.push(dispose)
        return dispose
      },
    },
  }
  return state
}

test('桥接行元数据：插件名与懒取契约', () => {
  assert.equal(name, 'pt-builtin-tools')
  // 懒取而非 inject 声明：apply 不声明 inject（服务缺失降级为无工具，不 pending 卡会话）。
  assert.equal(apply.length, 2, 'apply(ctx, config)')
})

test('apply：服务存在时在 scope ctx 上挂载并透传 config', () => {
  const mounted = []
  const unmount = []
  const service = {
    mount: (scopeCtx, config) => {
      assert.equal(scopeCtx, state.ctx, 'mount 收到组合行 scope ctx')
      mounted.push(config)
      return () => unmount.push('disposed')
    },
  }
  const state = makeScopeCtx({ 'pt-builtin-tools': service })
  apply(state.ctx, { character: true, worldBook: false, sessionVar: true })
  assert.deepEqual(mounted, [{ character: true, worldBook: false, sessionVar: true }], 'config 原样透传（组过滤由服务端做）')
  assert.equal(state.disposers.length, 1, 'mount 返回的 disposer 挂到 effect')
  state.disposers[0]()
  assert.deepEqual(unmount, ['disposed'], 'effect 清理时调用服务 disposer')
})

test('apply：服务缺失时 warn 降级，不抛错不注册（插件禁用不卡会话挂载）', () => {
  const state = makeScopeCtx({})
  apply(state.ctx, { character: true })
  assert.equal(state.disposers.length, 0, '未注册任何工具')
  assert.equal(state.warnings.length, 1, 'warn 一次')
  assert.match(state.warnings[0], /pt-builtin-tools service unavailable/)
})

test('apply：config 缺省透传空对象（缺省语义由服务端归一为全开）', () => {
  const mounted = []
  const service = { mount: (_scopeCtx, config) => { mounted.push(config); return () => {} } }
  const state = makeScopeCtx({ 'pt-builtin-tools': service })
  apply(state.ctx, undefined)
  assert.deepEqual(mounted, [{}], 'undefined config 归一为空对象')
})
