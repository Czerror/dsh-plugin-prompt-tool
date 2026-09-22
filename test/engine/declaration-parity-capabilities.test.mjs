/**
 * B7 T1 → T3 —— 四个能力（`anchor-turn` / `deliberation-gate` / `progress-reminder` /
 * `tool-bootstrap`）的**载荷契约与声明文件契约**。
 *
 * T1 时本文件是「原模块 `engine/<能力>.mjs` vs 声明」的等价对拍（同一组会话事件 + 同一配置下
 * 装配结果 / 裁决 / 注入时机逐项相同）。T3 把这四个模块与本地下同名组合源一并删除（其行为改由
 * 预设顶层 `triggers` 段的声明表达），对拍的那一半已无对象可对，随模块一同退场。
 *
 * 保留下来的都是**不依赖原模块**的长期防回归钉子：
 *   1. 载荷契约（真实 Context + ToolRuntime + SystemPrompt）：归一化后 `agent` 可达、第一个实参
 *      的顶层字段仍保留、会话态谓词按真实会话判定而非恒常数、`composite` 转发 `observe`；
 *   2. 声明文件契约：`test/engine/declarations/*.yml` 的取值逐字等于**删除前**的组合源默认
 *      （原值内联在下方常量里，组合源已随本批删除）。
 *
 * 桩与派发的形状取自既有测试，不另造一套：
 *   - `on` / `effect` / `get` / `logger.warn`：actions.test.mjs 的 recordingCtx；
 *   - 真实宿主的建法（Context + ToolRuntime + createScope）：actions.test.mjs 的 ptcHarness。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { registerAction } from '../../engine/actions.mjs'
import { composite, createCountPredicate, createPhasePredicate, createSessionStatePredicate } from '../../engine/predicates.mjs'

// ───────────────────────── 桩、派发与装载 ─────────────────────────

/** 读声明文件（与 declared-triggers.mjs 的读取契约一致：YAML 数组）。 */
function readDeclarationFile(fileName) {
  const url = new URL(`./declarations/${fileName}`, import.meta.url)
  const parsed = parseYaml(readFileSync(url, 'utf8'), { logLevel: 'silent' })
  assert.ok(Array.isArray(parsed), `${fileName} 必须是 YAML 数组（与 declared-triggers.mjs 同契约）`)
  return parsed
}

// ───────────────────────── 一、载荷契约（真实宿主，防回归） ─────────────────────────

/**
 * 真实 Context + ToolRuntime + SystemPrompt：把真实 `tools/pre-execute` 与
 * `system-prompt/assemble` 的载荷抓下来。`mode: 'native'` 走原生工具管线（与本对拍无关
 * 的 PTC 传输不需要）。
 */
async function probeHarness() {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime, { mode: 'native' })
  const definition = (toolName) => ({
    name: toolName,
    description: `tool ${toolName}`,
    parameters: { type: 'object', properties: { command: { type: 'string' } }, additionalProperties: true },
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'ok' }] },
    execute: async () => ({ ran: toolName }),
  })
  root.tools.register(definition('bash'))

  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { turn: 1, message: { content: [{ type: 'text', text: 'hi' }] } } },
    { type: 'assistant/message', seq: 3, data: { turn: 1, message: { content: [{ type: 'text', text: 'x'.repeat(500) }] } } },
  ]
  const session = { id: 's-probe', header: { cwd: '/workspace', delegationDepth: 0 }, append() {}, snapshotEvents: () => events }
  const record = { id: 'probe', options: { model: 'deepseek-chat' }, session }
  const scope = createScope(root, record)
  record.ctx = await new Promise((resolve) => { scope.ctx.inject(['tools'], (toolCtx) => resolve(toolCtx)) })

  const seen = {}
  registerAction(root, { kind: 'decision', id: 'probe-pre', phase: 'pre', decision: 'deny', reason: 'probe' }, {
    when: (payload) => { seen.pre = payload; return false },
  })
  registerAction(root, { kind: 'assembly', id: 'probe-assemble', target: { tools: { deny: ['no-such-tool'] } } }, {
    when: (payload) => { seen.assemble = payload; return false },
  })

  const result = await root.tools.execute({
    callId: 'c-probe', name: 'bash', agent: record, arguments: {}, signal: new AbortController().signal,
  })
  assert.equal(result.isError, false, '探针工具必须真的执行，否则测不到真实 pre-execute 载荷')
  await root.systemPrompt.assemble({ agent: record, scope: record })
  return { root, record, session, events, seen }
}

