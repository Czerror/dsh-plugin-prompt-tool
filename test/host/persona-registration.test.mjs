import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { bindScopeParent, createScope, scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-persona-registration-')
const { readModulePersona, saveModulePersona } = await import('../../src/host/module-definition-edit.ts')
const { installPersonaCapture } = await import('../../src/runtime/persona-registration.ts')
const { createAgentAssembly } = await import('../../src/runtime/agent-assembly.ts')
const require = createRequire(import.meta.url)
const dependencies = createRequire(require.resolve('@deepseek-ai/dsh-agent-preset-registry'))
const { default: Loader } = await import(pathToFileURL(dependencies.resolve('@deepseek-ai/cordis-plugin-loader')).href)
const IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'
// 模块解析替身按官方 Persona 配置契约贡献真实声明。
const OfficialPersona = { name: 'fixture-official-persona', inject: ['systemPrompt'], apply(ctx, config) {
  ctx.systemPrompt.section(Object.freeze({ name: 'deployment:persona-prefix', order: 0, text: config.prefix, complete: config.complete,
    ...config.interpolate === undefined ? {} : { interpolate: config.interpolate } }))
  ctx.systemPrompt.section(Object.freeze({ name: 'deployment:persona-suffix', order: 10200, text: config.suffix ?? '' }))
} }

/** 人设来源模块必须在磁盘上真实存在：模板求值按来源模块读变量快照。 */
function writePersonaModule(id) {
  const dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), `id: ${id}\nmodules: []\nrules: []\n`)
}

async function personaWorld(t, modules, options = {}) {
  const root = new Context()
  const handles = []
  let driver, capture, standing
  for (const module of modules) writePersonaModule(module.moduleId)
  await root.plugin(Loader)
  Object.assign(root.loader.builtins, {
    adapter: new Promise(resolve => setImmediate(() => resolve({ name: 'persona-production', apply: ctx => { capture = installPersonaCapture(ctx) } }))),
    prompt: SystemPrompt, agents: AgentRegistry,
    driver: { name: 'persona-driver', inject: ['agents', 'systemPrompt'], async apply(ctx) {
      driver = ctx
      // 预设行拓扑：官方 persona 行挂在 Agent 的父 scope（standing），Agent 只是它的子。
      if (options.official !== false) {
        standing = createScope(ctx, {})
        await standing.ctx.plugin(OfficialPersona, { prefix: 'OFFICIAL', suffix: 'TAIL', complete: true })
      }
      ctx.effect(() => ctx.agents.setFactory({ async createAgent(_owner, agentOptions) {
        const agent = { id: agentOptions.sessionId, status: 'idle', options: {}, session: { id: agentOptions.sessionId, header: agentOptions.meta ?? {}, snapshotEvents: () => [] } }
        const scope = createScope(ctx, agent)
        agent.ctx = scope.ctx
        if (standing !== undefined) bindScopeParent(scopeOf(agent.ctx), scopeOf(standing.ctx))
        try {
          const commit = await agentOptions.setup?.(agent.ctx, agent)
          agentOptions.signal?.throwIfAborted()
          commit?.commit()
          await root.serial(scopeTarget(agent, scopeOf(agent.ctx)), 'agent/created', { agent, source: 'startup' })
        } catch (error) { await scope.dispose(); throw error }
        const handle = { agent, dispose: () => scope.dispose() }
        handles.push(handle)
        return handle
      } }))
    } },
  })
  await root.loader.root.update([
    { id: 'prompt', name: 'cordis:prompt' },
    { id: 'agents', name: 'cordis:agents' }, { id: 'driver', name: 'cordis:driver' },
  ])
  await root.loader.await()
  const originalImport = root.loader.import.bind(root.loader)
  root.loader.import = (name, ...args) => name === '@deepseek-ai/dsh-persona' ? OfficialPersona : originalImport(name, ...args)
  await root.loader.create({ id: 'adapter', name: 'cordis:adapter' })
  await root.loader.await()
  root.systemPrompt.context({ name: 'fixture:runtime', order: 0, text: 'CONTEXT' })
  const warnings = []
  const runtime = createAgentAssembly(root, {
    moduleRoot,
    enabledModules: () => [],
    personaModules: () => modules,
    personaCapture: capture,
    warn: text => warnings.push(text),
  })
  t.after(async () => { await runtime.dispose(); for (const handle of handles.reverse()) await handle.dispose(); await standing?.dispose(); await root.fiber.dispose() })
  const assembly = agent => agent.ctx.systemPrompt.assemble({ scope: scopeOf(agent.ctx), agent })
  const texts = async agent => (await assembly(agent)).sections.map(section => section.text)
  const contexts = async agent => (await assembly(agent)).contexts
  const create = async (id, meta = {}, setup) => (await driver.agents.create({ sessionId: id, meta, setup })).agent
  return { root, runtime, driver, warnings, texts, contexts, create }
}

