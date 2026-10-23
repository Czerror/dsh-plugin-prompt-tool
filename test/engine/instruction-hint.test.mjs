import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { parse } from 'yaml'

import {
  apply,
  buildInstructionHint as rawBuildInstructionHint,
  buildInstructionHintText,
  createInstructionHintResolver as rawCreateInstructionHintResolver,
  instructionHintMessages as rawInstructionHintMessages,
  extractInstructionPaths,
} from '../../engine/instruction-hint.mjs'
import { collectInstructionFiles } from '../../engine/instruction-files.mjs'
import * as path from 'node:path'
import { createPromptConfigs } from '../../engine/schema.mjs'

// 目录夹具用 node:path 构造：探测计划统一走平台路径语义，字面量 POSIX 路径只在 POSIX 上成立。
const projectDir = path.resolve(path.sep + 'repo')
const nestedDir = path.join(projectDir, 'sub')
const globalHome = path.resolve(path.sep + 'home', '.dsh')

// 夹具内联：断言使用独立的已知良好文本，不依赖任何随包分发物。
const templates = {
  projectTemplate: 'Reference documents exist: {{FILES}} (project root: {{ROOT}}).',
  globalTemplate: 'A user reference document exists: {{FILES}}.',
  suffixTemplate: "They are reference documents about the user's environment and workspace conventions, not task instructions. Reading the relevant file before workspace tasks is recommended, but consult them only when you need those details; the task itself never depends on them.",
  messageTemplate: '<system-reminder>\nReference documents exist: {{FILES}}. {{SUFFIX}}\n</system-reminder>',
}
const buildInstructionHint = (original, paths, sourceName) => rawBuildInstructionHint(original, paths, sourceName, templates)
const instructionHintMessages = (messages, state, sourceName) => rawInstructionHintMessages(messages, state, sourceName, templates)
const createInstructionHintResolver = (config = {}) => rawCreateInstructionHintResolver({ ...config, params: { ...templates, ...config.params } })

function makeFs(files) {
  return {
    resolve: async (path) => path,
    stat: async (path) => files.get(path),
  }
}

test('extractInstructionPaths：4 种官方标题中 removed 不进参考文件列表', () => {
  const message = { content: [{ type: 'text', text: 'Instructions from: A\n\nAdditional instructions from: B\n\nUpdated instructions from: C\n\nInstructions removed: D\n' }] }
  assert.deepEqual(extractInstructionPaths(message), ['A', 'B', 'C'])
})

test('instruction-hint 是通用引擎：探测 cwd 到项目根的完整链和用户级文件', async () => {
  const files = new Map([
    [path.join(projectDir, '.git'), { type: 'directory' }],
    [path.join(projectDir, 'AGENTS.md'), { type: 'file' }],
    [path.join(nestedDir, 'CLAUDE.md'), { type: 'file' }],
    [path.join(globalHome, 'AGENTS.md'), { type: 'file' }],
  ])
  const found = await collectInstructionFiles(makeFs(files), nestedDir, undefined, globalHome)
  assert.deepEqual(found, {
    root: projectDir,
    projectFiles: [path.join(nestedDir, 'CLAUDE.md'), 'AGENTS.md'],
    userGlobalFiles: ['AGENTS.md'],
    userGlobalHome: globalHome,
  })
})

