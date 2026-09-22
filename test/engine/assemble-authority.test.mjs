/**
 * assemble 权威性：否决型门控必须位于普通注册之外（B8 T1）。
 *
 * ## 官方契约（全部直读 `node_modules/@deepseek-ai/**`，非转述）
 *
 * - 事件与签名：`dsh-system-prompt/lib/types/index.d.ts:27`
 *   `'system-prompt/assemble'(this: Scoped<SystemPrompt>, assembly: PromptAssembly,
 *    context: AssembleContext, next: () => Promise<PromptAssembly>)`，`:25` 标 `@mode waterfall`，
 *   `:18`「The returned value is authoritative」。
 * - waterfall 求值：`cordis/src/events.ts:234-243` —— `cbs.shift()` 取**数组头部**先执行，
 *   `:232`「returns the outermost listener's return value」。
 * - 注册位置：`cordis/src/events.ts:254-257` —— `const method = options.prepend ? 'unshift' : 'push'`，
 *   即 `prepend` 插到链首 = 最外层；同为 `prepend` 时**后注册者更外层**（`unshift` 反复前插）。
 * - `PromptAssembly`：`index.d.ts:107-112` = `{ sections, contexts, tools, variables }`。
 * - `AssembleContext`：`index.d.ts:37-45` **只有 `scope?` 与 `signal?`**；`agent?` 由
 *   `dsh-agent/lib/types/runtime-types.d.ts:14-19` 的 `declare module` 扩展而来
 *   （「Agent for this assembly; absent on diagnostics」）。**`tools` 不在任何扩展里** ——
 *   工具目录只能由 `systemPrompt.tools(provider)` 提供（`index.d.ts:274`、`lib/index.js:287-288`
 *   把 provider 追加到调用 ctx 所属 layer，`:320` 装配时 global 与 scoped 一并参与）。
 * - `ToolSchema`：`dsh-llm/lib/types/types.d.ts:432` = `{ name, description, parameters }`。
 * - `renderContextSections(assembly): ContextSnapshotSection[]`
 *   （`index.d.ts:225`）；`ContextSnapshotSection` = `{ name, text }`（`dsh-llm/.../message.d.ts:56`）。
 *
 * 因此 `waterfallPosition: outermost` 的效果**只能**由真实 `Context` 证明；引擎测试里手写的
 * mock `ctx.on` 只记录 `opts`，不实现顺序语义。
 *
 * ## 反例的正确形态
 *
 * 改前引擎声明是普通注册（`push`）。若竞争者也是**普通**注册，它本来就在引擎**内层**、
 * 根本翻越不了门控——用那种写法测不出红，是假反例。真正的风险源是**先加载的第三方插件
 * 用 `prepend`**（实证：`dsh-purge/lib/index.js:237` 的
 * `ctx.on("system-prompt/assemble", hook, { global: true, prepend: true })`），它位于链首、
 * 在 `await next()` **之后**把 `contexts` / `tools` 填回去，从而翻越门控。
 *
 * 所以本文件一律：**先**注册 prepend 竞争者，**再**挂引擎声明；工具目录另由
 * `systemPrompt.tools()` 提供（与监听器注册顺序无关）。
 *
 * ## 已知边界（如实断言，不伪装通过）
 *
 * 门控改为 `prepend` 只保证「比**已存在**的普通注册更外层」。若竞争者同样 `prepend` 且
 * **注册在引擎行之后**，它仍处于更外层、门控仍会被翻越。这是 prepend 语义的固有限制，
 * 见本 PLAN 的「实施取舍与已知边界」，最后一个用例显式钉住它。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { parse } from 'yaml'
import { createPromptConfigs } from '../../engine/schema.mjs'
import { wireLayers } from '../../engine/layers.mjs'
import { compileDeclarations, mountDeclarations } from '../../engine/trigger-spec.mjs'

const declarationsOf = (file) => parse(readFileSync(new URL(`./declarations/${file}`, import.meta.url), 'utf8'))
const CONTEXT_GATE = declarationsOf('context-gate.yml')
const TOOL_BOOTSTRAP = declarationsOf('tool-bootstrap.yml')
const TOOL_FILTER = declarationsOf('tool-filter.yml')

/** 产生真实 `contexts` 的协作式填充层：门控的 clear 只在 `contexts` 非空时才有可观测差异。 */
const RUNTIME_CONTEXT = { id: 'env', layer: 'runtime-context', strategy: 'placeholder', fill: 'env-facts', text: '{{CWD}}' }

