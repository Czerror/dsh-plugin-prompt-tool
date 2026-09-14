// 端到端（真实物化 + 真实引擎副本 + 协调器 + 真实文件系统）：
//   writePreset 生成预设与共享引擎 → 引擎行注册来源给协调器 → 指令文件按会话工作区
//   现场探测并注入正文 → 文件变更后注入新版本 → 内容为空只发失效通知。
// 与单测的区别：这里不注入任何替身，探测、策略、读取、版本、消息身份全部走真实模块。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'

// 隔离 DSH_HOME 必须在 lib 之前生效：writePreset 的模板解析与文件探测都用它。
const home = mkdtempSync(join(tmpdir(), 'pt-e2e-home-'))
/** 工作区必须在 DSH_HOME 之外：否则会被当成用户级 `$DSH_HOME/AGENTS.md`。 */
const workspaceRoot = mkdtempSync(join(tmpdir(), 'pt-e2e-ws-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const { writePreset } = await import('../../lib/index.mjs')
const { installPreStepCoordinator, PRE_STEP_COORDINATOR_SERVICE } = await import('../../src/runtime/pre-step-coordinator.ts')

const policyFile = join(home, '.prompt-tool', 'instructions.yml')
mkdirSync(join(home, '.prompt-tool'), { recursive: true })
writeFileSync(policyFile, 'schemaVersion: 1\nenabled: true\n', 'utf8')

after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
  rmSync(workspaceRoot, { recursive: true, force: true })
})

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

/** 物化一份真实预设（含 .engine 引擎副本），返回预设目录。 */
const materialize = (name, template) => {
  const presetDir = join(home, 'preset')
  writePreset('PROMPT', {
    firstTurnAnchor: false,
    firstTurnText: '',
    firstTurnCustom: false,
    guideText: '',
    guideCustom: false,
    injectPrompt: true,
    modelProvider: '', subagentModelProvider: '', subagentModelName: '',
    modelName: '',
    bootstrapMaxTokens: 0,
    usePtcMode: true,
    presetDir,
    presetOrder: 5,
    presetTemplate: template,
    outputId: name,
    promptConfigs: [],
  })
  return { presetDir, mountDir: join(presetDir, name) }
}