test('人设保存保留主子字段继承、空串和 false，CAS 拒绝覆盖更新', () => {
  const dir = join(moduleRoot, 'persona-values')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'module.yml')
  writeFileSync(file, '# user comment\nid: persona-values\nmodules: []\nrules: []\nunknown: keep\n')
  const before = readModulePersona(dir)
  assert.equal(before.persona, null)
  writeFileSync(file, [
    '# user comment', 'id: persona-values', 'modules: []', 'rules: []', 'unknown: keep # unknown comment',
    'persona: # persona comment', '  main: # main comment', '    prefix: OLD # prefix comment',
    '    suffix: REMOVE', '    complete: false # complete comment', '  subagent: # child comment',
    '    suffix: "" # child suffix comment', '    complete: true', '    includeRuntimeContext: false', '',
  ].join('\n'))
  const annotated = readModulePersona(dir)
  const persona = { main: { prefix: '', complete: false }, subagent: { suffix: '', complete: true, includeRuntimeContext: false } }
  const saved = saveModulePersona(moduleRoot, 'persona-values', persona, annotated.revision)
  assert.deepEqual(readModulePersona(dir), saved)
  assert.deepEqual(saved.persona, persona)
  assert.equal(parse(readFileSync(file, 'utf8')).unknown, 'keep')
  for (const comment of ['user comment', 'unknown comment', 'persona comment', 'main comment', 'prefix comment', 'complete comment', 'child comment', 'child suffix comment']) {
    assert.ok(readFileSync(file, 'utf8').includes('# ' + comment), `保存保留 ${comment}`)
  }
  const bytes = readFileSync(file)
  assert.throws(() => saveModulePersona(moduleRoot, 'persona-values', null, before.revision), /版本|更新|冲突/)
  assert.deepEqual(readFileSync(file), bytes)
  const cleared = saveModulePersona(moduleRoot, 'persona-values', null, saved.revision)
  assert.equal(cleared.persona, null)
  assert.equal(parse(readFileSync(file, 'utf8')).configOrder, undefined)
  const recreated = saveModulePersona(moduleRoot, 'persona-values', { main: { suffix: '' } }, cleared.revision)
  assert.deepEqual(recreated.persona, { main: { suffix: '' } }, '删除后可重新建立独立人设字段')
})

test('旧扁平人设和非法新字段明确拒绝且不改盘', () => {
  const dir = join(moduleRoot, 'persona-retired')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'module.yml')
  writeFileSync(file, 'id: persona-retired\nmodules: []\nrules: []\npersona:\n  prefix: legacy\n')
  const before = readFileSync(file)
  assert.throws(() => readModulePersona(dir), /退役|转换/)
  assert.deepEqual(readFileSync(file), before)
  writeFileSync(file, 'id: persona-retired\nmodules: []\nrules: []\n')
  const revision = readModulePersona(dir).revision
  assert.throws(() => saveModulePersona(moduleRoot, 'persona-retired', { main: { complete: 'false' } }, revision), /布尔/)
  assert.equal(readModulePersona(dir).persona, null)
  for (const declaration of [
    'persona:\n  main:\n    prefix: &shared BEFORE # keep\nunknown: *shared\n',
    'persona:\n  main: &shared { prefix: BEFORE }\nunknown: *shared\n',
  ]) {
    writeFileSync(file, 'id: persona-retired\nmodules: []\nrules: []\n' + declaration)
    const aliased = readModulePersona(dir)
    const bytes = readFileSync(file)
    for (const next of [{ main: { ...aliased.persona.main, prefix: 'AFTER' } }, null]) {
      assert.throws(() => saveModulePersona(moduleRoot, 'persona-retired', next, aliased.revision), /YAML.*引用/)
      assert.deepEqual(readFileSync(file), bytes, '共享别名拒绝后完整定义保持原字节')
    }
  }
  writeFileSync(file, 'id: persona-retired\nmodules: []\nrules: []\npersona:\n  main:\n    prefix: &inside BEFORE\n    suffix: *inside\n')
  const internal = readModulePersona(dir)
  const updated = saveModulePersona(moduleRoot, 'persona-retired', { main: { prefix: 'AFTER', suffix: 'BEFORE' } }, internal.revision)
  assert.deepEqual(updated.persona, { main: { prefix: 'AFTER', suffix: 'BEFORE' } }, '人设内别名不强迫未改字段跟随修改')
  assert.equal(saveModulePersona(moduleRoot, 'persona-retired', null, updated.revision).persona, null, '没有外部引用时允许明确删除人设')
})

