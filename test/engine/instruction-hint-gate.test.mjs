// instruction-hint 的 plugin 形态：挂本行 = 开启「晋升后把 agent-instructions 全文
// 替换为一次性 hint，后续全文消息丢弃」（原 context-gate 的 instructionHint 转换）。
// 桩与 test/engine/promotion-gate.test.mjs 同形状（本仓库惯例：每个测试文件自带一份）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { apply as applyInstructionHint } from '../../engine/instruction-hint.mjs'

/** 收集 ctx.on 注册的监听器（按注册顺序）。 */
function makeCtx() {
  const listeners = new Map()
  const ctx = {
    logger: { warn: () => {} },
    tools: { register: () => {} },
    on(type, handler, opts) {
      const list = listeners.get(type) ?? []
      list.push({ handler, opts })
      listeners.set(type, list)
    },
  }
  return { ctx, listeners }
}

function makeSession(events = [], visibleMessages) {
  return {
    id: `s-${Math.random()}`,
    header: { cwd: '/workspace', delegationDepth: 0 },
    snapshotEvents: () => events,
    ...(visibleMessages === undefined ? {} : { deriveMessages: () => visibleMessages }),
  }
}

const makeAgent = (session) => ({ session, ctx: { tools: { presentAs: () => () => {} } } })

async function preStepThrough(listeners, agent, messages) {
  const handlers = (listeners.get('agent/pre-step') ?? []).map((entry) => entry.handler)
  assert.ok(handlers.length > 0, '应注册 agent/pre-step')
  // claimed = inbox 批（真实语义：只有用户消息；注入消息不在 claimed 内）。
  const baseline = messages.filter((message) => message.source?.kind === 'user')
  // waterfall 串联：先注册者先执行，next() 进入下一监听器。
  const chain = async (index) => {
    if (index >= handlers.length) return { kind: 'enter', messages }
    return handlers[index]({ agent, messages: baseline }, async () => chain(index + 1))
  }
  return chain(0)
}

const msg = (kind, text) => ({ id: `m-${Math.random()}`, role: 'user', content: [{ type: 'text', text }], source: { kind } })

/** agent-instructions 全文 dump（含可提取的参考文件路径）。 */
const instructionDump = (paths, id = `m-${Math.random()}`) => ({
  id,
  role: 'user',
  content: [{ type: 'text', text: `${paths.map((path) => `Instructions from: ${path}`).join('\n')}\nbody` }],
  source: { kind: 'agent-instructions' },
})

const kindsOf = (decision) => decision.messages.map((message) => message.source.kind)
const PROMOTED = [{ type: 'tool/call', seq: 1 }]
const emit = (listeners, session, event) => {
  for (const { handler } of listeners.get('session/event') ?? []) handler(session, event)
}

test('① 未晋升：全文原样保留，不做任何转换', async () => {
  const { ctx, listeners } = makeCtx()
  applyInstructionHint(ctx, { enabled: true })
  const dump = instructionDump(['/ref/A.md'])
  const decision = await preStepThrough(listeners, makeAgent(makeSession([])), [msg('user', 'hi'), dump])
  assert.deepEqual(kindsOf(decision), ['user', 'agent-instructions'])
  assert.equal(decision.messages[1], dump, '未晋升时同一对象原样通过')
})

test('② 晋升后首次：全文替换为一次性 hint（保留原 id）', async () => {
  const { ctx, listeners } = makeCtx()
  applyInstructionHint(ctx, { enabled: true })
  const dump = instructionDump(['/ref/A.md', '/ref/B.md'], 'agent-instructions-1')
  const decision = await preStepThrough(listeners, makeAgent(makeSession(PROMOTED)), [msg('user', 'hi'), dump])
  assert.deepEqual(kindsOf(decision), ['user', 'instruction-hint'])
  const hint = decision.messages[1]
  assert.equal(hint.id, 'agent-instructions-1', '替换时保留原消息 id')
  assert.equal(hint.source.kind, 'instruction-hint')
  assert.equal(hint.source.form, 'hint')
  assert.equal(hint.source.plugin, 'instruction-hint')
  assert.match(hint.content[0].text, /Reference documents exist: \/ref\/A\.md, \/ref\/B\.md/)
  assert.doesNotMatch(hint.content[0].text, /body/, 'hint 只提示文件存在，不含原文正文')
})

test('③ 晋升后第二次：hint 已在可见历史时，后续全文消息被丢弃', async () => {
  const { ctx, listeners } = makeCtx()
  applyInstructionHint(ctx, { enabled: true })
  const visibleMessages = []
  const agent = makeAgent(makeSession(PROMOTED, visibleMessages))
  const first = await preStepThrough(listeners, agent, [msg('user', 'hi'), instructionDump(['/ref/A.md'])])
  // 被批准的 hint 进入模型可见 surface（durable 记录）。
  visibleMessages.push(...first.messages.filter((message) => message.source.kind === 'instruction-hint'))
  const second = await preStepThrough(listeners, agent, [msg('user', 'hi2'), instructionDump(['/ref/A.md'])])
  assert.deepEqual(kindsOf(second), ['user'], '不重复替换：后续全文消息静默丢弃')
})