const userMessage = (text = 'claimed') => ({
  id: 'u-claimed',
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

const textsOf = (decision) =>
  (Array.isArray(decision?.messages) ? decision.messages : [])
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .map((block) => block?.text ?? '')
    .filter((text) => text.length > 0)

const instructionMessages = (decision) =>
  (Array.isArray(decision?.messages) ? decision.messages : [])
    .filter((message) => message?.source?.kind === 'instruction-file')

/** 真实装配：协调器挂在 app 上，引擎行从物化目录加载并注册到 agent 的 mount scope。 */
const mountPreset = async (presetDir, mountDir, agent) => {
  const app = new Context()
  const service = installPreStepCoordinator(app, { home, policyFile })
  assert.equal(typeof service.registerPreset, 'function')
  assert.equal(app.get(PRE_STEP_COORDINATOR_SERVICE), service, '协调服务在 app 上可见')
  const scope = createScope(app, agent)
  agent.ctx = scope.ctx
  const engine = await import(pathToFileURL(join(presetDir, '.engine', 'prompt-config-engine.mjs')).href)
  engine.apply(scope.ctx, { configsDir: `../${mountDir.split(/[\\/]/).at(-1)}/prompt-configs` })
  return app
}

/** 会话持久日志可变：可见面（deriveMessages）与事件扫描都读它。 */
const makeAgent = (cwd) => {
  const events = []
  return {
    events,
    session: {
      id: 'e2e-session',
      header: { delegationDepth: 0, cwd },
      snapshotEvents: () => events,
      deriveMessages: () => events.map((event) => event?.data).filter((data) => data?.source !== undefined),
    },
    options: { model: 'pro' },
  }
}

const dispatch = (app, agent) =>
  agentEvents(app, agent).waterfall(
    'agent/pre-step',
    { messages: [userMessage()], turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [userMessage()] }),
  )

test('E2E 物化 preset + 引擎 + 协调器：按会话工作区注入文件正文，文件变更注入新版本', async () => {
  const workspace = join(workspaceRoot, 'workspace')
  mkdirSync(join(workspace, '.git'), { recursive: true })
  writeFileSync(join(workspace, 'AGENTS.md'), 'PROJECT RULES V1\n', 'utf8')
  const { presetDir, mountDir } = materialize('e2e-anchored', 'anchored')

  const agent = makeAgent(workspace)
  const app = await mountPreset(presetDir, mountDir, agent)

  const first = await dispatch(app, agent)
  const injected = instructionMessages(first)
  assert.equal(injected.length, 1, '物化 + 引擎 + 协调器整链只注入一次')
  const projectText = textsOf(first).find((text) => text.includes('PROJECT RULES V1'))
  assert.match(projectText, /^Instructions from: AGENTS\.md\n\nPROJECT RULES V1$/)
  assert.equal(injected[0].source.plugin.includes(sha256(Buffer.from('PROJECT RULES V1\n')).slice(0, 16)), true, '身份含真实字节版本')

  // 文件外部变更：下一次 pre-step 注入新版本（旧版本仍在可见面里）。
  writeFileSync(join(workspace, 'AGENTS.md'), 'PROJECT RULES V2\n', 'utf8')
  agent.events.push({ seq: 1, type: 'user/message', data: injected[0] })
  const second = await dispatch(app, agent)
  const updated = instructionMessages(second)
  assert.equal(updated.length, 1, '内容变化 → 注入一次新版本')
  assert.match(textsOf(second).join('\n'), /PROJECT RULES V2/)
  assert.notEqual(updated[0].source.plugin, injected[0].source.plugin, '新版本身份与旧版本不同')
})

test('E2E 助手删掉文件：曾注入过 → 只发一次失效通知；策略关闭 → 不再注入', async () => {
  const workspace = join(workspaceRoot, 'workspace-2')
  mkdirSync(join(workspace, '.git'), { recursive: true })
  writeFileSync(join(workspace, 'AGENTS.md'), 'TEMP RULES\n', 'utf8')
  const { presetDir, mountDir } = materialize('e2e-anchored-2', 'anchored')
  const agent = makeAgent(workspace)
  const app = await mountPreset(presetDir, mountDir, agent)

  const injected = instructionMessages(await dispatch(app, agent))
  assert.equal(injected.length, 1)
  rmSync(join(workspace, 'AGENTS.md'), { force: true })
  agent.events.push({ seq: 1, type: 'user/message', data: injected[0] })
  const gone = instructionMessages(await dispatch(app, agent))
  assert.equal(gone.length, 1, '已注入过的文件消失 → 一次失效通知')
  assert.match(textsOf({ messages: gone }).join('\n'), /no longer available/)

  writeFileSync(policyFile, 'schemaVersion: 1\nenabled: false\n', 'utf8')
  const off = await dispatch(app, agent)
  assert.deepEqual(instructionMessages(off), [], '策略关闭 → 文件来源整体不参战')
})

test('E2E 负责人冲突：standard 模板仍挂着官方指令行 → 文件正文不注入', async () => {
  const workspace = join(workspaceRoot, 'workspace-3')
  mkdirSync(join(workspace, '.git'), { recursive: true })
  writeFileSync(join(workspace, 'AGENTS.md'), 'CONFLICT RULES\n', 'utf8')
  writeFileSync(policyFile, 'schemaVersion: 1\nenabled: true\n', 'utf8')
  const { presetDir, mountDir } = materialize('e2e-standard', 'standard')
  const agent = makeAgent(workspace)
  const app = await mountPreset(presetDir, mountDir, agent)

  const decision = await dispatch(app, agent)
  assert.deepEqual(instructionMessages(decision), [], '官方指令行仍在 → 独立来源不注入')
})
