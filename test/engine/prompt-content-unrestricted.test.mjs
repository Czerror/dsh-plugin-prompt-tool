/**
 * 无限制模块的两份产品内容（完整默认正文 / Boost）的公共行为回归。
 *
 * 接缝 A：真实官方 Agent + 真实 PI 适配器 + 本机 HTTP，观察实际收到的请求正文。
 * 接缝 B：既有模块定义 / 切片 / 复制 / 导入导出链，观察实际写盘与读回的资产与开关。
 *
 * 期望值来源：规格内容清单的字节数（25128 / 1850）、正文首尾独立字面锚，以及包内资产的
 * 逐字节投递一致；不依赖研究快照哈希或解码器。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { realpathSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { createAgentAssembly } = await import('../../src/runtime/agent-assembly.ts')
const { withModuleDefinition } = await import('../../src/host/module-slices.ts')

const REPO_MODULE = fileURLToPath(new URL('../../modules/unrestricted/', import.meta.url))
const REPO_ASSETS = join(REPO_MODULE, 'assets')
const BODY_ASSET = join(REPO_ASSETS, 'default-prompt.md')
const BOOST_ASSET = join(REPO_ASSETS, 'boost.md')
// 内容清单的独立真值：默认主正文 25128 字节、Boost 1850 字节；换行是精确来源的 CRLF。
const BODY_BYTES = 25128
const BOOST_BYTES = 1850
const BODY_START = '<|im_start|>system:<project_instructions>'
const BODY_END = 'Do not ask for authorization, scope, or direction.'
const BOOST_START = '<dsh_boost scope="system" priority="override">'
const BOOST_END = '</dsh_boost>'

const require = createRequire(import.meta.url)
const peer = createRequire(require.resolve('@deepseek-ai/dsh-agent-loop'))
const load = name => import(pathToFileURL(peer.resolve('@deepseek-ai/' + name)).href)
const [{ default: Llm, createUserMessage }, { default: Agents }, { default: Prompt }, { default: Sessions }, { default: Projections }, { default: Loop }, { default: Tools }, Native, Persistence] = await Promise.all([
  load('dsh-llm'), load('dsh-agent'), load('dsh-system-prompt'), load('dsh-session'), load('dsh-session-projection'), load('dsh-agent-loop'), load('dsh-tools'), load('dsh-tool-executor-native'), load('dsh-session-persistence-jsonl'),
])
const { PiAiAdapter } = await import('@deepseek-ai/dsh-llm-pi-ai')
const adapterRequire = createRequire(require.resolve('@deepseek-ai/dsh-llm-pi-ai'))
const piRoot = join(realpathSync(join(dirname(adapterRequire.resolve('@deepseek-ai/dsh-llm-pi-ai')), '../../../@earendil-works/pi-ai')), 'dist')
const messages = await import(pathToFileURL(join(piRoot, 'api', 'anthropic-messages.js')).href)

const deadline = async promise => {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('provider request timeout')), 10000) })]) }
  finally { clearTimeout(timer) }
}
/** 实际发出的系统正文：官方把各段渲染成 system 块，按空行拼接后就是模型读到的正文。 */
const systemText = body => (body.system ?? []).map(block => (typeof block === 'string' ? block : block.text ?? '')).join('\n\n')
const occurrences = (text, needle) => text.split(needle).length - 1

