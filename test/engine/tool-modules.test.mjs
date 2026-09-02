import { test } from 'node:test'
import assert from 'node:assert/strict'

const modules = [
  ["character-tools", "pt-character-tools"],
  ["world-book-tools", "pt-world-book-tools"],
  ["session-var-tools", "pt-session-var-tools"],
]

function makeCtx(serviceKey, service) {
  const state = { warnings: [], disposers: [] }
  state.ctx = {
    get: (key) => key === serviceKey ? service : undefined,
    logger: { warn: (message) => state.warnings.push(message) },
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === "function") state.disposers.push(dispose)
      return dispose
    },
  }
  return state
}

for (const [id, serviceKey] of modules) {
  const mod = await import("../../engine/" + id + ".mjs")
  test(id + "：按模块挂载对应工具服务", () => {
    const calls = []
    const state = makeCtx(serviceKey, { mount: (ctx) => { calls.push(ctx); return () => calls.push("disposed") } })
    mod.apply(state.ctx)
    assert.deepEqual(calls, [state.ctx])
    assert.equal(state.disposers.length, 1)
    state.disposers[0]()
    assert.deepEqual(calls, [state.ctx, "disposed"])
  })

  test(id + "：服务缺失时降级", () => {
    const state = makeCtx(serviceKey, undefined)
    mod.apply(state.ctx)
    assert.equal(state.disposers.length, 0)
    assert.equal(state.warnings.length, 1)
    assert.match(state.warnings[0], /service unavailable/)
  })
}