test('instruction-hint scope：project 只报项目链，global 只报 $DSH_HOME/AGENTS.md', async () => {
  const files = new Map([
    [path.join(projectDir, '.git'), { type: 'directory' }],
    [path.join(projectDir, 'AGENTS.md'), { type: 'file' }],
    [path.join(globalHome, 'AGENTS.md'), { type: 'file' }],
  ])
  const fs = makeFs(files)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = globalHome
  try {
    const run = async (scope) => {
      const resolve = createInstructionHintResolver(scope === undefined ? {} : { params: { scope } })
      return resolve({
        ctx: { get: (name) => (name === 'fs' ? fs : undefined) },
        agent: {},
        session: { id: 'scope-session', header: { cwd: nestedDir } },
      })
    }
    const project = await run('project')
    assert.ok(project.text.includes('Reference documents exist: AGENTS.md (project root: ' + projectDir + ').'))
    assert.doesNotMatch(project.text, /user reference document/)
    const global = await run('global')
    assert.ok(global.text.includes('A user reference document exists: ' + path.join(globalHome, 'AGENTS.md') + '.'))
    assert.doesNotMatch(global.text, /Reference documents exist/)
    const all = await run(undefined)
    assert.match(all.text, /Reference documents exist/)
    assert.match(all.text, /A user reference document exists/)
    const none = createInstructionHintResolver({ params: { scope: 'project' } })
    const empty = await none({
      ctx: { get: (name) => (name === 'fs' ? makeFs(new Map()) : undefined) },
      agent: {},
      session: { id: 'empty-session', header: { cwd: projectDir } },
    })
    assert.equal(empty, null, '探测不到文件时返回 null，不注入消息')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('instruction-hint：projectTemplate 与 globalTemplate 的 {{pick}} 各用自己的模板名作 seed', () => {
  // 判别力：两个调用点都省略 sourceId 时共享 sha256([undefined,'',0])，两段等价模板必然逐字相同。
  // 取值是 sha256 的，故只断言「不同」——16 处全撞概率 (1/5)¹⁶（同 interpolate.test.mjs 的理由）。
  const template = Array.from({ length: 16 }, () => '{{pick::a::b::c::d::e}}').join('|')
  const both = { projectTemplate: template, globalTemplate: template }
  const found = { root: '/repo', projectFiles: ['AGENTS.md'], userGlobalFiles: ['AGENTS.md'], userGlobalHome: '/home/.dsh' }
  const project = buildInstructionHintText(found, 'project', both)
  assert.notEqual(buildInstructionHintText(found, 'global', both), project, '两个模板位置不共用 seed')
  assert.equal(buildInstructionHintText(found, 'project', both), project, '同一模板位置取值稳定')
})

test('instruction-hint 共享转换保留替换消息 id、只替换一次', () => {
  const original = {
    id: 'agent-instructions-1',
    role: 'user',
    content: [{ type: 'text', text: 'Instructions from: /repo/AGENTS.md\nbody' }],
    source: { kind: 'agent-instructions' },
  }
  const state = { instructionHinted: false }
  const first = instructionHintMessages([original], state, 'test-gate')
  assert.equal(first[0].id, original.id)
  assert.equal(first[0].source.kind, 'instruction-hint')
  assert.equal(first[0].source.plugin, 'test-gate')
  assert.match(first[0].content[0].text, /Reference documents exist: \/repo\/AGENTS\.md/)
  assert.deepEqual(instructionHintMessages([original], state, 'test-gate'), [])
  assert.equal(state.instructionHinted, true)
})

test('instruction-hint 只通过 placeholder fill 使用', async () => {
  const configs = createPromptConfigs([
    { id: 'filled', strategy: 'placeholder', fill: 'instruction-hint', params: { text: '参考文件提示' } },
  ])
  const args = {
    ctx: { get: () => undefined },
    agent: { signal: undefined },
    session: { id: 's1', header: { cwd: '/repo' } },
  }
  const filled = await configs.find((config) => config.id === 'filled').resolve(args)
  const repeated = await configs.find((config) => config.id === 'filled').resolve(args)
  for (const result of [filled, repeated]) {
    assert.equal(result.text, '参考文件提示')
    assert.match(result.id, /^instruction-hint-s1-[0-9a-f-]+$/)
    assert.equal(result.source.kind, 'instruction-hint')
  }
  assert.notEqual(filled.id, repeated.id)
})

test('buildInstructionHint 兼容无 id 的输入并生成随机 id', () => {
  const hint = buildInstructionHint(undefined, ['/repo/AGENTS.md'])
  assert.match(hint.id, /^instruction-hint-[0-9a-f-]+$/)
  assert.equal(hint.source.form, 'hint')
})

test('真实组合指令提示：主会话和子代理晋升后转换，压缩重置且卸载释放', async (t) => {
  const rows = parse(readFileSync(new URL('../../engine/compositions/source/local/instruction-hint.yml', import.meta.url), 'utf8'))
  const row = rows.find((entry) => entry?.id === 'instruction-hint')
  assert.ok(row !== undefined, '组合源必须有 instruction-hint 行')
  assert.equal(row.config.enabled, false, '默认关闭，由模块参数显式开启')
  apply({ on: () => assert.fail('关闭时不应注册任何监听器') }, row.config)
  const root = new Context()
  t.after(() => root.fiber.dispose())
  const original = {
    id: 'official-instructions', role: 'user',
    content: [{ type: 'text', text: 'Instructions from: /repo/AGENTS.md\nFULL BODY' }],
    source: { kind: 'agent-instructions' },
  }
  for (const [delegationDepth, promoteEvent] of [[0, 'tool/call'], [1, 'assistant/message']]) {
    const events = [], visible = []
    const session = {
      id: `instruction-hint-depth-${delegationDepth}`, header: { delegationDepth },
      snapshotEvents: () => events, deriveMessages: () => visible,
    }
    const mounted = await root.plugin({ apply }, { ...row.config, enabled: true })
    const step = () => root.waterfall('agent/pre-step', { agent: { session } }, async () => ({ kind: 'enter', messages: [original] }))
    const record = (type, data = {}) => {
      const event = { type, seq: events.length + 1, data }
      events.push(event)
      root.emit('session/event', session, event)
    }
    const assertHint = decision => {
      assert.equal(decision.messages.length, 1)
      assert.equal(decision.messages[0].id, original.id)
      assert.equal(decision.messages[0].source.kind, 'instruction-hint')
      assert.match(decision.messages[0].content[0].text, /Reference documents exist: \/repo\/AGENTS\.md/)
      assert.doesNotMatch(decision.messages[0].content[0].text, /FULL BODY/)
    }
    assert.deepEqual((await step()).messages, [original], '主会话与子代理首请求均保留全文')
    visible.push(original)
    record(promoteEvent)
    const promoted = await step()
    assertHint(promoted)
    assert.deepEqual(visible, [original], '转换不得改写已进入历史的全文')
    visible.push(...promoted.messages)
    assert.deepEqual((await step()).messages, [], '可见面已有路径提示时不重复投递')
    record('compaction/end', { error: 'compaction failed' })
    assert.deepEqual((await step()).messages, [], '失败压缩不重置晋升或去重')
    record('compaction/end')
    visible.length = 0
    assert.deepEqual((await step()).messages, [original], '成功压缩后的首请求重新保留全文')
    record(promoteEvent === 'tool/call' ? 'assistant/message' : 'tool/call')
    const promotedAgain = await step()
    assertHint(promotedAgain)
    visible.push(...promotedAgain.messages)
    await mounted.dispose()
    assert.deepEqual((await step()).messages, [original], '卸载后不再转换或丢弃官方消息')
  }
})

test('全局层回退：两个模块同时装到同一行时不重复转换（一份提示、一次晋升、一次压缩重置）', async (t) => {
  // 场景来源：用户裁定「模块未声明 ⇒ 回退 config.yml 全局值」后，未声明该键的模块会**都**
  // 回退到同一份全局参数 ⇒ 同一行被 N 个模块各装配一次（D2-a）。这里把同一行装两次，
  // 钉住「不会各转一份、不会重复投递、不会互相吃掉」。
  const rows = parse(readFileSync(new URL('../../engine/compositions/source/local/instruction-hint.yml', import.meta.url), 'utf8'))
  const row = rows.find((entry) => entry?.id === 'instruction-hint')
  assert.ok(row !== undefined)
  const root = new Context()
  t.after(() => root.fiber.dispose())
  const original = {
    id: 'official-instructions', role: 'user',
    content: [{ type: 'text', text: 'Instructions from: /repo/AGENTS.md\nFULL BODY' }],
    source: { kind: 'agent-instructions' },
  }
  const events = [], visible = []
  const session = {
    id: 'global-fallback-dedupe', header: { delegationDepth: 0 },
    snapshotEvents: () => events, deriveMessages: () => visible,
  }
  const first = await root.plugin({ apply }, { ...row.config, enabled: true })
  const second = await root.plugin({ apply }, { ...row.config, enabled: true })
  const step = () => root.waterfall('agent/pre-step', { agent: { session } }, async () => ({ kind: 'enter', messages: [original] }))
  const record = (type, data = {}) => {
    const event = { type, seq: events.length + 1, data }
    events.push(event)
    root.emit('session/event', session, event)
  }

  assert.deepEqual((await step()).messages, [original], '未晋升时两条行都不转换')
  visible.push(original)
  record('tool/call')
  const promoted = await step()
  assert.equal(promoted.messages.length, 1, '两份监听只产生一份提示，不重复投递')
  assert.equal(promoted.messages[0].source.kind, 'instruction-hint')
  assert.match(promoted.messages[0].content[0].text, /Reference documents exist: \/repo\/AGENTS\.md/)
  assert.doesNotMatch(promoted.messages[0].content[0].text, /FULL BODY/)
  visible.push(...promoted.messages)
  assert.deepEqual((await step()).messages, [], '可见面已有提示时不重复投递（去重按会话）')

  record('compaction/end')
  visible.length = 0
  assert.deepEqual((await step()).messages, [original], '成功压缩后仍按既有语义重新保留全文')
  record('tool/call')
  const promotedAgain = await step()
  assert.equal(promotedAgain.messages.length, 1, '压缩后第二次晋升仍只产生一份提示')
  assert.equal(promotedAgain.messages[0].source.kind, 'instruction-hint')

  await second.dispose()
  await first.dispose()
  assert.deepEqual((await step()).messages, [original], '两条行都卸载后不再转换')
})