test('③b 压缩后 hint 离开 surface 且重新晋升：再次提示（生命周期归可见 surface）', async () => {
  const { ctx, listeners } = makeCtx()
  applyInstructionHint(ctx, { enabled: true })
  const visibleMessages = []
  const session = makeSession(PROMOTED, visibleMessages)
  const agent = makeAgent(session)
  const first = await preStepThrough(listeners, agent, [msg('user', 'hi'), instructionDump(['/ref/A.md'])])
  visibleMessages.push(...first.messages.filter((message) => message.source.kind === 'instruction-hint'))
  // 成功压缩清空可见 surface（hint 被摘要覆盖），边界之后重新晋升。
  emit(listeners, session, { type: 'compaction/end', seq: 2, data: {} })
  visibleMessages.length = 0
  emit(listeners, session, { type: 'tool/call', seq: 3 })
  const again = await preStepThrough(listeners, agent, [msg('user', 'hi3'), instructionDump(['/ref/A.md'])])
  assert.deepEqual(kindsOf(again), ['user', 'instruction-hint'], 'hint 不在 surface 时重新提示')
})

test('④ deriveMessages 已含 hint（换会话恢复）：不重复替换', async () => {
  const { ctx, listeners } = makeCtx()
  applyInstructionHint(ctx, { enabled: true })
  const hint = {
    id: 'hint-1',
    role: 'user',
    content: [{ type: 'text', text: 'hint' }],
    source: { kind: 'instruction-hint', form: 'hint' },
  }
  const decision = await preStepThrough(listeners, makeAgent(makeSession(PROMOTED, [hint])), [
    msg('user', 'hi'),
    instructionDump(['/ref/A.md']),
  ])
  assert.deepEqual(kindsOf(decision), ['user'], '可见 surface 已有 hint：丢弃新的全文消息')
})

test('⑤ 非目标来源：永远原样通过（对象身份不变）', async () => {
  const { ctx, listeners } = makeCtx()
  applyInstructionHint(ctx, { enabled: true })
  const user = msg('user', 'hi')
  const skill = msg('skill-invocation', 'skill')
  const decision = await preStepThrough(listeners, makeAgent(makeSession(PROMOTED)), [user, skill])
  assert.equal(decision.messages[0], user)
  assert.equal(decision.messages[1], skill)
})

test('⑥ 转换抛错：保留原消息，不阻断会话', async () => {
  const { ctx, listeners } = makeCtx()
  applyInstructionHint(ctx, { enabled: true })
  const session = {
    id: 'broken-surface',
    header: { cwd: '/workspace', delegationDepth: 0 },
    snapshotEvents: () => PROMOTED,
    deriveMessages: () => { throw new Error('surface unavailable') },
  }
  const dump = instructionDump(['/ref/A.md'])
  const decision = await preStepThrough(listeners, makeAgent(session), [msg('user', 'hi'), dump])
  assert.deepEqual(kindsOf(decision), ['user', 'agent-instructions'], '降级为保留原消息')
  assert.equal(decision.messages[1], dump)
})

test('⑦ enabled 缺省 false（未声明即关闭）：不注册任何行为', () => {
  for (const config of [undefined, {}, { enabled: false }]) {
    const { ctx, listeners } = makeCtx()
    applyInstructionHint(ctx, config)
    assert.equal(listeners.size, 0, `config=${JSON.stringify(config)} 不得注册监听器`)
  }
})

test('⑧ 未知键 / 非法配置：挂载期 fail loud（enabled 未声明也不豁免）', () => {
  assert.throws(() => applyInstructionHint(makeCtx().ctx, { enabled: true, hint: true }), /unknown config key/)
  assert.throws(() => applyInstructionHint(makeCtx().ctx, { enabled: true, promoteOn: 'tool' }), /promoteOn/)
  assert.throws(() => applyInstructionHint(makeCtx().ctx, { enabled: true, includeSubagents: 'yes' }), /includeSubagents/)
  assert.throws(() => applyInstructionHint(makeCtx().ctx, { promoteOn: 'tool' }), /promoteOn/)
})

test('⑨ includeSubagents 缺省 false：子代理首次请求即按已晋升转换', async () => {
  const { ctx, listeners } = makeCtx()
  applyInstructionHint(ctx, { enabled: true })
  const subagent = {
    session: { id: 'sub-1', header: { cwd: '/workspace', delegationDepth: 1 }, snapshotEvents: () => [] },
    ctx: { tools: { presentAs: () => () => {} } },
  }
  const decision = await preStepThrough(listeners, subagent, [msg('user', 'hi'), instructionDump(['/ref/A.md'])])
  assert.deepEqual(kindsOf(decision), ['user', 'instruction-hint'])
})

test('⑩ 真实 agent/pre-step waterfall 通道（dsh-agent dispatch）：与手写桩同结果', async () => {
  const app = new Context()
  applyInstructionHint(app, { enabled: true })
  const agent = { session: makeSession(PROMOTED), options: {} }
  const claimed = msg('user', 'claimed')
  const decision = await agentEvents(app, agent).waterfall(
    'agent/pre-step',
    { messages: [claimed], turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [claimed, instructionDump(['/ref/A.md'])] }),
  )
  assert.deepEqual(kindsOf(decision), ['user', 'instruction-hint'])
})