/** `tool-bootstrap` 声明 1 的 allow 名单：两者必须都在目录里，否则 `requireMatch` 会走 fail-open。 */
const BOOTSTRAP_ALLOW = ['bash', 'str_replace_editor']
const INTRUDER_TOOL = 'web_fetch'

async function harness(t) {
  const root = new Context()
  const home = mkdtempSync(join(process.cwd(), 'pt-assemble-authority-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(async () => {
    try {
      await root.fiber.dispose()
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      rmSync(home, { recursive: true, force: true })
    }
  })
  await root.plugin(SystemPrompt, { includeHarnessIdentity: false })
  return {
    root,
    /** `prepare` 拿到 scope 自己的 ctx，用来按顺序安排「竞争者 → 引擎声明 → 工具目录 → 协作层」。 */
    async scope(prepare) {
      const key = {}
      let scope
      await root.plugin(Object.assign((inner) => {
        scope = createScope(inner, key)
        prepare(scope.ctx)
      }, { inject: ['systemPrompt'] }))
      // `createScope` 只返回 `{ ctx, rawDispose, dispose }`，**不含 key** —— 官方用 WeakMap 保存
      // scope 关系、`ScopeKey` 是不透明对象（deepseek-harness/packages/core/scope/src/index.ts:14-18）。
      // 装配必须显式带 key：`assemble({ scope: undefined })` 会退化为「只参与无 subject 的 dispatch」，
      // 该 scope 注册的 listener 与 toolProvider 全部不参与，于是断言会得到假绿/假红。
      return { ...scope, key }
    },
    assemble(scope, session) {
      return root.systemPrompt.assemble({ scope: scope.key, agent: { session, options: {} } })
    },
  }
}

function sessionWith(id = 'main') {
  return { id, header: { cwd: process.cwd(), delegationDepth: 0 }, snapshotEvents: () => [] }
}

const mount = (ctx, declarations, plugin) =>
  mountDeclarations(ctx, compileDeclarations(declarations, { ctx }), { plugin })

/** 工具目录：唯一入口是 `systemPrompt.tools(provider)`，provider 返回 `{ schemas }`。 */
const toolCatalog = (ctx, names) => ctx.systemPrompt.tools(() => ({
  schemas: names.map((name) => ({ name, description: `${name} tool`, parameters: {} })),
}))

/** 竞争者 A：prepend 注册，在 `next()` 之后把 `contexts` 填回去。 */
const contextIntruder = (ctx, entries) => ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
  const result = await next()
  return { ...result, contexts: [...(result.contexts ?? []), ...entries] }
}, { prepend: true })

/** 竞争者 B：prepend 注册，在 `next()` 之后把被门控剔掉的工具加回去。 */
const toolIntruder = (ctx, names) => ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
  const result = await next()
  const present = new Set((result.tools ?? []).map((tool) => tool?.name))
  const restored = names.filter((name) => !present.has(name))
    .map((name) => ({ name, description: `${name} tool`, parameters: {} }))
  return { ...result, tools: [...(result.tools ?? []), ...restored] }
}, { prepend: true })

const toolNames = (result) => (result.tools ?? []).map((tool) => tool?.name)
const INTRUDER_CONTEXT = { name: 'intruder', text: 'INTRUDER' }