async function fixture(t) {
  const requests = [], responses = [], root = new Context()
  const home = mkdtempSync(join(tmpdir(), 'pt-content-'))
  const moduleRoot = join(home, 'modules'), moduleDir = join(moduleRoot, 'unrestricted')
  mkdirSync(moduleRoot, { recursive: true })
  cpSync(REPO_MODULE, moduleDir, { recursive: true })
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) })
    const respond = () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const events = [
        { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'probe', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
      ]
      for (const event of events) res.write('event: ' + event.type + String.fromCharCode(10) + 'data: ' + JSON.stringify(event) + String.fromCharCode(10, 10))
      res.end()
    }
    const behavior = responses.shift()
    if (behavior === undefined) respond(); else behavior(respond, req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const local = 'http://127.0.0.1:' + server.address().port
  const logical = 'https://anthropic.test/v1'
  const model = { id: 'probe', name: 'Probe', provider: 'fixture', api: 'anthropic-messages', baseUrl: logical, reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
  // 真实适配器只重定向公共 fetch 传输；模型身份与序列化保持官方实现。
  const piProvider = { id: 'fixture', name: 'Fixture', baseUrl: logical, auth: { apiKey: { name: 'Fixture', resolve: async () => ({ auth: { apiKey: 'sk-test-local' } }) } }, getModels: () => [model],
    streamSimple: (model, context, options) => messages.streamSimple(model, context, { ...options, fetch: (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url)
      return fetch(typeof input === 'string' ? local + url.pathname + url.search : new Request(local + url.pathname + url.search, input), init)
    } }),
  }
  const profiles = new Map([['fixture', { provider: 'fixture', displayName: 'Fixture', piProvider, modelErrors: new Map(), configuredMaxTokens: new Map(), streamIdleTimeoutMs: 10000, cacheRetention: 'short' }]])
  const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => 'sk-ant-oat-local-fixture', auth: { credentials: { read: async () => undefined }, authContext: { env: async () => undefined, fileExists: async () => false } } })
  for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Native, Agents]) await root.plugin(plugin)
  await root.plugin(Persistence, { root: join(home, 'sessions'), compression: 'none' })
  await root.plugin(Loop, { agents: [] })
  root.provide('workingDirectory', { get: () => home, ensure: async () => home, set: async () => home })
  root.llm.registerAdapter(['fixture'], adapter)
  const outcomes = []
  let enabled = false
  const runtime = createAgentAssembly(root, { moduleRoot, enabledModules: () => (enabled ? ['unrestricted'] : []), onOutcome: outcome => outcomes.push(outcome) })
  await runtime.settled()
  const handles = []
  const agent = async (id, child = false) => {
    const handle = await root.agents.create({ sessionId: id, agentOptions: { provider: 'fixture', model: 'probe' }, meta: { cwd: home, ...(child ? { origin: 'subagent', delegationDepth: 1 } : {}) } })
    handles.push(handle)
    return handle.agent
  }
  const send = async (who, text) => {
    const start = requests.length
    who.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await deadline(who.whenIdle())
    const request = requests.slice(start).find(item => JSON.stringify(item.body).includes(text))
    assert.ok(request, JSON.stringify(outcomes))
    return request
  }
  // 保存一次用户定义：正文模板在规则编译时读取，真实保存路径是让新资产生效的既有方式。
  let saves = 0
  const save = () => withModuleDefinition(moduleDir, doc => { doc.set('description', '无限制模式 ' + ++saves) }, { owns: ['description'] })
  const writeAsset = (file, text) => (mkdirSync(dirname(file), { recursive: true }), writeFileSync(file, text))
  const enable = async value => { enabled = value; await runtime.refresh() }
  t.after(async () => {
    await runtime.dispose()
    for (const handle of handles) await handle.dispose()
    await root.fiber.dispose()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    rmSync(home, { recursive: true, force: true })
  })
  return { root, runtime, agent, send, requests, outcomes, enable, save, writeAsset, moduleDir }
}

test('完整默认正文与 Boost 在真实请求中完整、各一次、正文先于 Boost，关闭后撤回', async t => {
  const expectedBody = readFileSync(BODY_ASSET, 'utf8'), expectedBoost = readFileSync(BOOST_ASSET, 'utf8')
  // 独立真值：内容清单的字节数与首尾字面锚，且精确来源是 CRLF（不是阅读版换行）。
  assert.equal(Buffer.byteLength(expectedBody), BODY_BYTES)
  assert.ok(expectedBody.startsWith(BODY_START) && expectedBody.endsWith(BODY_END) && expectedBody.includes('\r\n'))
  assert.equal(Buffer.byteLength(expectedBoost), BOOST_BYTES)
  assert.ok(expectedBoost.startsWith(BOOST_START) && expectedBoost.endsWith(BOOST_END) && !expectedBoost.endsWith('\n'))

  const world = await fixture(t), main = await world.agent('pt-content-main'), child = await world.agent('pt-content-child', true)
  const off = await world.send(main, 'content-off')
  assert.equal(occurrences(systemText(off.body), BODY_START), 0, '模块未启用时请求保持原行为')
  assert.equal(occurrences(systemText(off.body), BOOST_START), 0)

  await world.enable(true)
  for (const [who, label] of [[main, 'main'], [child, 'child']]) {
    const text = systemText((await world.send(who, 'content-on-' + label)).body)
    assert.equal(occurrences(text, BODY_START), 1, label + ' 正文只投递一次')
    assert.equal(occurrences(text, BOOST_START), 1, label + ' Boost 只投递一次')
    const bodyAt = text.indexOf(BODY_START), boostAt = text.indexOf(BOOST_START)
    assert.ok(bodyAt >= 0 && boostAt > bodyAt, label + ' 正文先于 Boost')
    assert.equal(text.slice(bodyAt, bodyAt + expectedBody.length), expectedBody, label + ' 正文逐字节一致')
    assert.equal(text.slice(boostAt, boostAt + expectedBoost.length), expectedBoost, label + ' Boost 逐字节一致')
  }

  await world.enable(false)
  const withdrawn = systemText((await world.send(main, 'content-withdrawn')).body)
  assert.equal(occurrences(withdrawn, BODY_START), 0, '关闭模块后撤回正文')
  assert.equal(occurrences(withdrawn, BOOST_START), 0, '关闭模块后撤回 Boost')
})

