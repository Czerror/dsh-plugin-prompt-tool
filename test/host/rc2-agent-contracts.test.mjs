import '../../engine/instructions-budget-early.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { compileRules } from '../../engine/rule-spec.mjs'
import { createRuleRuntime } from '../../engine/rule-runtime.mjs'
import { delegationLimitsStatus } from '../../engine/delegation-limits.mjs'

const require = createRequire(import.meta.url)
const peerRequire = createRequire(require.resolve('@deepseek-ai/dsh-agent-loop'))
const peer = name => import(pathToFileURL(peerRequire.resolve(name)).href)
const [{ default: Llm, LlmAdapter }, { default: Agents }, { default: Sessions }, { default: Projections },
  { default: Prompt }, { default: Tools }, Native, { default: Loop }, Persistence, { default: Subagents }, Spawn, Tool] = await Promise.all([
  peer('@deepseek-ai/dsh-llm'), peer('@deepseek-ai/dsh-agent'), peer('@deepseek-ai/dsh-session'), peer('@deepseek-ai/dsh-session-projection'),
  peer('@deepseek-ai/dsh-system-prompt'), peer('@deepseek-ai/dsh-tools'), peer('@deepseek-ai/dsh-tool-executor-native'),
  peer('@deepseek-ai/dsh-agent-loop'), peer('@deepseek-ai/dsh-session-persistence-jsonl'), peer('@deepseek-ai/dsh-subagent'),
  import('@deepseek-ai/dsh-subagent-spawn-in-process'), import('@deepseek-ai/dsh-tool-subagent'),
])