test('未晋升时 context-gate 门控位于 prepend 竞争者之外（outermost）', async (t) => {
  const h = await harness(t)
  const scope = await h.scope((ctx) => {
    contextIntruder(ctx, [INTRUDER_CONTEXT])                       // 竞争者先注册（链首）
    mount(ctx, CONTEXT_GATE, 'assemble-authority')                 // 门控后注册
    wireLayers(ctx, createPromptConfigs([RUNTIME_CONTEXT]), () => {})
  })
  const result = await h.assemble(scope, sessionWith())
  assert.deepEqual(renderContextSections(result), [],
    '未晋升时 contexts 必须为空：竞争者位于门控内层，其填回的内容应被门控清空')
})

test('已晋升时填充内容保留（门控不命中即整条跳过）', async (t) => {
  const h = await harness(t)
  const scope = await h.scope((ctx) => {
    contextIntruder(ctx, [INTRUDER_CONTEXT])
    mount(ctx, CONTEXT_GATE, 'assemble-authority')
    wireLayers(ctx, createPromptConfigs([RUNTIME_CONTEXT]), () => {})
  })
  const session = sessionWith()
  const events = []
  session.snapshotEvents = () => events
  const observe = (type, data = {}) => {
    const event = { type, seq: events.length + 1, data }
    events.push(event)
    scope.ctx.emit('session/event', session, event)
  }
  observe('tool/call')                                             // 触发晋升
  const sections = renderContextSections(await h.assemble(scope, session))
  assert.deepEqual(sections.map((entry) => entry.name), ['env', 'intruder'],
    '晋升后门控不命中，运行时上下文与竞争者的填充都必须保留')
})

test('首轮窄化：tool-bootstrap 的 assembly 声明位于 prepend 竞争者之外', async (t) => {
  const h = await harness(t)
  const scope = await h.scope((ctx) => {
    toolIntruder(ctx, [INTRUDER_TOOL])                             // 竞争者先注册（链首）
    mount(ctx, TOOL_BOOTSTRAP, 'assemble-authority')               // 两条 assembly 声明后注册
    toolCatalog(ctx, [...BOOTSTRAP_ALLOW, 'read', INTRUDER_TOOL])  // allow 名单齐全 ⇒ 走真窄化而非 fail-open
  })
  const names = toolNames(await h.assemble(scope, sessionWith()))
  assert.deepEqual(names, BOOTSTRAP_ALLOW,
    '受控相位下目录被裁到 allow 名单；竞争者不能把名单外的工具加回来')
})

test('名单掩码：tool-filter 的 assembly 声明位于 prepend 竞争者之外', async (t) => {
  const h = await harness(t)
  const scope = await h.scope((ctx) => {
    toolIntruder(ctx, [INTRUDER_TOOL])                             // 竞争者先注册（链首）
    mount(ctx, TOOL_FILTER, 'assemble-authority')                  // assembly + sdk-strip + guard
    toolCatalog(ctx, ['bash', INTRUDER_TOOL, 'read'])
  })
  const names = toolNames(await h.assemble(scope, sessionWith()))
  assert.equal(names.includes(INTRUDER_TOOL), false,
    '被 deny 名单掩码剔除的工具不能被竞争者加回装配目录')
})

test('已知边界：竞争者同为 prepend 且注册在引擎行之后时仍处于更外层', async (t) => {
  const h = await harness(t)
  const scope = await h.scope((ctx) => {
    mount(ctx, CONTEXT_GATE, 'assemble-authority')                 // 引擎行先注册
    contextIntruder(ctx, [INTRUDER_CONTEXT])                       // 竞争者后注册 ⇒ 更外层
    wireLayers(ctx, createPromptConfigs([RUNTIME_CONTEXT]), () => {})
  })
  const sections = renderContextSections(await h.assemble(scope, sessionWith()))
  assert.deepEqual(sections.map((entry) => entry.name), ['intruder'],
    'prepend 语义的固有限制：同为 prepend 时后注册者更外层，门控会被翻越（见 PLAN 实施取舍与已知边界）')
})