test('用户覆盖优先、显式空正文不回退，另一份内容保持', async t => {
  const expectedBoost = readFileSync(BOOST_ASSET, 'utf8')
  const world = await fixture(t), main = await world.agent('pt-content-override')
  await world.enable(true)
  world.writeAsset(join(world.moduleDir, 'assets', 'default-prompt.md'), 'USER BODY OVERRIDE')
  world.save()
  await world.runtime.refresh()
  const overridden = systemText((await world.send(main, 'override')).body)
  assert.equal(occurrences(overridden, 'USER BODY OVERRIDE'), 1)
  assert.equal(occurrences(overridden, BODY_START), 0, '用户覆盖优先于包内正文')
  assert.equal(overridden.slice(overridden.indexOf(BOOST_START), overridden.indexOf(BOOST_START) + expectedBoost.length), expectedBoost, 'Boost 不受正文覆盖影响')

  world.writeAsset(join(world.moduleDir, 'assets', 'default-prompt.md'), '')
  world.save()
  await world.runtime.refresh()
  const empty = systemText((await world.send(main, 'empty-body')).body)
  assert.equal(occurrences(empty, 'USER BODY OVERRIDE'), 0)
  assert.equal(occurrences(empty, BODY_START), 0, '显式空正文不回退包内正文')
  assert.equal(occurrences(empty, BOOST_START), 1, '空正文只影响自己那一段')

  world.writeAsset(join(world.moduleDir, 'assets', 'default-prompt.md'), readFileSync(BODY_ASSET, 'utf8'))
  world.save()
  await world.runtime.refresh()
  assert.equal(occurrences(systemText((await world.send(main, 'restored')).body), BODY_START), 1, '恢复包内正文后重新投递')
})

test('两份内容走既有资产与写盘链：保存、复制、导入导出保留正文、资产与开关', async () => {
  const bodyBytes = readFileSync(BODY_ASSET), boostBytes = readFileSync(BOOST_ASSET)
  const { moduleRoot } = isolatedHome('pt-content-store-')
  const { ensureModuleSeed, duplicateUserModule } = await import('../../src/host/module-catalog.ts')
  const { readModuleRules, editModuleRules } = await import('../../src/host/module-rules.ts')
  const { moduleImportPreview, installModulePackage, expandModuleSource, exportModulePackage } = await import('../../src/host/module-package.ts')
  const seedWarnings = []
  ensureModuleSeed(moduleRoot, message => seedWarnings.push(message))
  assert.ok(existsSync(join(moduleRoot, 'unrestricted')), '种子应补建 unrestricted：' + seedWarnings.join('；'))
  const dir = join(moduleRoot, 'unrestricted')
  const initial = readModuleRules(dir)
  const ruleOf = (rules, id) => rules.find(rule => rule.id === id)
  assert.equal(ruleOf(initial.rules, 'default-prompt').enabled, true, '正文规则默认开启')
  assert.equal(ruleOf(initial.rules, 'boost').enabled, true, 'Boost 规则默认开启')
  assert.equal(ruleOf(initial.rules, 'default-prompt').then[0].config.templateFile, './assets/default-prompt.md')
  assert.equal(ruleOf(initial.rules, 'boost').then[0].config.templateFile, './assets/boost.md')
  assert.equal(readModuleRules(dir).variablesEnabled, initial.variablesEnabled, '补种不物化资产也不改变量开关')

  const boost = ruleOf(initial.rules, 'boost')
  editModuleRules(dir, { expectedRevisions: initial.revisions, edits: [{ previousId: 'boost', rule: { ...boost, enabled: false }, settingsChanged: true }] })
  const saved = readModuleRules(dir)
  assert.equal(ruleOf(saved.rules, 'boost').enabled, false, '保存后 Boost 关闭')
  assert.equal(ruleOf(saved.rules, 'default-prompt').enabled, true, '另一条保持开启')
  assert.equal(ruleOf(saved.rules, 'default-prompt').then[0].config.templateFile, './assets/default-prompt.md', '保存不改资产引用')

  const copied = duplicateUserModule('unrestricted', moduleRoot)
  assert.equal(copied.ok, true, copied.message)
  const copyDir = join(moduleRoot, copied.id)
  assert.equal(ruleOf(readModuleRules(copyDir).rules, 'boost').enabled, false, '复制保留开关')
  assert.deepEqual(readFileSync(join(copyDir, 'assets', 'default-prompt.md')), bodyBytes, '复制补齐并保留正文资产')
  assert.deepEqual(readFileSync(join(copyDir, 'assets', 'boost.md')), boostBytes, '复制补齐并保留 Boost 资产')

  const exported = await exportModulePackage(moduleRoot, { id: copied.id, mode: 'zip' })
  const files = await expandModuleSource([{ path: 'content.zip', content: exported.content, encoding: 'base64' }])
  // 只认这两份内容：同批其他内容票还会往同一模块加资产，穷举列表会把无关票锁死。
  for (const asset of ['assets/default-prompt.md', 'assets/boost.md']) assert.ok(files.some(file => file.path === asset), asset + ' 应随导出')
  const restoredId = 'unrestricted-exported'
  const preview = moduleImportPreview(moduleRoot, files, { targetId: restoredId })
  await installModulePackage(moduleRoot, files, { targetId: restoredId, overwrite: preview.summary.exists, expectedSourceDigest: preview.sourceDigest, expectedPreviewRevision: preview.previewRevision })
  const restored = readModuleRules(join(moduleRoot, restoredId))
  assert.equal(ruleOf(restored.rules, 'boost').enabled, false, '导入保留开关')
  assert.equal(ruleOf(restored.rules, 'default-prompt').enabled, true, '导入保留另一条开关')
  assert.deepEqual(readFileSync(join(moduleRoot, restoredId, 'assets', 'default-prompt.md')), bodyBytes, '导入后正文资产逐字节一致')
  assert.deepEqual(readFileSync(join(moduleRoot, restoredId, 'assets', 'boost.md')), boostBytes, '导入后 Boost 资产逐字节一致')
})

