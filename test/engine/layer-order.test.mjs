import test from 'node:test'
import assert from 'node:assert/strict'
import { compileRules } from '../../engine/rule-spec.mjs'
import { mountRuleSources } from '../../engine/rule-runtime.mjs'
import { wireLayers } from '../../engine/layers.mjs'
import { createPromptConfigs as createPromptConfigsCore } from '../../engine/schema.mjs'

const STRATEGY_DIR = new URL('../../engine/', import.meta.url).href
const createPromptConfigs = (specs) => createPromptConfigsCore(specs, { strategyDir: STRATEGY_DIR })

/** 最小 harness：记录监听器，prepend 插到最外层；run 按注册顺序串接 next。 */
function harness(services = {}) {
  const events = new Map()
  const warnings = []
  const ctx = {
    get: (name) => services[name],
    logger: { warn(message) { warnings.push(message) }, info() {} },
    on(name, handler, options) {
      const list = events.get(name) ?? []
      events.set(name, list)
      if (options?.prepend) list.unshift(handler); else list.push(handler)
      return () => { const at = list.indexOf(handler); if (at >= 0) list.splice(at, 1) }
    },
    effect(callback) { return callback() },
    inject(_names, callback) { return callback(this) },
  }
  const run = (name, args, terminal) => {
    const list = (events.get(name) ?? []).slice()
    const invoke = (index) => index === list.length ? terminal() : list[index](...args, () => invoke(index + 1))
    return invoke(0)
  }
  return { ctx, events, run, warnings }
}

/** systemPrompt 桩：记录注册名，装配结果里的段名就是它。 */
function systemPromptService(registered) {
  const record = (entry) => { registered.push(entry.name); return () => {} }
  return { section: record, context: record, variable: () => () => {}, suppressRuntimeContext: () => () => {} }
}

const agent = () => ({ session: { id: 's1', header: {}, snapshotEvents: () => [] }, options: { model: 'deepseek-chat' } })
const assembled = (sections, contexts = []) => ({ sections, contexts, tools: [], variables: {} })
const inject = (id, layer, text, order) => ({ id, kind: 'inject-text', config: { id, layer, strategy: 'static', text, order } })

/** 两个模块、不同官方档位，configOrder 与档位顺序相反。 */
function mountOpposite(ctx) {
  const rulesA = compileRules([{ id: 'ra', then: [inject('alpha', 'system-section', 'A', 0)] }], { moduleId: 'mod-a', configOrder: { ra: 20 } })
  const rulesB = compileRules([{ id: 'rb', then: [inject('bravo', 'system-section', 'B', 100)] }], { moduleId: 'mod-b', configOrder: { rb: 10 } })
  return mountRuleSources(ctx, [{ moduleId: 'mod-a', rules: rulesA }, { moduleId: 'mod-b', rules: rulesB }])
}

test('系统提示段：官方档位先排，configOrder 覆盖跨档位先后', async () => {
  const registered = []
  const h = harness({ systemPrompt: systemPromptService(registered) })
  mountOpposite(h.ctx)
  const [alpha, bravo] = registered
  const input = assembled([{ name: alpha, text: 'A' }, { name: bravo, text: 'B' }])
  const output = await h.run('system-prompt/assemble', [input, { agent: agent() }], () => Promise.resolve(input))
  assert.deepEqual(output.sections.map((section) => section.name), [bravo, alpha])
  assert.deepEqual(input.sections.map((section) => section.name), [alpha, bravo], '输入不得被就地修改')
})

test('系统提示段：未注册的平台段槽位不动', async () => {
  const registered = []
  const h = harness({ systemPrompt: systemPromptService(registered) })
  mountOpposite(h.ctx)
  const [alpha, bravo] = registered
  const input = assembled([
    { name: alpha, text: 'A' },
    { name: 'tools:sdk', text: 'SDK' },
    { name: bravo, text: 'B' },
  ])
  const output = await h.run('system-prompt/assemble', [input, { agent: agent() }], () => Promise.resolve(input))
  assert.deepEqual(output.sections.map((section) => section.name), [bravo, 'tools:sdk', alpha])
})

test('运行上下文：同一套 configOrder 覆盖规则', async () => {
  const registered = []
  const h = harness({ systemPrompt: systemPromptService(registered) })
  const rulesA = compileRules([{ id: 'ca', then: [inject('ctx-alpha', 'runtime-context', 'A', 0)] }], { moduleId: 'mod-a', configOrder: { ca: 20 } })
  const rulesB = compileRules([{ id: 'cb', then: [inject('ctx-bravo', 'runtime-context', 'B', 100)] }], { moduleId: 'mod-b', configOrder: { cb: 10 } })
  mountRuleSources(h.ctx, [{ moduleId: 'mod-a', rules: rulesA }, { moduleId: 'mod-b', rules: rulesB }])
  const [alpha, bravo] = registered
  const input = assembled([], [{ name: alpha, text: 'A' }, { name: bravo, text: 'B' }])
  const output = await h.run('system-prompt/assemble', [input, { agent: agent() }], () => Promise.resolve(input))
  assert.deepEqual(output.contexts.map((entry) => entry.name), [bravo, alpha])
})

test('直接挂载的静态段与实际注册名同源，按 configOrder 回填', async () => {
  const registered = []
  const h = harness({ systemPrompt: systemPromptService(registered) })
  const configs = createPromptConfigs([
    { id: 'alpha', layer: 'system-section', strategy: 'static', text: 'A', order: 0 },
    { id: 'bravo', layer: 'system-section', strategy: 'static', text: 'B', order: 100 },
  ]).map((config, index) => ({ ...config, sequence: index === 0 ? 20 : 10, sourceModuleId: index === 0 ? 'mod-a' : 'mod-b' }))
  wireLayers(h.ctx, configs, () => {})
  const [alpha, bravo] = registered
  const input = assembled([{ name: alpha, text: 'A' }, { name: bravo, text: 'B' }])
  const output = await h.run('system-prompt/assemble', [input, { agent: agent() }], () => Promise.resolve(input))
  assert.deepEqual(output.sections.map((section) => section.name), [bravo, alpha])
})

test('段排序：无 sequence 的配置回退官方 order，不会被排到有 sequence 的配置之前', async () => {
  const registered = []
  const h = harness({ systemPrompt: systemPromptService(registered) })
  const configs = createPromptConfigs([
    { id: 'alpha', layer: 'system-section', strategy: 'static', text: 'A', order: 100 },
    { id: 'bravo', layer: 'system-section', strategy: 'static', text: 'B', order: 0 },
  ])
  // alpha 无 sequence（回退 order 100）；bravo 显式 sequence 10。旧实现把 alpha 当 0 提前。
  configs[1].sequence = 10
  wireLayers(h.ctx, configs, () => {})
  const [bravo, alpha] = registered
  const input = assembled([{ name: bravo, text: 'B' }, { name: alpha, text: 'A' }])
  const output = await h.run('system-prompt/assemble', [input, { agent: agent() }], () => Promise.resolve(input))
  assert.deepEqual(output.sections.map((section) => section.name), [bravo, alpha])
})

test('顺序未变时返回原装配引用', async () => {
  const registered = []
  const h = harness({ systemPrompt: systemPromptService(registered) })
  mountOpposite(h.ctx)
  const [alpha, bravo] = registered
  const input = assembled([{ name: bravo, text: 'B' }, { name: alpha, text: 'A' }])
  const output = await h.run('system-prompt/assemble', [input, { agent: agent() }], () => Promise.resolve(input))
  assert.equal(output, input)
})