test('连续记录沿真实消息和工具执行，重放不增原文，旧历史与关闭后材料不纳入', { timeout: 30000 }, async t => {
  const root = new Context(), home = mkdtempSync(join(tmpdir(), 'soul-record-'))
  const dir = join(home, 'modules', 'alice')
  mkdirSync(join(dir, 'data'), { recursive: true })
  writeFileSync(join(dir, 'module.yml'), 'id: alice\nmodules: []\nrules: []\n')
  writeFileSync(join(dir, 'data', 'SELF.src.md'), 'USER SKELETON')
  const storage = await import('@deepseek-ai/dsh-storage')
  const json = await import('@deepseek-ai/dsh-storage-json')
  const domain = await import('@deepseek-ai/dsh-storage-domain')
  const { createUserMessage, createAssistantMessage, createToolResultMessage } = await peer('@deepseek-ai/dsh-llm')
  const { openSoulKnowledge } = await import('../../src/host/soul-knowledge.ts')
  const { installSoulRuntime } = await import('../../src/runtime/soul-runtime.ts')
  const { registerTuiCommand } = await import('../../src/runtime/tui.ts')
  const Commands = await peer('@deepseek-ai/dsh-commands')
  const { registerSoulLedgerTools } = await import('../../src/runtime/soul-ledger-tools.ts')
  const { registerSoulStateTools } = await import('../../src/runtime/soul-state-tools.ts')
  const { registerModuleFileTools } = await import('../../src/runtime/module-file-tools.ts')
  const { readSoulLedgerProjection } = await import('../../src/host/soul-ledger.ts')
  for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Native, Agents, storage.default]) await root.plugin(plugin)
  await root.plugin(Commands.default)
  root.provide('settings', {})
  await root.plugin(json, { root: join(home, 'storage') })
  await root.plugin(domain, { backend: 'json' })
  await root.plugin(Persistence, { root: join(home, 'sessions'), compression: 'none' })
  await root.plugin(Loop, { agents: [] })
  let modelCalls = 0
  const auxiliary = []
  let heldAuxiliary = false, omitUsage = false
  class Model extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id } }
    async *stream(request) {
      modelCalls++
      if (request.purpose) auxiliary.push(request)
      if (request.purpose && heldAuxiliary) await new Promise((_, reject) => {
        if (request.signal.aborted) reject(request.signal.reason)
        else request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
      })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      if (request.model === 'held') await new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }))
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fixture response' } }
      if (request.purpose && !omitUsage) yield { type: 'usage', usage: { inputTokens: 13, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 2, totalTokens: 23 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  root.llm.registerAdapter(['fixture'], new Model())
  root.provide('workingDirectory', { get: session => session.header.cwd ?? home, ensure: async () => home, set: async () => home })
  await root.plugin(Subagents)
  await root.plugin(Spawn, { providerName: 'spawn' })
  await root.plugin(Tool, { provider: 'spawn', agentOptions: { provider: 'fixture', model: 'held' } })
  const handle = await root.agents.create({ sessionId: 'record-parent', agentOptions: { provider: 'fixture', model: 'normal' }, meta: { cwd: home } })
  const agent = handle.agent
  const handles = [handle]
  let failDerived = false, failPublication = false, bindingsTable, bindingId
  const facility = { async open(definition) {
    const domain = await root.storageDomain.open(definition)
    return { close: () => domain.close(), table(name) {
      const table = domain.table(name)
      return new Proxy(table, { get(target, key) {
        if (key === 'put') return async (id, value) => {
          if (definition.name === 'prompt_tool_soul_knowledge') { bindingsTable = table; bindingId = id }
          if (failPublication && value.publications?.length) { failPublication = false; throw new Error('injected publication CAS failure') }
          if (failDerived && value.records?.length > 1) { failDerived = false; throw new Error('injected derived persistence failure') }
          return target.put(id, value)
        }
        const value = target[key]
        return typeof value === 'function' ? value.bind(target) : value
      } })
    } }
  } }
  let replaceEvidence = false, replaceAfterLoads = 0, replacedSeq = -1, commandObservation, learningObservation, evidenceObservation, evidenceLoads = 0
  const loadKnowledgeSession = async id => {
    evidenceLoads++
    if (evidenceObservation) await evidenceObservation(id)
    if (id === 'command-cas' && commandObservation) await commandObservation()
    if (learningObservation) { const observe = learningObservation; learningObservation = undefined; await observe() }
    if (replaceAfterLoads > 0 && --replaceAfterLoads === 0) replaceEvidence = true
    const session = root.sessions.get(id)
    const events = session?.snapshotEvents().map(event => replaceEvidence && event.seq === replacedSeq ? { ...event, data: { ...event.data, replacement: true } } : event)
    return events && { id, snapshotEvents: () => events }
  }
  const initializationError = new Error('injected knowledge open failure')
  let assistedClosed = false
  await assert.rejects(openSoulKnowledge({ async open(definition) {
    if (definition.name === 'prompt_tool_soul_knowledge') throw initializationError
    const opened = await root.storageDomain.open(definition)
    return { table: name => opened.table(name), async close() { await opened.close(); assistedClosed = true; throw new Error('injected cleanup failure') } }
  } }, loadKnowledgeSession), error => error === initializationError)
  assert.equal(assistedClosed, true, '知识域初始化失败须释放已打开的真实辅助预算域')
  let owner = await openSoulKnowledge(facility, loadKnowledgeSession)
  const { openSessionVariables } = await import('../../src/host/session-variables.ts')
  const variables = await openSessionVariables(root.storageDomain)
  t.after(() => variables.dispose())
  t.after(async () => { await root.subagents.drainDescendants([agent]); for (const handle of handles) await handle.dispose(); await owner.dispose(); await root.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  const host = { root: join(home, 'modules'), target: () => ({ id: 'alice', dir }) }
  const excluded = new Set()
  installSoulRuntime(root, host, id => root.agents.get(id) && !excluded.has(id) ? ['alice'] : [], () => variables, () => owner)
  registerSoulLedgerTools(root, host, () => owner)
  registerSoulStateTools(root, host, undefined, () => variables, () => owner)
  registerModuleFileTools(root, host, () => owner)
  await root.plugin({ name: 'command-cas-test', inject: ['commands'], apply: scope => {
    registerTuiCommand(scope, 'test', () => ({}), () => ({}), async () => ({}), id => id === 'alice' ? dir : '', undefined, undefined, () => owner)
  } })
  await new Promise(resolve => setImmediate(resolve))
  const signal = new AbortController().signal
  const previewRequest = { moduleId: 'alice', action: 'preview', write: ['general', 'projects'] }
  const preview = owner.preview(dir, previewRequest)
  await owner.confirm(dir, { ...previewRequest, action: 'confirm', expectedRevision: preview.revision }, signal)
  const manage = async action => owner.manage(dir, { moduleId: 'alice', ...action, expectedRevision: owner.status(dir).binding.revision }, agent.session.id, signal)
  await manage({ action: 'project', projectDirectory: home })
  const send = async message => { agent.send(message, 'next-turn', true); await agent.whenIdle(); await owner.observe(dir, agent.session.id) }
  await send(createUserMessage({ content: [{ type: 'text', text: 'OLD HISTORY' }], source: { kind: 'user' } }))
  await manage({ action: 'enable' })
  await owner.observe(dir, agent.session.id)
  // Commands.execute appends command lifecycle events; the runtime observes them
  // before the command handler reaches the knowledge CAS queue.
  const commandAgentHandle = await root.agents.create({ sessionId: 'command-cas', agentOptions: { provider: 'fixture', model: 'normal' }, meta: { cwd: home } })
  handles.push(commandAgentHandle)
  const commandAgent = commandAgentHandle.agent
  const command = async (request, target = commandAgent) => (await root.commands.execute(target, '/prompt-tool knowledge ' + JSON.stringify({ moduleId: 'alice', ...request }), [], signal)).result
  const commandStatus = await command({ action: 'status' }, agent)
  assert.equal(commandStatus.kind, 'success', JSON.stringify(commandStatus))
  const commandRevision = JSON.parse(commandStatus.text).binding.revision
  assert.equal(owner.status(dir).binding.participants.some(row => row.sessionId === commandAgent.session.id), false)
  let observedCommand, releaseCommand
  const commandObserved = new Promise(resolve => { observedCommand = resolve })
  const commandReleased = new Promise(resolve => { releaseCommand = resolve })
  commandObservation = async () => { observedCommand(); await commandReleased }
  let commandSettled = false
  const pendingCommand = command({ action: 'project', projectDirectory: home, expectedRevision: commandRevision }).finally(() => { commandSettled = true })
  let commandStart
  try {
    await Promise.race([commandObserved, pendingCommand.then(() => assert.fail('命令未经过开启后的observe'))])
    commandStart = commandAgent.session.snapshotEvents().find(event => event.type === 'command/run')
    assert.ok(commandStart, '持续记忆开启后的真实command/run必须进入observe的会话读取')
    assert.equal(commandSettled, false, '管理命令必须等待前面的观察队列')
  } finally { commandObservation = undefined; releaseCommand() }
  const commandProject = await pendingCommand
  assert.equal(commandProject.kind, 'success', JSON.stringify(commandProject))
  assert.ok(owner.status(dir).binding.participants.find(row => row.sessionId === commandAgent.session.id).cursor >= commandStart.seq, '新会话观察必须实际持久化')
  assert.equal((await command({ action: 'enable', expectedRevision: commandRevision })).kind, 'error', '真实命令生命周期后的旧控制版本必须拒绝')
  const commandEnabled = await command({ action: 'enable', expectedRevision: owner.status(dir).binding.revision })
  assert.equal(commandEnabled.kind, 'success', JSON.stringify(commandEnabled))
  const message = createUserMessage({ content: [{ type: 'text', text: 'keep this project decision' }], source: { kind: 'user' } })
  await send(message)
  const { createModuleRetrievalProvider } = await import('../../src/runtime/module-retrieval-tools.ts')
  const retrieval = createModuleRetrievalProvider(host, loadKnowledgeSession, () => owner)
  t.after(retrieval.mount(agent.ctx, { paths: [], sessions: [] }, { agent, sourceModuleId: 'alice', sourceModuleDir: dir }))
  const search = async query => {
    const callId = 'recall-' + query
    agent.session.append('tool/call', { callId, name: 'module_search', arguments: JSON.stringify({ moduleId: 'alice', query }) })
    const result = (await root.tools.execute({ agent, signal, calls: [{ type: 'tool-call', id: 'recall-' + query, name: 'module_search', arguments: JSON.stringify({ moduleId: 'alice', query }) }] })).results[0].result
    assert.equal(result.isError, false, JSON.stringify(result))
    agent.session.append('tool/result', { message: createToolResultMessage({ callId, content: [{ type: 'text', text: JSON.stringify(result.value) }], isError: false }) }, { surfaceOp: 'append' })
    await owner.observe(dir, agent.session.id)
    return result.value
  }
  const privateAssistant = agent.session.append('assistant/message', { message: createAssistantMessage({ source: { provider: 'fixture', model: 'normal' }, content: [{ type: 'reasoning', text: 'PRIVATE REASONING MARKER' }, { type: 'text', text: 'PUBLIC ASSISTANT MARKER' }] }), stream: [{ text: 'PRIVATE STREAM MARKER' }] }, { surfaceOp: 'append' })
  const injected = agent.session.append('user/message', { id: 'injected-context', role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'DERIVED CONTEXT MARKER' }] }, { surfaceOp: 'append' })
  agent.session.append('tool/call', { callId: 'external-fact', name: 'fixture_external', arguments: '{}' })
  const external = agent.session.append('tool/result', { message: createToolResultMessage({ callId: 'external-fact', content: [{ type: 'text', text: 'EXTERNAL OBSERVATION MARKER' }], isError: false }) }, { surfaceOp: 'append' })
  agent.session.append('tool/call', { callId: 'derived-state', name: 'soul_state', arguments: JSON.stringify({ action: 'learn' }) })
  const derivedState = agent.session.append('tool/result', { message: createToolResultMessage({ callId: 'derived-state', content: [{ type: 'text', text: 'DERIVED LEARNING MARKER' }], isError: false }) }, { surfaceOp: 'append' })
  await owner.observe(dir, agent.session.id)
  assert.deepEqual((await search('PUBLIC ASSISTANT MARKER')).hits, [], '本回合助手输出不能被同回合搜索自召回')
  const dirty = owner.status(dir).binding
  const { revisionOf } = await import('../../src/host/module-write.ts')
  dirty.histories.push({ id: 'legacy-derived-context', sessionId: agent.session.id, seqs: [injected.seq], versions: [revisionOf(JSON.stringify(injected))], scope: dirty.projects.find(row => row.sessionId === agent.session.id).identity, revoked: false, automatic: true })
  dirty.histories.push({ id: 'legacy-derived-state', sessionId: agent.session.id, seqs: [derivedState.seq], versions: [revisionOf(JSON.stringify(derivedState))], scope: dirty.projects.find(row => row.sessionId === agent.session.id).identity, revoked: false, automatic: true })
  await bindingsTable.put(bindingId, dirty)
  await send(createUserMessage({ content: [{ type: 'text', text: 'next retrieval turn' }], source: { kind: 'user' } }))
  const publicHits = (await search('PUBLIC ASSISTANT MARKER')).hits
  assert.equal(publicHits.length, 1, '既有助手正常公开正文继续可回取')
  assert.equal(publicHits[0].reference.seqs[0], privateAssistant.seq)
  assert.doesNotMatch(publicHits[0].content, /PRIVATE REASONING|PRIVATE STREAM|tool-call/)
  assert.deepEqual((await search('DERIVED CONTEXT MARKER')).hits, [], '旧automatic注入污染记录读时也排除')
  assert.deepEqual((await search('PRIVATE REASONING MARKER')).hits, [])
  assert.deepEqual((await search('PRIVATE STREAM MARKER')).hits, [])
  assert.deepEqual((await search('DERIVED LEARNING MARKER')).hits, [])
  const externalHits = (await search('EXTERNAL OBSERVATION MARKER')).hits
  assert.deepEqual(externalHits.map(hit => hit.reference.seqs[0]), [external.seq], '真实工具执行观察保留且不接纳伪作者')
  assert.match(externalHits[0].content, /fixture_external/)
  assert.deepEqual((await search('next retrieval turn')).hits.map(hit => hit.reference.seqs[0]), [agent.session.snapshotEvents().findLast(event => event.type === 'user/message' && event.data.source?.kind === 'user').seq], '搜索回执不回灌为下一次搜索证据')
  const open = async reference => (await root.tools.execute({ agent, signal, calls: [{ type: 'tool-call', id: 'open-public', name: 'module_open', arguments: JSON.stringify({ moduleId: 'alice', reference }) }] })).results[0].result
  const opened = await open(publicHits[0].reference)
  assert.equal(opened.isError, false, JSON.stringify(opened))
  assert.equal(opened.value.content, publicHits[0].content, '新引用回取与搜索使用相同公开投影')
  const { makeSessionReference } = await import('../../engine/retrieval-reference.mjs')
  const legacy = makeSessionReference('alice', agent.session.id, agent.session.snapshotEvents(), [privateAssistant.seq])
  const legacyOpened = await open(legacy)
  assert.equal(legacyOpened.isError, false, '既有显式原事件引用保持版本和偏移协议')
  assert.equal(legacyOpened.value.content, JSON.stringify(privateAssistant))
  const timelineResult = (await root.tools.execute({ agent, signal, calls: [{ type: 'tool-call', id: 'timeline-public', name: 'module_search', arguments: JSON.stringify({ moduleId: 'alice', mode: 'timeline', query: 'PUBLIC ASSISTANT MARKER' }) }] })).results[0].result
  assert.equal(timelineResult.isError, false, JSON.stringify(timelineResult))
  assert.deepEqual(timelineResult.value.hits.map(hit => hit.content), [publicHits[0].content])
  const attachmentInput = createUserMessage({ content: [], source: { kind: 'user' } })
  agent.session.append('user/message', attachmentInput, { surfaceOp: 'append' })
  await owner.observe(dir, agent.session.id)
  assert.equal(owner.status(dir).binding.participants.find(row => row.sessionId === agent.session.id).rootMessageId, attachmentInput.id, '无text真实输入仍推进用户根身份')
  await send(message)
  const fresh = await root.agents.create({ sessionId: 'record-new-main', agentOptions: { provider: 'fixture', model: 'normal' }, meta: { cwd: home } })
  handles.push(fresh)
  fresh.agent.send(createUserMessage({ content: [{ type: 'text', text: 'new same-project material' }], source: { kind: 'user' } }), 'next-turn', true)
  await fresh.agent.whenIdle()
  await owner.observe(dir, fresh.agent.session.id)
  assert.equal(owner.status(dir).binding.participants.find(row => row.sessionId === fresh.agent.session.id).scope, owner.status(dir).binding.projects.find(row => row.sessionId === agent.session.id).identity, '新主会话只复用已声明且真实身份相同的项目')
  const call = async (id = 'stable-operation') => (await root.tools.execute({ agent, signal, calls: [{ type: 'tool-call', id, name: 'soul_ledger', arguments: JSON.stringify({ moduleId: 'alice', action: 'append', type: 'fact', text: 'project decision' }) }] })).results[0].result
  const first = await call()
  assert.equal(first.isError, false, JSON.stringify(first))
  assert.equal(first.value.persisted, true)
  assert.equal(first.value.reference.rootMessageId, message.id)
  const learned = await owner.learn(dir, agent.session.id, { text: 'Keep answers concise', layer: 'core', ref: first.value.reference.entryId, expectedRevision: owner.status(dir).learningRevision }, signal)
  assert.equal(learned.state, 'candidate', '模型不能确认核心变化')
  assert.equal((await owner.withEvidence([{ directory: dir, sessionId: fresh.agent.session.id }], undefined, () => owner.learning(dir, fresh.agent.session.id))).length, 0)
  await manage({ action: 'learning-confirm', sourceId: learned.id })
  assert.equal((await owner.withEvidence([{ directory: dir, sessionId: fresh.agent.session.id }], undefined, () => owner.learning(dir, fresh.agent.session.id)))[0].text, 'Keep answers concise')
  const learningRuntime = createRuleRuntime(fresh.agent.ctx, { agent: fresh.agent, warnOnce: message => { throw new Error(message) } })
  t.after(() => learningRuntime.dispose())
  learningRuntime.replace([{ moduleId: 'alice', rules: compileRules([{ id: 'self', then: [{ id: 'self', kind: 'inject-text', config: { layer: 'runtime-context', strategy: 'placeholder', fill: 'soul-self' } }, { id: 'persona', kind: 'persona', prefix: 'USER BASE' }] }], { moduleId: 'alice' }) }])
  const self = async () => {
    const context = { agent: fresh.agent, scope: scopeOf(fresh.agent.ctx), signal }
    const toolSet = await fresh.agent.ctx.tools.resolve(context)
    try { return JSON.stringify(await fresh.agent.ctx.systemPrompt.assemble({ ...context, toolSet })) }
    finally { toolSet.dispose() }
  }
  assert.match(await self(), /Keep answers concise/)
  const recordsBeforeDisable = (await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.records(dir, agent.session.id)))
  await manage({ action: 'disable' })
  assert.deepEqual((await owner.withEvidence([{ directory: dir, sessionId: fresh.agent.session.id }], undefined, () => owner.learning(dir, fresh.agent.session.id))), [])
  assert.doesNotMatch(await self(), /Keep answers concise/, '关闭同时撤回SELF和persona共享的学习贡献')
  assert.equal((await owner.withEvidence([{ directory: dir, sessionId: fresh.agent.session.id }], undefined, () => owner.learning(dir, fresh.agent.session.id, true))).find(row => row.id === learned.id).text, 'Keep answers concise')
  assert.deepEqual((await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.records(dir, agent.session.id))), recordsBeforeDisable, '关闭保留正式原文及历史查询')
  await manage({ action: 'enable' })
  assert.match(await self(), /Keep answers concise/, '重新启用恢复仍有效来源的学习')
  await manage({ action: 'learning-withdraw', sourceId: learned.id })
  assert.doesNotMatch(await self(), /Keep answers concise/)
  assert.equal(first.value.derived.state, 'pending')
  const id = first.value.reference.entryId
  await send(message)
  assert.equal((await call()).isError, false)
  assert.equal(readSoulLedgerProjection(dir).total, 1)
  assert.equal((await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.records(dir, agent.session.id)))[0].entryId, id)
  assert.equal((await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.sources(dir, agent.session.id))).histories.some(row => row.sessionId === agent.session.id && row.seqs.includes(agent.session.snapshotEvents().find(event => event.type === 'user/message').seq)), false)
  await send(createUserMessage({ content: [{ type: 'text', text: 'AUTOMATIC FOLLOWUP' }], source: { kind: 'agent-message' } }))
  assert.equal(owner.status(dir).binding.participants.findLast(row => row.sessionId === agent.session.id).rootMessageId, message.id)
  failDerived = true
  const partial = await call('partial-operation')
  assert.equal(partial.value.persisted, true)
  assert.equal(partial.value.derived.state, 'failed')
  assert.deepEqual((await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.recording(dir, agent.session.id))), { persisted: 2, pending: 1, derivedFailed: 1 })
  await owner.dispose()
  const beforeReopenLoads = evidenceLoads
  owner = await openSoulKnowledge(facility, loadKnowledgeSession)
  assert.equal(evidenceLoads, beforeReopenLoads, '冷启动只按账本元数据恢复，不加载历史正文')
  assert.throws(() => owner.records(dir, agent.session.id), /未准备/, '同步冷读明确不可用')
  const persistedBeforeCancel = owner.status(dir).binding.records
  let releaseEvidence, evidenceStarted
  const evidenceHeld = new Promise(resolve => { releaseEvidence = resolve })
  const evidenceLoading = new Promise(resolve => { evidenceStarted = resolve })
  evidenceObservation = async () => { evidenceStarted(); await evidenceHeld }
  const cancelledEvidence = new AbortController()
  let lateConsumer = false
  const cancelledPreparation = owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], cancelledEvidence.signal, () => { lateConsumer = true })
  await evidenceLoading
  cancelledEvidence.abort(new Error('fixture evidence cancelled'))
  await assert.rejects(cancelledPreparation, /fixture evidence cancelled/)
  evidenceObservation = undefined; releaseEvidence()
  assert.equal(lateConsumer, false, '取消无需等待不可中断历史读取，迟到不进入消费')
  assert.deepEqual(owner.status(dir).binding.records, persistedBeforeCancel, '取消不能删除记录或清理pending')
  evidenceObservation = async () => { throw new Error('fixture unavailable history') }
  await assert.rejects(owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], signal, () => owner.records(dir, agent.session.id)), /fixture unavailable history/)
  evidenceObservation = undefined
  assert.deepEqual(owner.status(dir).binding.records, persistedBeforeCancel, '装载失败保留合法登记与pending')
  await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], signal, async () => {
    let releaseShared, startedShared
    const held = new Promise(resolve => { releaseShared = resolve })
    const started = new Promise(resolve => { startedShared = resolve })
    let loads = 0
    evidenceObservation = async () => { loads++; startedShared(); await held }
    const cancel = new AbortController()
    const first = owner.readEvidence(agent.session.id, cancel.signal)
    const second = owner.readEvidence(agent.session.id)
    await started
    cancel.abort(new Error('one consumer cancelled'))
    await assert.rejects(first, /one consumer cancelled/)
    releaseShared()
    assert.equal((await second).id, agent.session.id)
    assert.equal(loads, 1, '共享历史装载，单消费者取消不影响另一个消费者')
    evidenceObservation = undefined
  })
  let firstReady, secondReady
  const firstEntered = new Promise(resolve => { firstReady = resolve })
  const secondEntered = new Promise(resolve => { secondReady = resolve })
  await Promise.all([
    owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], signal, async () => {
      firstReady(); await secondEntered
      assert.equal(owner.records(dir, agent.session.id).length, 2)
      const nestedCancel = new AbortController()
      let enteredNested, releaseNested, checkedNested
      const nestedEntered = new Promise(resolve => { enteredNested = resolve })
      const nestedGate = new Promise(resolve => { releaseNested = resolve })
      const nestedChecked = new Promise(resolve => { checkedNested = resolve })
      const nested = owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], nestedCancel.signal, async () => {
        enteredNested(); await nestedGate
        const outcomes = await Promise.allSettled([
          Promise.resolve().then(() => owner.records(dir, agent.session.id)),
          owner.readEvidence(agent.session.id),
        ])
        checkedNested(outcomes.map(result => result.status))
      })
      await nestedEntered
      nestedCancel.abort(new Error('nested cancelled'))
      await assert.rejects(nested, /nested cancelled/)
      const loadsBeforeLate = evidenceLoads
      releaseNested()
      assert.deepEqual(await nestedChecked, ['rejected', 'rejected'], '子操作取消后迟到投影与原文读取均拒绝')
      assert.equal(evidenceLoads, loadsBeforeLate)
      assert.equal(owner.records(dir, agent.session.id).length, 2, '子取消不撤销父消费资格')
      assert.throws(() => owner.sources(dir, fresh.agent.session.id), /未准备/, '并发会话不串用证据scope')
      await assert.rejects(owner.withEvidence([{ directory: dir, sessionId: fresh.agent.session.id }], signal, () => {}), /额外材料/, '嵌套不扩张固定集合')
    }),
    owner.withEvidence([{ directory: dir, sessionId: fresh.agent.session.id }], signal, async () => {
      secondReady(); await firstEntered
      assert.equal(owner.learning(dir, fresh.agent.session.id, true)[0].state, 'withdrawn', '冷重读不恢复已撤回学习')
      assert.throws(() => owner.records(dir, agent.session.id), /未准备/)
    }),
  ])
  const retiringOwner = owner
  let releaseRetired, retiredReady, retiredChecked
  const retirementGate = new Promise(resolve => { releaseRetired = resolve })
  const retirementReady = new Promise(resolve => { retiredReady = resolve })
  const retirementChecked = new Promise(resolve => { retiredChecked = resolve })
  const retirement = retiringOwner.withEvidence([{ directory: dir, sessionId: agent.session.id }], signal, async () => {
    retiredReady(); await retirementGate
    assert.throws(() => retiringOwner.records(dir, agent.session.id), /释放/)
    retiredChecked()
  })
  await retirementReady
  const retirementRejected = assert.rejects(retirement, /释放/)
  await owner.dispose()
  await retirementRejected
  releaseRetired(); await retirementChecked
  owner = await openSoulKnowledge(facility, loadKnowledgeSession)
  assert.equal((await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.records(dir, agent.session.id))).length, 2, 'seed无需session/event即可恢复对账')
  assert.equal(readSoulLedgerProjection(dir).total, 2)
  const publication = { expectedRevision: owner.status(dir).consolidationRevision, text: 'Authoritative project decision in detail.', refs: (await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.records(dir, agent.session.id))).map(row => row.entryId) }
  const consolidate = async (request, expectError = false) => {
    const result = (await root.tools.execute({ agent, signal, calls: [{ type: 'tool-call', id: 'publish', name: 'soul_state', arguments: JSON.stringify({ moduleId: 'alice', action: 'consolidate', ...request }) }] })).results[0].result
    assert.equal(result.isError, expectError, JSON.stringify(result))
    return expectError ? result : result.value.publication
  }
  const callsBeforePublication = modelCalls
  const statusResult = (await root.tools.execute({ agent, signal, calls: [{ type: 'tool-call', id: 'publication-status', name: 'soul_state', arguments: JSON.stringify({ moduleId: 'alice', action: 'status' }) }] })).results[0].result
  assert.equal(statusResult.isError, false, JSON.stringify(statusResult))
  assert.equal(statusResult.value.assistedConsolidation?.state, 'idle')
  assert.equal(statusResult.value.assistedConsolidation.budget.attempts.length, 0)
  const toolEvent = agent.session.append({ type: 'tool/result', data: { id: 'publication-status', result: statusResult } })
  const unchangedControl = owner.control(dir)
  await owner.observe(dir, agent.session.id, toolEvent.seq)
  assert.doesNotThrow(unchangedControl, 'cursor和无关自动历史不失效控制凭据')
  assert.equal(owner.status(dir).consolidationRevision, statusResult.value.knowledge.consolidationRevision, '工具结果不改变生成前整理依赖版本')
  const oldPublication = { ...publication, refs: [publication.refs[0]], text: 'Previous authoritative decision.' }
  const ledgerBeforeChange = readFileSync(join(dir, 'data', '02-soul.jsonl'), 'utf8')
  learningObservation = async () => writeFileSync(join(dir, 'data', '02-soul.jsonl'), ledgerBeforeChange.replace('project decision', 'replaced decision'))
  try { await consolidate(oldPublication, true) }
  finally { writeFileSync(join(dir, 'data', '02-soul.jsonl'), ledgerBeforeChange) }
  assert.equal((await consolidate(oldPublication)).state, 'published')
  publication.expectedRevision = owner.status(dir).consolidationRevision
  replacedSeq = first.value.reference.seq
  replaceAfterLoads = 2
  await consolidate(publication, true)
  assert.equal((await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.sources(dir, agent.session.id))).documents.length, 0, '最后一次await期间来源变化同时停用既有派生版本')
  replaceEvidence = false
  failPublication = true
  const failedPublication = await consolidate(publication)
  assert.equal(failedPublication.state, 'candidate')
  assert.deepEqual((await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.sources(dir, agent.session.id))).documents.map(row => row.content), [oldPublication.text])
  assert.equal((await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.recording(dir, agent.session.id))).pending, 1)
  assert.equal((await consolidate(publication)).state, 'published')
  assert.equal((await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.sources(dir, agent.session.id))).documents.at(-1).content, publication.text)
  await manage({ action: 'disable' })
  assert.equal((await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.sources(dir, agent.session.id))).documents.length, 0, '关闭撤回自动整理贡献')
  assert.ok((await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.sources(dir, agent.session.id))).histories.length, '关闭保留合法历史查询')
  await manage({ action: 'enable' })
  assert.equal((await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.sources(dir, agent.session.id))).documents.at(-1).content, publication.text)
  assert.equal((await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.recording(dir, agent.session.id))).pending, 0)
  assert.equal((await consolidate(publication)).state, 'published')
  const publishedPath = 'data/' + (await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.sources(dir, agent.session.id))).documents.at(-1).path
  assert.equal(modelCalls, callsBeforePublication, '不可用状态查询和直接整理不额外调用模型')
  const searchLoads = new Map()
  evidenceObservation = async sessionId => {
    const count = (searchLoads.get(sessionId) ?? 0) + 1
    searchLoads.set(sessionId, count)
    if (sessionId !== agent.session.id && count === 2) replaceEvidence = true
  }
  try {
    const changedDuringSearch = (await root.tools.execute({ agent, signal, calls: [{ type: 'tool-call', id: 'changed-publication-search', name: 'module_search', arguments: JSON.stringify({ moduleId: 'alice', query: publication.text }) }] })).results[0].result
    assert.equal(replaceEvidence, true, '读取后一个会话时替换先前派生来源原文')
    assert.equal(changedDuringSearch.isError, true, '检索返回前拒绝原文已变化的派生正文')
  } finally { evidenceObservation = undefined; replaceEvidence = false }
  replaceEvidence = true
  const staleRead = (await root.tools.execute({ agent, signal, calls: [{ type: 'tool-call', id: 'stale-publication-read', name: 'module_file_read', arguments: JSON.stringify({ moduleId: 'alice', path: publishedPath }) }] })).results[0].result
  assert.equal(staleRead.isError, true, '普通文件工具也刷新持久历史，拒绝失效派生正文')
  await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => {})
  assert.equal((await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.sources(dir, agent.session.id))).documents.length, 0, '持久历史重新加载后拒绝旧派生正文')
  replaceEvidence = false
  await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => {})
  const beforeRevoke = owner.status(dir)
  const revokedControl = owner.control(dir)
  assert.equal(beforeRevoke.binding.histories.find(row => row.id === first.value.reference.sourceId).automatic, true)
  await manage({ action: 'revoke', sourceId: first.value.reference.sourceId })
  assert.throws(revokedControl, /版本已变化/, '撤权立即失效已获取的控制凭据')
  assert.notEqual(owner.status(dir).binding.revision, beforeRevoke.binding.revision, '自动历史撤权仍刷新控制版本')
  assert.notEqual(owner.status(dir).learningRevision, beforeRevoke.learningRevision, '撤权使旧学习依赖失效')
  assert.notEqual(owner.status(dir).consolidationRevision, beforeRevoke.consolidationRevision, '撤权使旧整理依赖失效')
  const staleRevoke = await command({ action: 'enable', expectedRevision: beforeRevoke.binding.revision })
  assert.equal(staleRevoke.kind, 'error')
  assert.match(staleRevoke.text, /版本冲突/)
  assert.equal((await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.sources(dir, agent.session.id))).documents.length, 0, '撤权立即停用混合派生正文')
  await send(createUserMessage({ content: [{ type: 'text', text: 'unrelated new decision' }], source: { kind: 'user' } }))
  assert.equal((await call('after-single-revoke')).isError, false)
  assert.equal(readSoulLedgerProjection(dir).total, 3, '单项撤权不阻断无关新材料')
  await send(createUserMessage({ content: [{ type: 'text', text: '长期反馈：使用中文回答' }], source: { kind: 'user' } }))
  const feedback = await call('explicit-feedback')
  const propose = async args => {
    const status = (await root.tools.execute({ agent, signal, calls: [{ type: 'tool-call', id: 'learning-status', name: 'soul_state', arguments: JSON.stringify({ moduleId: 'alice', action: 'status' }) }] })).results[0].result
    assert.equal(status.isError, false, JSON.stringify(status))
    const event = agent.session.append({ type: 'tool/result', data: { id: 'learning-status', result: status } })
    await owner.observe(dir, agent.session.id, event.seq)
    return (await root.tools.execute({ agent, signal, calls: [{ type: 'tool-call', id: 'learn-feedback', name: 'soul_state', arguments: JSON.stringify({ moduleId: 'alice', action: 'learn', expectedRevision: status.value.knowledge.learningRevision, ...args }) }] })).results[0].result
  }
  const adopted = await propose({ text: '长期反馈：使用中文回答', layer: 'expression', basis: 'explicit-long-term', ref: feedback.value.reference.entryId })
  assert.equal(adopted.isError, false, JSON.stringify(adopted))
  assert.equal(adopted.value.learning.state, 'adopted')
  assert.match(await self(), /使用中文回答/)
  const interruptLearning = async (target, ref) => {
    const entered = Promise.withResolvers(), released = Promise.withResolvers()
    const expectedRevision = owner.status(dir).learningRevision
    learningObservation = async () => { entered.resolve(); await released.promise }
    const pending = root.tools.execute({ agent: target, signal, calls: [{ type: 'tool-call', id: 'stale-learning', name: 'soul_state', arguments: JSON.stringify({ moduleId: 'alice', action: 'learn', expectedRevision, text: '迟到学习不得生效', layer: 'expression', basis: 'explicit-long-term', ref }) }] })
    try {
      await Promise.race([entered.promise, pending.then(() => assert.fail('学习必须经过真实来源读取'))])
      const input = createUserMessage({ content: [{ type: 'text', text: '纠正：今后先解释原因，再给操作步骤。' }], source: { kind: 'user' } })
      agent.send(input, 'next-turn', true)
      await agent.whenIdle()
      assert.ok(agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === input.id), '学习读取未结束时真实新输入已可处理')
      assert.equal(owner.status(dir).learningRevision, expectedRevision, '观察排队期间不能只靠学习版本识别新输入')
    } finally { learningObservation = undefined; released.resolve() }
    const result = (await pending).results[0].result
    assert.equal(result.isError, true, '根会话的新真实输入必须阻止迟到学习提交')
    assert.equal((await owner.withEvidence([{ directory: dir, sessionId: target.session.id }], undefined, () => owner.learning(dir, target.session.id, true))).some(row => row.text === '迟到学习不得生效'), false, '迟到候选不能持久化')
    await owner.observe(dir, agent.session.id)
  }
  await interruptLearning(agent, feedback.value.reference.entryId)
  const beforeNewInput = owner.status(dir)
  await send(createUserMessage({ content: [{ type: 'text', text: '今后规划维修时，先核对零件到货日期，再承诺安装时间。这是长期习惯，绝非只限本次。' }], source: { kind: 'user' } }))
  assert.notEqual(owner.status(dir).learningRevision, beforeNewInput.learningRevision, '未登记的新用户输入也使旧学习版本失效')
  assert.notEqual(owner.status(dir).consolidationRevision, beforeNewInput.consolidationRevision, '未登记的新用户输入也使旧整理版本失效')
  await assert.rejects(owner.learn(dir, agent.session.id, { text: 'stale candidate', layer: 'core', ref: feedback.value.reference.entryId, expectedRevision: beforeNewInput.learningRevision }, signal), /版本冲突/)
  await consolidate({ ...publication, expectedRevision: beforeNewInput.consolidationRevision }, true)
  const planning = await call('planning-feedback')
  const judgment = await propose({ text: '承诺维修时间前先核实零件交期', layer: 'judgment', basis: 'explicit-long-term', ref: planning.value.reference.entryId })
  assert.equal(judgment.value.learning.state, 'adopted', '通用长期判断反馈无需逐项确认')
  const inference = { text: '维修承诺结合零件与沟通需求', layer: 'experience', basis: 'inference', ref: planning.value.reference.entryId, refs: [feedback.value.reference.entryId, planning.value.reference.entryId], assessment: { decision: 'adopt', reason: '两次独立反馈支持此项目中的沟通安排', unresolved: false, counterRefs: [] } }
  replacedSeq = planning.value.reference.seq
  replaceAfterLoads = 3
  assert.equal((await propose({ ...inference, text: '在途证据不可采纳' })).isError, true, '最后一次await替换先前证据时拒绝提交')
  replaceEvidence = false
  await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => {})
  const inferred = await propose(inference)
  assert.equal(inferred.isError, false, JSON.stringify(inferred))
  assert.equal(inferred.value.learning.state, 'adopted')
  assert.match(await self(), /维修承诺结合零件与沟通需求/, '新Agent装配采用有效推断')
  const summary = await call('same-source-summary')
  const repeated = await propose({ ...inference, text: '同源不采纳', refs: [planning.value.reference.entryId, summary.value.reference.entryId] })
  assert.equal(repeated.value.learning.state, 'candidate')
  const contradicted = await propose({ ...inference, text: '反证未解不采纳', assessment: { ...inference.assessment, unresolved: true, counterRefs: [feedback.value.reference.entryId] } })
  assert.equal(contradicted.value.learning.state, 'candidate')
  await send(createUserMessage({ content: [{ type: 'text', text: 'I always prefer concise answers, but not this time: explain every detail.' }], source: { kind: 'user' } }))
  const temporary = await call('temporary-exception')
  const exception = await propose({ text: 'Explain every detail', layer: 'expression', basis: 'explicit-long-term', ref: temporary.value.reference.entryId })
  assert.equal(exception.value.learning.state, 'candidate', '当前回合例外不能因出现长期偏好而被采纳')
  const replacement = await propose({ text: 'Use detailed answers', layer: 'expression', ref: feedback.value.reference.entryId, previous: adopted.value.learning.id })
  await manage({ action: 'learning-confirm', sourceId: replacement.value.learning.id })
  assert.match(await self(), /Use detailed answers/)
  const dependent = await propose({ text: 'dependent replacement', layer: 'expression', ref: planning.value.reference.entryId, previous: replacement.value.learning.id })
  await manage({ action: 'learning-confirm', sourceId: dependent.value.learning.id })
  await manage({ action: 'learning-withdraw', sourceId: replacement.value.learning.id })
  assert.match(await self(), /使用中文回答/, '单项撤回恢复有效前项')
  assert.doesNotMatch(await self(), /dependent replacement/, '撤回中间条目同步停用后续依赖')
  assert.match(await self(), /承诺维修时间前先核实零件交期/, '单项撤回保留无关判断学习')
  await manage({ action: 'revoke', sourceId: feedback.value.reference.sourceId })
  assert.doesNotMatch(await self(), /维修承诺结合零件与沟通需求/, '必要根撤权后停用推断')
  assert.doesNotMatch(await self(), /使用中文回答|Use detailed answers/, '撤权下一次装配立即停止使用')
  assert.match(await self(), /承诺维修时间前先核实零件交期/)
  const audit = await manage({ action: 'learning-list' })
  const withdrawnSource = audit.learning.find(row => row.id === adopted.value.learning.id)
  assert.ok(withdrawnSource.inactiveReason, '来源失效后保留审阅元信息')
  assert.doesNotMatch(withdrawnSource.text, /使用中文回答/, '审计不回放撤权正文')
  await send(createUserMessage({ content: [{ type: 'text', text: '保留本轮最小交接' }], source: { kind: 'user' } }))
  const handoffTool = async (id, args) => (await root.tools.execute({ agent, signal, calls: [{ type: 'tool-call', id, name: 'soul_ledger', arguments: JSON.stringify({ moduleId: 'alice', ...args }) }] })).results[0].result
  const shelved = await handoffTool('handoff-open', { action: 'append', type: 'shelved', text: '刷新验证仍待运行' })
  const handoff = await handoffTool('handoff-container', { action: 'append', type: 'container', text: '交接：下一步核对刷新日志' })
  assert.equal(shelved.isError, false, JSON.stringify(shelved))
  assert.equal(handoff.isError, false, JSON.stringify(handoff))
  assert.match(await self(), /刷新验证仍待运行/)
  assert.match(await self(), /交接：下一步核对刷新日志/)
  assert.ok((await self()).includes(shelved.value.reference.entryId), '未结交接保留稳定条目引用')
  mkdirSync(join(home, 'other-project'))
  const otherProject = await root.agents.create({ sessionId: 'other-project', agentOptions: { provider: 'fixture', model: 'normal' }, meta: { cwd: join(home, 'other-project') } })
  handles.push(otherProject)
  assert.equal((await command({ action: 'project', projectDirectory: join(home, 'other-project'), expectedRevision: owner.status(dir).binding.revision }, otherProject.agent)).kind, 'success')
  const otherRules = createRuleRuntime(otherProject.agent.ctx, { agent: otherProject.agent })
  t.after(() => otherRules.dispose())
  otherRules.replace([{ moduleId: 'alice', rules: compileRules([{ id: 'self', then: [{ id: 'self', kind: 'inject-text', config: { layer: 'runtime-context', strategy: 'placeholder', fill: 'soul-self' } }] }], { moduleId: 'alice' }) }])
  const otherContext = { agent: otherProject.agent, scope: scopeOf(otherProject.agent.ctx), signal }
  const otherTools = await otherProject.agent.ctx.tools.resolve(otherContext)
  try { assert.doesNotMatch(JSON.stringify(await otherProject.agent.ctx.systemPrompt.assemble({ ...otherContext, toolSet: otherTools })), /刷新验证仍待运行|交接：下一步核对刷新日志/, '另一项目不能通过SELF读取同根账本交接') }
  finally { otherTools.dispose() }
  const closed = await handoffTool('handoff-close', { action: 'close', targetId: shelved.value.reference.entryId, outcome: 'completed', reason: '验证已经完成' })
  assert.equal(closed.isError, false, JSON.stringify(closed))
  assert.doesNotMatch(await self(), /刷新验证仍待运行/, '已收口事项不能在新会话重新打开')
  await manage({ action: 'disable' })
  assert.doesNotMatch(await self(), /交接：下一步核对刷新日志/, '关闭撤回交接贡献')
  await manage({ action: 'enable' })
  await manage({ action: 'revoke', sourceId: handoff.value.reference.sourceId })
  assert.doesNotMatch(await self(), /交接：下一步核对刷新日志/, '撤权后下一次装配停止交接贡献')
  await send(createUserMessage({ content: [{ type: 'text', text: '排查刷新失败' }], source: { kind: 'user' } }))
  const resolved = await handoffTool('record-result', { action: 'append', type: 'fact', text: '刷新因缓存键冲突失败，已通过隔离缓存键解决' })
  assert.equal(resolved.isError, false, JSON.stringify(resolved))
  const { renderSoulSelf } = await import('../../src/host/soul-self.ts')
  const budgeted = renderSoulSelf(dir, fresh.agent, signal, 12288, undefined, ['- [open] ' + '交接'.repeat(8192)], undefined, false, Array.from({ length: 3 }, () => ({ text: '学'.repeat(2048), protected: false })))
  assert.ok(Buffer.byteLength(budgeted) <= 12288)
  assert.match(budgeted, /未注入学习/)
  assert.match(budgeted, /未注入其余状态/, '学习优先，交接省略说明同样计入总预算')
  const auxiliaryRules = createRuleRuntime(agent.ctx, { agent })
  t.after(() => auxiliaryRules.dispose())
  auxiliaryRules.replace([{ moduleId: 'alice', rules: compileRules([{ id: 'ordinary-stream-actions', then: [
    { id: 'replace', kind: 'stream-output', mode: 'replace', text: 'ordinary replacement' },
    { id: 'retry', kind: 'request-retry', text: 'ordinary retry' },
  ] }]) }])
  const assistTool = async action => (await root.tools.execute({ agent, signal, calls: [{ type: 'tool-call', id: 'assist-' + action, name: 'soul_state', arguments: JSON.stringify({ moduleId: 'alice', action }) }] })).results[0].result
  assert.equal((await assistTool('assist')).isError, false)
  let assisted
  for (let tries = 0; tries < 200; tries++) {
    assisted = (await assistTool('status')).value.assistedConsolidation
    if (!['preparing', 'generating', 'candidate'].includes(assisted.state) && assisted.budget.attempts.every(row => row.state !== 'reserved')) break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(assisted.state, 'published', JSON.stringify(assisted))
  assert.equal(auxiliary.length, 1)
  assert.equal(auxiliary[0].sessionId, agent.session.id)
  assert.equal(auxiliary[0].purpose, 'soul-continuity-organize')
  assert.equal(auxiliary[0].maxTokens, 1024)
  assert.deepEqual(auxiliary[0].tools, [])
  const organized = JSON.parse(auxiliary[0].messages[0].content[0].text)
  const resultMaterial = organized.materials.find(row => row.ref === resolved.value.reference.entryId)
  assert.equal(resultMaterial?.record?.['概要'], '刷新因缓存键冲突失败，已通过隔离缓存键解决', '完整已记录结果必须交给辅助模型，不能只交原请求便标已处理')
  assert.equal(resultMaterial.record.by, agent.session.id)
  assert.match(JSON.stringify(resultMaterial.material), /排查刷新失败/)
  assert.doesNotMatch(JSON.stringify(resultMaterial.material), /缓存键冲突/, '用户原请求与模型记录结果分别保留来源')
  assert.equal((await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.records(dir, agent.session.id))).find(row => row.entryId === resultMaterial.ref).pending, false)
  assert.equal(assisted.budget.attempts[0].tokens, 23, '结算包含缓存读写输入')
  assert.equal(assisted.budget.attempts[0].estimated, false)
  assert.equal((await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.recording(dir, agent.session.id))).pending, 0)
  await assistTool('assist')
  assert.equal(auxiliary.length, 1, '没有新增材料不重复整理')
  assert.equal((await call('same-root-more-material')).isError, false)
  await assistTool('assist')
  for (let tries = 0; tries < 200; tries++) {
    assisted = (await assistTool('status')).value.assistedConsolidation
    if (assisted.state === 'no-work') await assistTool('assist')
    if (assisted.state === 'deferred') break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(assisted.state, 'deferred', JSON.stringify(assisted))
  assert.equal(auxiliary.length, 1, '同根用户回合新增条目也不获得第二次辅助额度')
  const originalCancel = agent.cancel, originalCancelDescriptor = Object.getOwnPropertyDescriptor(agent, 'cancel')
  heldAuxiliary = true
  await send(createUserMessage({ content: [{ type: 'text', text: 'new round for interruption' }], source: { kind: 'user' } }))
  await assistTool('assist')
  for (let tries = 0; tries < 200 && auxiliary.length < 2; tries++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(auxiliary.length, 2)
  const cancelledWrapper = agent.cancel
  assert.notEqual(cancelledWrapper, originalCancel)
  assert.equal(agent.status, 'idle')
  agent.cancel({ kind: 'user' }, { keepInbox: true })
  for (let tries = 0; tries < 200; tries++) {
    assisted = (await assistTool('status')).value.assistedConsolidation
    if (assisted.budget.attempts.at(-1)?.state === 'cancelled') break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(assisted.state, 'cancelled', JSON.stringify(assisted))
  assert.equal(assisted.budget.attempts.at(-1).estimated, true, '取消或缺usage保留预留')
  assert.equal(agent.cancel, originalCancel)
  assert.deepEqual(Object.getOwnPropertyDescriptor(agent, 'cancel'), originalCancelDescriptor)
  assert.ok((await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.recording(dir, agent.session.id))).pending > 0)
  await send(createUserMessage({ content: [{ type: 'text', text: 'new round for input priority' }], source: { kind: 'user' } }))
  await assistTool('assist')
  for (let tries = 0; tries < 200 && auxiliary.length < 3; tries++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(auxiliary.length, 3)
  cancelledWrapper.call(agent, { kind: 'user' }, { keepInbox: true })
  assert.equal(auxiliary[2].signal.aborted, false, '已卸载旧wrapper不取消新请求')
  agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'unrelated automatic context' }], source: { kind: 'runtime-context' } }), { surfaceOp: 'append' })
  await owner.observe(dir, agent.session.id)
  assert.equal(auxiliary[2].signal.aborted, false, '自动索引和cursor推进不取消辅助流')
  agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'new input while auxiliary still held' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  assert.equal(auxiliary[2].signal.aborted, true, '真实根输入立即取消，不等待异步observe')
  await owner.observe(dir, agent.session.id)
  assert.ok(agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.content?.some(block => block.text === 'new input while auxiliary still held')))
  for (let tries = 0; tries < 200; tries++) {
    assisted = (await assistTool('status')).value.assistedConsolidation
    if (assisted.budget.attempts.at(-1)?.state === 'cancelled') break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  heldAuxiliary = false; omitUsage = true
  await assistTool('assist')
  for (let tries = 0; tries < 200; tries++) {
    assisted = (await assistTool('status')).value.assistedConsolidation
    if (assisted.state === 'published' && assisted.budget.attempts.at(-1)?.state === 'published') break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(assisted.state, 'published', JSON.stringify(assisted))
  assert.equal(assisted.budget.attempts.at(-1).estimated, true)
  assert.ok(assisted.budget.attempts.at(-1).tokens >= 1024)
  await owner.dispose()
  owner = await openSoulKnowledge(facility, loadKnowledgeSession)
  assert.equal((await assistTool('status')).value.assistedConsolidation.budget.attempts.length, 4, '恢复不重置根会话预算')
  auxiliaryRules.dispose()
  const parentSourceIds = (await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.sources(dir, agent.session.id))).histories.map(row => row.id)
  const context = { agent, scope: scopeOf(agent.ctx), signal }
  const toolSet = await root.tools.resolve(context)
  t.after(() => toolSet.dispose())
  await root.systemPrompt.assemble({ ...context, toolSet })
  const spawned = (await root.tools.execute({ ...context, toolSet, calls: [{ type: 'tool-call', id: 'delegate', name: 'subagent', arguments: JSON.stringify({ name: 'worker', description: 'record fixture', prompt: 'Task experience; this is not a new human input.' }) }] })).results[0].result
  assert.equal(spawned.isError, false, JSON.stringify(spawned))
  const childId = root.sessionProjections.snapshot(agent.session).values.subagentCatalog.find(entry => entry.name === 'worker').id
  const child = root.agents.get(childId)
  assert.equal(root.subagents.rootOf(child), agent)
  const childResult = (await root.tools.execute({ agent: child, signal, calls: [{ type: 'tool-call', id: 'child-fact', name: 'soul_ledger', arguments: JSON.stringify({ moduleId: 'alice', action: 'append', type: 'fact', text: 'task experience' }) }] })).results[0].result
  assert.equal(childResult.isError, false, JSON.stringify(childResult))
  t.after(retrieval.mount(child.ctx, { paths: [], sessions: [] }, { agent: child, sourceModuleId: 'alice', sourceModuleDir: dir }))
  const delegatedSearch = (await root.tools.execute({ agent: child, signal, calls: [{ type: 'tool-call', id: 'child-recall-input', name: 'module_search', arguments: JSON.stringify({ moduleId: 'alice', query: 'Task experience; this is not a new human input.' }) }] })).results[0].result
  assert.equal(delegatedSearch.isError, false, JSON.stringify(delegatedSearch))
  assert.ok(delegatedSearch.value.hits.some(hit => hit.reference.sessionId === childId), '子任务真实委派输入仍可检索，当前回合过滤仅针对助手和工具输出')
  const childLearning = await owner.learn(dir, childId, { text: 'delegate claims user preference', layer: 'expression', basis: 'explicit-long-term', ref: childResult.value.reference.entryId, expectedRevision: owner.status(dir).learningRevision }, signal)
  assert.equal(childLearning.state, 'candidate', '子任务委派提示不能充当用户长期意见')
  const childConfirmation = await command({ action: 'learning-confirm', sourceId: childLearning.id, expectedRevision: owner.status(dir).binding.revision }, child)
  assert.equal(childConfirmation.kind, 'error')
  assert.match(childConfirmation.text, /子任务不能确认或管理用户学习/, '忽略观察参与者不能绕过真实子任务权限')
  const childParticipation = owner.status(dir).binding.participants.findLast(row => row.sessionId === childId)
  assert.equal(childParticipation.rootSessionId, agent.session.id)
  assert.equal(childResult.value.reference.rootMessageId, owner.status(dir).binding.participants.findLast(row => row.sessionId === agent.session.id).rootMessageId)
  const childAssist = await root.tools.execute({ agent: child, signal, calls: [{ type: 'tool-call', id: 'child-assist', name: 'soul_state', arguments: JSON.stringify({ moduleId: 'alice', action: 'assist' }) }] })
  assert.equal(childAssist.results[0].result.isError, false)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(auxiliary.length, 4, '子代理共享根回合已消费额度，不能委派绕过')
  assert.ok(parentSourceIds.every(id => childParticipation.grants.includes(id)))
  await interruptLearning(child, childResult.value.reference.entryId)
  await send(createUserMessage({ content: [{ type: 'text', text: 'later private parent input' }], source: { kind: 'user' } }))
  const laterSource = (await owner.withEvidence([{ directory: dir, sessionId: agent.session.id }], undefined, () => owner.sources(dir, agent.session.id))).histories.findLast(row => row.sessionId === agent.session.id).id
  assert.equal((await owner.withEvidence([{ directory: dir, sessionId: childId }], undefined, () => owner.sources(dir, childId))).histories.some(row => row.id === laterSource), false)
  await manage({ action: 'disable' })
  assert.equal((await owner.withEvidence([{ directory: dir, sessionId: childId }], undefined, () => owner.sources(dir, childId))).histories.some(row => row.id === laterSource), false, '关闭不能丢失子任务范围上限')
  await manage({ action: 'enable' })
  assert.equal((await owner.withEvidence([{ directory: dir, sessionId: childId }], undefined, () => owner.sources(dir, childId))).histories.some(row => row.id === laterSource), false)
  assert.doesNotMatch(await self(), /维修承诺结合零件与沟通需求|使用中文回答|Use detailed answers/, '重新启用不恢复失效来源的贡献')
  await root.subagents.drainDescendants([agent])
  excluded.add(agent.id)
  const beforeRelease = owner.status(dir).binding.histories.length
  agent.send(createUserMessage({ content: [{ type: 'text', text: 'RELEASED MATERIAL' }], source: { kind: 'user' } }), 'next-turn', true)
  await agent.whenIdle()
  await owner.dispose()
  owner = await openSoulKnowledge(facility, async id => root.sessions.get(id))
  assert.equal(owner.status(dir).binding.histories.length, beforeRelease, '启动只恢复原文登记，不追溯释放期间事件')
  await manage({ action: 'disable' })
  const count = owner.status(dir).binding.histories.length
  await send(createUserMessage({ content: [{ type: 'text', text: 'AFTER DISABLE' }], source: { kind: 'user' } }))
  assert.equal(owner.status(dir).binding.histories.length, count)
  assert.equal((await call()).isError, true)
})

