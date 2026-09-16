// T23：ST 转译完整性（R7–R14）的端到端集成。
//
// 合成夹具覆盖本轮接入的全部新形态（键宏、delayUntilRecursion、useGroupScoring、
// creator notes / depth prompt 扫描开关、characterFilter、automationId、
// prompts[].system_prompt、extensions.depth_prompt），走真实链路：
// 转换（convertStToPresetWithReport）→ pre-step 协调器注入 → 官方
// `@deepseek-ai/dsh-session` 持久化与重载。不使用 stub 加载器。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Session, snapshotSessionEvent } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { applyPromptConfigs, createPromptConfigs } from '../../engine/prompt-config-engine.mjs'
import { installPreStepCoordinator } from '../../src/runtime/pre-step-coordinator.ts'
import { convertStToPreset, convertStToPresetWithReport } from '../../src/host/sillytavern.ts'

const ENGINE_DIR = new URL('../../engine/', import.meta.url).href
const signalOf = () => new AbortController().signal
let sessionCounter = 0

const userMessage = (text, id = `u-${text}`) => ({
  id,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

const messagesOf = (decision) => (Array.isArray(decision?.messages) ? decision.messages : [])

/** 宿主写入路径：本步承认的消息逐条成为持久事件。 */
const persist = (session, messages) => {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  for (const message of messages) session.append('user/message', message, { surfaceOp: 'append' })
}

/** 官方持久化 → 重新加载 → 派生请求（任何非法角色都会在 Session.create 处抛错）。 */
const replay = (messages) => {
  const id = `r14-${++sessionCounter}`
  const live = Session.create(`${id}-live`)
  persist(live, messages)
  const seed = JSON.parse(JSON.stringify(live.snapshotEvents().map((event) => snapshotSessionEvent(event))))
  return Session.create(`${id}-restored`, seed).deriveMessages().map((message) => message.role)
}

/** 真实装配 + 真实 pre-step 派发，返回本步注入的插件来源 id。 */
async function inject(configs, texts) {
  const app = new Context()
  installPreStepCoordinator(app, { collectFiles: () => [] })
  const agent = { session: { id: `r14-${++sessionCounter}`, header: { delegationDepth: 0 }, snapshotEvents: () => [], deriveMessages: () => [] }, options: { model: 'pro' } }
  const scope = createScope(app, agent)
  agent.ctx = scope.ctx
  applyPromptConfigs(scope.ctx, createPromptConfigs(configs, { strategyDir: ENGINE_DIR }), { prepend: true, sourceId: 'r14:fixture' })
  const decision = await agentEvents(app, agent).waterfall(
    'agent/pre-step',
    { messages: texts.map((text) => userMessage(text)), turn: 1, step: 1, signal: signalOf() },
    async () => ({ kind: 'enter', messages: texts.map((text) => userMessage(text)) }),
  )
  const injected = messagesOf(decision)
  const result = { injected, plugins: injected.map((message) => message.source?.plugin) }
  await scope.dispose()
  return result
}

/** 合成夹具：覆盖 R7–R13 接入的全部字段形态。 */
const fixture = {
  name: 'R14 夹具',
  prompts: [
    { identifier: 'main', role: 'system', content: 'MAIN-SECTION', enabled: true, system_prompt: true },
    { identifier: 'aux', role: 'user', content: 'AUX-USER', enabled: true, system_prompt: true },
  ],
  data: {
    name: 'Ada',
    description: 'DESC',
    creator_notes: 'NOTES-ONLY',
    first_mes: 'GREETING',
    extensions: { depth_prompt: { prompt: 'DEEP-ONLY', depth: 4, role: 0 } },
    character_book: { entries: [
      { id: 25, keys: ['{{user}}'], content: 'USER-LORE', constant: false, selective: true, role: 1, extensions: {} },
      { id: 26, keys: ['DELAYED'], content: 'DELAYED-LORE', constant: true, role: 1, extensions: { delay_until_recursion: true } },
      { id: 27, keys: ['P'], content: 'SCORED-LORE', role: 1, extensions: { group: 'G', use_group_scoring: true } },
      { id: 28, keys: ['NOTES-ONLY'], content: 'NOTES-LORE', role: 1, extensions: { match_creator_notes: true } },
      { id: 29, keys: ['P'], content: 'FILTERED-LORE', role: 1, characterFilter: { names: ['Ada'], tags: [], isExclude: false } },
      { id: 30, keys: ['P'], content: 'AUTO-LORE', role: 1, automationId: 'auto-1' },
    ] },
  },
}

test('T23 合成夹具：转换 → 真实 pre-step 注入 → 官方会话重载', async () => {
  const { spec, report } = convertStToPresetWithReport(fixture, 'r14')
  const codes = new Set(report.diagnostics.map((item) => item.code))
  for (const code of ['st-key-macro', 'st-worldbook-character-filter', 'st-worldbook-automation', 'st-prompt-system-flag', 'st-depth-prompt']) {
    assert.equal(codes.has(code), true, `夹具必须覆盖诊断 ${code}`)
  }
  // R7/R13：变量登记与禁用配置在产物里。
  assert.equal(spec.variables.user, '')
  assert.equal(spec.variables.creator_notes, 'NOTES-ONLY')
  assert.equal(spec.variables.depth_prompt, 'DEEP-ONLY')
  assert.equal(spec.promptConfigs.find((config) => config.id === 'st-depth-prompt').enabled, false)

  const { injected } = await inject(spec.promptConfigs.map((config) => ({ ...config, variables: spec.variables })), ['P'])
  // merged 配置按位置合并成一条消息（source.plugin 为 `merged:<position>`），
  // 因此断言按注入正文核对，而不是按单个配置 id。
  const text = injected.flatMap((message) => message.content ?? []).map((block) => String(block.text ?? '')).join('\n')
  assert.doesNotMatch(text, /USER-LORE/, 'R7：未赋值的键宏条目不误触发')
  assert.doesNotMatch(text, /DELAYED-LORE/, 'R8：延迟到递归的条目在首个 pass 不注入')
  assert.doesNotMatch(text, /DEEP-ONLY/, 'R13：depth_prompt 禁用配置不注入')
  assert.doesNotMatch(text, /MAIN-SECTION/, 'system-section 不进 pre-step')
  assert.match(text, /NOTES-LORE/, 'R9：扫描开关按 creator notes 命中并注入')
  assert.match(text, /SCORED-LORE/, 'R8：组内评分不影响未开启评分的单成员组')
  assert.match(text, /FILTERED-LORE/, 'R10：角色过滤不被静默跳过（保留并照常注入）')
  assert.match(text, /AUTO-LORE/, 'R11：自动化条目保留并照常注入')
  assert.match(text, /AUX-USER/, 'R12：system_prompt 标记不改变层归属（role=user 仍在 pre-step）')
  assert.match(text, /GREETING/, '开场白照常注入')
  assert.ok(injected.every((message) => message.role === 'user'), 'pre-step 出口只发出 user')

  // 官方回放：注入批次可持久化 → 重新加载 → 派生请求，角色全部合法。
  assert.deepEqual(replay(injected), injected.map(() => 'user'))
})

test('T23 V0.66.png#25 形态：未赋值不触发 → 赋值后触发，且都能通过官方回放', async () => {
  const card = { data: { name: 'Ada', character_book: { entries: [
    { id: 25, keys: ['{{user}}'], content: 'USER-LORE', constant: false, selective: true, role: 1, extensions: {} },
  ] } } }
  const spec = convertStToPreset(card, 'v066')
  assert.equal(spec.variables.user, '')

  const unset = await inject(spec.promptConfigs.map((config) => ({ ...config, variables: spec.variables })), ['Alice'])
  assert.equal(unset.plugins.includes('lore-25'), false, '未赋值时该键不参与匹配')
  assert.deepEqual(replay(unset.injected), unset.injected.map(() => 'user'))

  const assigned = await inject(
    spec.promptConfigs.map((config) => ({ ...config, variables: { ...spec.variables, user: 'Alice' } })), ['Alice'])
  assert.equal(assigned.plugins.includes('lore-25'), true, '赋值后含该值的消息命中并注入')
  assert.deepEqual(replay(assigned.injected), assigned.injected.map(() => 'user'))
  const text = assigned.injected.filter((message) => message.source?.plugin === 'lore-25')
    .flatMap((message) => message.content).map((block) => block.text).join('')
  assert.equal(text, 'USER-LORE', '注入正文与卡片内容一致')
})