test('载荷契约（真实宿主）：归一化后 agent 可达、原字段保留，会话态谓词按真实会话判定', async () => {
  const { record, session, events, seen } = await probeHarness()
  const { pre, assemble } = seen

  // 1. 归一化载荷带 agent：`tools/pre-execute` → `args[0].agent`；
  //    `system-prompt/assemble` → `args[1].agent`（predicates.mjs:68-85 的取法表）。
  assert.equal(pre.agent?.session?.id, 's-probe', 'pre-execute 载荷必须带真实 agent')
  assert.equal(assemble.agent?.session?.id, 's-probe', 'assemble 载荷必须从第二个实参 context 取到 agent')
  // 2. 第一个实参的顶层字段原样保留（旧形态继续可见，既有断言不受归一化影响）。
  assert.equal(pre.name, 'bash', 'exec 顶层字段保留')
  assert.equal(pre.callId, 'c-probe', 'exec 顶层字段保留')
  assert.ok(Array.isArray(assemble.tools) && Array.isArray(assemble.sections), 'assembly 顶层字段保留')
  // 3. 会话态谓词按真实会话判定 —— 修复前这里是恒常数（count 恒 0 / phase 恒「已晋升」/ session 恒命中）。
  assert.equal(createSessionStatePredicate({ type: 'user/message', present: false })(pre), false,
    '日志里有 user/message → 「尚无 user/message」不成立（修复前恒 true）')
  assert.equal(createSessionStatePredicate({ type: 'user/message', present: true })(pre), true)
  assert.equal(createCountPredicate({ of: 'assistant-chars', per: 'turn', min: 400 })(pre), true,
    '本轮 assistant 文本 500 字符 ≥ 400（修复前恒 false）')
  assert.equal(createCountPredicate({ of: 'assistant-chars', per: 'turn', max: 399 })(pre), false,
    '同一载荷在 max 侧为 false —— 说明这是判定而非常数')
  assert.equal(createCountPredicate({ of: 'assistant-chars', per: 'turn', min: 400 })(assemble), true,
    'assemble 载荷同样读到真实会话')
  // 4. 相位：订阅档（声明路径的实际接线 —— `wireTriggerObservers` 把 session/event 喂给
  //    `when.observe`；`composite` 现在也转发子谓词的 observe，组合节点同样可订阅）。
  const phase = createPhasePredicate({ promoteEvents: ['tool/call'] })
  assert.equal(phase(pre), false, '日志无 tool/call → 未晋升（修复前 status(undefined) 恒 true）')
  const toolCall = { type: 'tool/call', seq: 4, data: { turn: 1 } }
  events.push(toolCall)
  phase.observe(session, toolCall)
  assert.equal(phase(pre), true, 'observe 喂入后 → 晋升：判定随 durable 事实变化')
  // 组合层转发 observe：`not`/`any`/`all`/`notAny` 都不得把子谓词的增量入口吞掉。
  const composedSession = { id: 's-composed', header: { delegationDepth: 0 }, snapshotEvents: () => [] }
  const composedAgent = { session: composedSession, options: { model: 'deepseek-chat' } }
  const composed = composite({ not: createPhasePredicate({ promoteEvents: ['tool/call'] }) })
  assert.equal(typeof composed.observe, 'function', 'composite 必须转发子谓词的 observe')
  assert.equal(composed(composedAgent), true, '未晋升 → not phase 命中')
  composed.observe(composedSession, { type: 'tool/call', seq: 1, data: { turn: 1 } })
  assert.equal(composed(composedAgent), false, 'observe 经 composite 抵达 phase → 晋升后 not phase 不再命中')
  // 5. 旧形态兼容：载荷本身就是 agent（手写调用方 / 既有测试）仍成立。
  assert.equal(createSessionStatePredicate({ type: 'user/message', present: true })(record), true,
    '直接传 agent 的旧形态仍按 agent.session 判定')
  assert.equal(typeof record.id, 'string')
})

// ───────────────────────── 二、声明文件契约 ─────────────────────────

// 以下常量是**删除前**组合源 config 的原值（`engine/compositions/source/local/<模块>.yml`，
// B7 T3 已随模块删除）。内联在此，声明文件的取值仍必须与它们逐字一致。
const ANCHOR_TEXT = 'This round is a test. Tools are not open yet; all tools will open next round.'
const GATE = {
  minChars: 400,
  maxGatesPerTurn: 1,
  gateText: 'Deliberation gate: this turn has not shown its reasoning yet. Before retrying this tool call, write out your full reasoning in your reply — start with "We", restate the goal, weigh the approaches, and lay out the concrete steps and risks — then issue the tool call again. This message is a planning prompt, not a tool failure.',
}
const DRIP = {
  every: 4,
  maxPerTurn: 1,
  text: 'Progress check: before the next action, restate in one "We …" sentence what remains of the goal and why the next step is the right one.',
}
const BOOTSTRAP = {
  bootstrapTools: ['bash', 'str_replace_editor'],
  compactionTools: ['read', 'write', 'edit', 'glob', 'grep', 'todo_write', 'ask_user_question'],
}
const BOOTSTRAP_MAX_TOKENS = 1024