test('rc2具名spawn沿真实Agent血缘执行已接受深度，取消后释放子Agent', { timeout: 10000 }, async t => {
  const root = new Context(), home = mkdtempSync(join(tmpdir(), 'pt36-lineage-'))
  const runtimes = [], handles = [], entered = new Map(), starts = [], ends = []
  t.after(async () => {
    for (const runtime of runtimes) runtime.dispose()
    for (const handle of handles) await handle.dispose()
    await root.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  class HeldModel extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id } }
    async *stream(request) {
      entered.get(request.sessionId)?.resolve()
      yield { type: 'block-start', index: 0, blockType: 'text' }
      await new Promise((_, reject) => {
        if (request.signal.aborted) reject(request.signal.reason)
        else request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
      })
    }
  }
  for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Native, Agents]) await root.plugin(plugin)
  await root.plugin(Persistence, { root: join(home, 'sessions'), compression: 'none' })
  await root.plugin(Loop, { agents: [] })
  root.provide('workingDirectory', { get: session => session.header.cwd ?? home, ensure: async () => home, set: async () => home })
  await root.plugin(Subagents)
  await root.plugin(Spawn, { providerName: 'spawn' })
  const toolOwner = await root.plugin(Tool, { provider: 'spawn' })
  root.llm.registerAdapter(['memory'], new HeldModel())
  root.on('subagent/start', info => {
    starts.push(info)
    entered.set(info.id, Promise.withResolvers())
  })
  root.on('subagent/end', info => { ends.push(info) })
  const parentHandle = await root.agents.create({ sessionId: 'pt36-parent', agentOptions: { provider: 'memory', model: 'held' }, meta: { cwd: home } })
  handles.push(parentHandle)
  const parent = parentHandle.agent
  const rules = depth => [{ moduleId: 'lineage', rules: compileRules([{ id: 'depth', then: [
    { id: 'depth', kind: 'host-control', capability: 'delegation-limits', value: { maxDepth: depth } },
  ] }]) }]
  const parentRuntime = createRuleRuntime(parent.ctx, { agent: parent })
  runtimes.push(parentRuntime)
  parentRuntime.replace(rules(2))
  const prepare = async agent => {
    const context = { agent, scope: scopeOf(agent.ctx), signal: new AbortController().signal }
    const toolSet = await agent.ctx.tools.resolve(context)
    t.after(() => toolSet.dispose())
    await agent.ctx.systemPrompt.assemble({ ...context, toolSet })
    return { ...context, toolSet }
  }
  const call = async (frame, name) => (await frame.agent.ctx.tools.execute({ ...frame, calls: [
    { type: 'tool-call', id: name, name: 'subagent', arguments: JSON.stringify({ name, description: 'lineage fixture', prompt: 'Wait for cancellation' }) },
  ] })).results[0].result
  const accepted = await prepare(parent)
  assert.equal(delegationLimitsStatus(parent, accepted, 'maxDepth').available, true)
  parentRuntime.replace(rules(0))
  const denied = await call(await prepare(parent), 'blocked')
  assert.equal(denied.isError, true)
  assert.match(denied.error.message, /depth 1 exceeds maxDepth 0/)
  assert.equal(starts.length, 0)
  const spawned = await call(accepted, 'reviewer')
  assert.equal(spawned.isError, false, JSON.stringify(spawned))
  assert.deepEqual(spawned.value, { kind: 'activation', name: 'reviewer' })
  const childId = root.sessionProjections.snapshot(parent.session).values.subagentCatalog.find(entry => entry.name === 'reviewer').id
  assert.notEqual(childId, 'reviewer')
  assert.notEqual(childId, parent.session.id)
  const child = root.agents.get(childId)
  assert.ok(child)
  await entered.get(childId).promise
  assert.equal(child.session.header.parentSession, parent.session.id)
  assert.equal(starts[0].parentSessionId, parent.session.id)
  assert.equal(starts[0].id, childId)
  assert.deepEqual(root.subagents.namesOf(child), { self: 'reviewer', parent: 'lead' })
  assert.equal(root.subagents.rootOf(child), parent)
  const childRuntime = createRuleRuntime(child.ctx, { agent: child })
  runtimes.push(childRuntime)
  childRuntime.replace(rules(1))
  const childDenied = await call(await prepare(child), 'nested')
  assert.equal(childDenied.isError, true)
  assert.match(childDenied.error.message, /depth 2 exceeds maxDepth 1/)
  assert.equal(starts.length, 1, 'child cannot borrow parent accepted depth 2')
  await root.subagents.drainDescendants([parent])
  assert.equal(root.agents.get(childId), undefined)
  assert.equal(ends.length, 1)
  assert.equal(ends[0].id, childId)
  assert.equal(ends[0].parentSessionId, parent.session.id)
  assert.equal(ends[0].stopReason, 'aborted')
  assert.equal(child.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'aborted')
  await toolOwner.dispose()
  assert.equal(delegationLimitsStatus(parent, accepted, 'maxDepth').available, false)
})