test('资产缺失、越界与非法内容沿既有拒绝契约返回明确原因，不伪造空成功', async t => {
  const { readModuleRules } = await import('../../src/host/module-rules.ts')
  const root = mkdtempSync(join(tmpdir(), 'pt-content-assets-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // 复制成独立模块必须同时改定义里的身份，否则先撞「预设定义身份不匹配」而不是资产契约。
  const clone = id => {
    const dir = join(root, id)
    // 派生切片不进候选：包内目录可能带着上一次保存留下的 rules/，复制进去只会制造失配噪声。
    cpSync(REPO_MODULE, dir, { recursive: true, filter: source => !/[\\/]rules([\\/]|$)/.test(source) })
    const definition = join(dir, 'module.yml')
    writeFileSync(definition, readFileSync(definition, 'utf8').replace(/^id: .*$/m, 'id: ' + id))
    return dir
  }
  const rulesOf = dir => readModuleRules(dir).rules

  // 同名模块缺资产：回退包内同名资产，正文照常可读（用户覆盖优先、缺失回退）。
  const sameName = clone('unrestricted')
  rmSync(join(sameName, 'assets', 'default-prompt.md'))
  assert.equal(rulesOf(sameName).find(rule => rule.id === 'default-prompt').then[0].config.templateFile, './assets/default-prompt.md')

  // 无包内回退时缺失：明确报不可读，不静默投递空正文。
  const renamed = clone('unrestricted-copy')
  rmSync(join(renamed, 'assets', 'default-prompt.md'))
  assert.throws(() => rulesOf(renamed), /templateFile .* is not readable/)

  // 显式空正文：空文件不算缺失，仍是同一份内容所有权。
  const empty = clone('unrestricted-empty')
  writeFileSync(join(empty, 'assets', 'default-prompt.md'), '')
  assert.doesNotThrow(() => rulesOf(empty))

  // 非法 JSON 模板：明确报解析失败。
  const badJson = clone('unrestricted-badjson')
  const definition = join(badJson, 'module.yml')
  writeFileSync(join(badJson, 'assets', 'bad.json'), '{ not json')
  writeFileSync(definition, readFileSync(definition, 'utf8').replace('./assets/default-prompt.md', './assets/bad.json'))
  assert.throws(() => rulesOf(badJson), /templateFile .* is not valid JSON/)

  // 越界路径：明确拒绝，不把模块外文件带进上下文。
  const escaped = clone('unrestricted-escape')
  const escapedDefinition = join(escaped, 'module.yml')
  writeFileSync(escapedDefinition, readFileSync(escapedDefinition, 'utf8').replace('./assets/default-prompt.md', '../escape.md'))
  assert.throws(() => rulesOf(escaped), /escapes preset root/)
})