test('人设装载：装配期按受众注册并遮蔽祖先声明，主子互不影响', async t => {
  const modules = [{ moduleId: 'first', persona: {
    main: { prefix: 'MAIN', complete: false, includeRuntimeContext: false },
    subagent: { prefix: 'CHILD', complete: false },
  } }]
  const { texts, contexts, create, warnings } = await personaWorld(t, modules)
  const main = await create('main')
  // 子代理只写 delegationDepth：真实宿主子代理的 header 形态，受众判据必须与引擎同源。
  const child = await create('child', { delegationDepth: 1 })
  assert.deepEqual(await texts(main), [IDENTITY, 'MAIN', 'TAIL'])
  assert.deepEqual(await texts(child), [IDENTITY, 'CHILD', 'TAIL'], '子代理取 subagent 字段，与主会话隔离')
  assert.deepEqual(await contexts(main), [], '显式 false 抑制动态上下文')
  assert.ok((await contexts(child)).some(context => context.text === 'CONTEXT'), '主会话的抑制不影响子代理')
  assert.deepEqual(warnings, [])
})

test('人设三态：省略继承、空串清空、complete 显式开关', async t => {
  const modules = [{ moduleId: 'first', persona: { main: { complete: false } } }]
  const world = await personaWorld(t, modules)
  const agent = await world.create('three-state')
  assert.deepEqual(await world.texts(agent), [IDENTITY, 'OFFICIAL', 'TAIL'], '只关 complete 时正文继承祖先')
  modules[0].persona.main = { complete: false, prefix: '' }
  await world.runtime.refresh()
  assert.deepEqual(await world.texts(agent), [IDENTITY, '', 'TAIL'], '空串清空前缀')
  modules[0].persona.main = { complete: true, prefix: 'ONLY' }
  await world.runtime.refresh()
  assert.deepEqual(await world.texts(agent), ['ONLY'], 'complete 时成为唯一系统段')
  modules[0].persona.main = { complete: false, prefix: 'BACK' }
  await world.runtime.refresh()
  assert.deepEqual(await world.texts(agent), [IDENTITY, 'BACK', 'TAIL'], '关闭 complete 后其余段恢复')
})

test('同层接管：AgentSetup 窗口内的同名声明被撤换，释放后回落祖先声明', async t => {
  const modules = [{ moduleId: 'first', persona: { subagent: { prefix: 'OURS', complete: false } } }]
  const world = await personaWorld(t, modules)
  const child = await world.create('local-takeover', { delegationDepth: 1 }, ctx => {
    ctx.systemPrompt.section(Object.freeze({ name: 'deployment:persona-prefix', order: 0, text: 'CHILD ORIGINAL' }))
  })
  assert.deepEqual(await world.texts(child), [IDENTITY, 'OURS', 'TAIL'], '插件人设优先于同层已注册的声明')
  await world.runtime.dispose()
  assert.deepEqual(await world.texts(child), ['OFFICIAL'], '释放后回落祖先声明（祖先 prefix 是 complete 段，独占抑制 suffix）')
})

test('预设未挂 persona 行：人设照常生效，不因未观察而失败', async t => {
  const modules = [{ moduleId: 'first', persona: { main: { prefix: 'ALONE', complete: false } } }]
  const world = await personaWorld(t, modules, { official: false })
  const main = await world.create('no-official')
  assert.deepEqual((await world.texts(main)).filter(Boolean), [IDENTITY, 'ALONE'])
  assert.deepEqual(world.warnings, [])
})

test('同层声明的 interpolate 随继承保留：原文不被当作提示词变量重解析', async t => {
  const modules = [{ moduleId: 'first', persona: { subagent: { complete: false } } }]
  const world = await personaWorld(t, modules)
  const child = await world.create('inherit-raw', { delegationDepth: 1 }, ctx => {
    ctx.systemPrompt.section(Object.freeze({ name: 'deployment:persona-prefix', order: 0, text: 'RAW {{missing}}', interpolate: false }))
  })
  const assembly = await child.ctx.systemPrompt.assemble({ scope: scopeOf(child.ctx), agent: child })
  assert.equal(renderPrompt(assembly), `${IDENTITY}\n\nRAW {{missing}}\n\nTAIL`)
})

test('人设候选非法时拒绝刷新并保留上一个有效装配', async t => {
  const modules = [{ moduleId: 'first', persona: { main: { prefix: 'GOOD', complete: false } } }]
  const world = await personaWorld(t, modules)
  const main = await world.create('keep-old')
  assert.deepEqual(await world.texts(main), [IDENTITY, 'GOOD', 'TAIL'])
  modules[0].persona = { main: { prefix: [1, 2] } }
  await assert.rejects(world.runtime.refresh(), /persona|人设/)
  assert.deepEqual(await world.texts(main), [IDENTITY, 'GOOD', 'TAIL'], '非法候选不改动上一个有效装配')
})