test('声明文件契约：YAML 数组形状 + 取值与删除前的组合源默认逐字一致', () => {
  const specsOf = (fileName) => readDeclarationFile(fileName)
  assert.equal(specsOf('anchor-turn.yml')[0].do.text, ANCHOR_TEXT, '锚定正文必须复刻组合源 config.text')
  assert.equal(specsOf('anchor-turn.yml')[0].do.target, 'next-turn')
  assert.equal(specsOf('anchor-turn.yml')[0].when.session.delegated, false,
    '受众：includeSubagents: false ⇔ delegated: false（只在主会话锚定）')
  assert.equal(specsOf('deliberation-gate.yml')[0].do.reason, GATE.gateText, '拒绝文案必须复刻组合源 config.gateText')
  assert.equal(specsOf('deliberation-gate.yml')[0].when.count.max, GATE.minChars - 1, '深度阈值 = minChars - 1')
  assert.equal(specsOf('deliberation-gate.yml')[0].do.decision, 'deny')
  assert.equal(specsOf('progress-reminder.yml')[0].do.text, DRIP.text, '提醒正文必须复刻组合源 config.text')
  assert.equal(specsOf('progress-reminder.yml')[0].when.count.every, DRIP.every,
    '节奏 = count.every = every（含 `count > 0` 约定，见该文件注释）')
  assert.equal(specsOf('progress-reminder.yml')[0].when.count.includeCurrent, true,
    '计数时点：把本次即将落盘的 tool/result 计入（仅 post-execute 上成立）')
  assert.equal(specsOf('progress-reminder.yml')[0].when.count.delegated, false, '受众：只在主会话滴入')
  assert.equal(specsOf('progress-reminder.yml')[0].do.maxPerTurn, DRIP.maxPerTurn, '每轮上限 = maxPerTurn（动作侧预算）')
  assert.equal(specsOf('deliberation-gate.yml')[0].do.maxPerTurn, GATE.maxGatesPerTurn,
    '每轮上限 = maxGatesPerTurn（动作侧预算）')
  assert.equal(specsOf('deliberation-gate.yml')[0].when.count.delegated, false, '受众：只在主会话门控')
  const bootstrap = specsOf('tool-bootstrap.yml')
  assert.deepEqual(bootstrap[0].do.target.tools.allow, BOOTSTRAP.bootstrapTools, '受控相位工具面 = bootstrapTools')
  assert.deepEqual(
    [bootstrap[0].when.phase.compacted, bootstrap[0].when.phase.promoted],
    [false, false],
    '声明 1 的相位 = ¬C ∧ ¬P（受控相位、未压缩）',
  )
  assert.deepEqual(
    [bootstrap[1].when.phase.compacted, bootstrap[1].when.phase.promoted],
    [true, false],
    '声明 2 的相位 = C ∧ ¬P（compaction 回退）',
  )
  assert.deepEqual(bootstrap[1].do.target.tools.allow,
    [...BOOTSTRAP.bootstrapTools, ...BOOTSTRAP.compactionTools],
    'compaction 回退目录 = bootstrapTools + compactionTools')
  assert.equal(bootstrap[0].do.target.tools.requireMatch, true,
    'fail-open 兜底：任意一个 allow 工具缺失即暴露完整目录（tool-filter 不加此项）')
  assert.deepEqual(bootstrap[0].do.target.sections.keep,
    ['deployment:persona-prefix', 'deployment:persona-suffix'],
    'sections 白名单 = PERSONA_SECTION_NAMES（与 filter 语义逐例等价）')
  assert.equal(bootstrap[0].do.target.sections.remove, undefined, 'keep 与 remove 互斥（同时声明会挂载期 fail loud）')
  assert.equal(bootstrap[2].do.patch.maxTokens, BOOTSTRAP_MAX_TOKENS, '未晋升 patch 值')
  assert.equal(bootstrap[3].do.unset.maxTokens, BOOTSTRAP_MAX_TOKENS, '晋升后按值删键的声明值必须与 patch 一致')
  for (const spec of [...specsOf('anchor-turn.yml'), ...specsOf('deliberation-gate.yml'), ...specsOf('progress-reminder.yml'), ...bootstrap]) {
    assert.equal(typeof spec.id, 'string')
    assert.equal(typeof spec.channel, 'string')
  }
})
