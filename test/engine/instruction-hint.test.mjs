import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { parse } from 'yaml'

import {
  apply,
  buildInstructionHint as rawBuildInstructionHint,
  collectInstructionFiles,
  createInstructionHintResolver as rawCreateInstructionHintResolver,
  instructionHintMessages as rawInstructionHintMessages,
} from '../../engine/instruction-hint.mjs'
import { createPromptConfigs } from '../../engine/schema.mjs'

// 旧措辞现在属于显式模板，断言仍使用独立的已知良好文本。
const templates = parse(readFileSync(new URL('../../templates/policies/legacy-defaults.yml', import.meta.url), 'utf8')).instructionHint
const buildInstructionHint = (original, paths, sourceName) => rawBuildInstructionHint(original, paths, sourceName, templates)
const instructionHintMessages = (messages, state, sourceName) => rawInstructionHintMessages(messages, state, sourceName, templates)
const createInstructionHintResolver = (config = {}) => rawCreateInstructionHintResolver({ ...config, params: { ...templates, ...config.params } })

function makeFs(files) {
  return {
    resolve: async (path) => path,
    stat: async (path) => files.get(path),
  }
}

test('instruction-hint 是通用引擎：探测 cwd 到项目根的完整链和用户级文件', async () => {
  const files = new Map([
    ['/repo/.git', { type: 'directory' }],
    ['/repo/AGENTS.md', { type: 'file' }],
    ['/repo/sub/CLAUDE.md', { type: 'file' }],
    ['/home/.dsh/AGENTS.md', { type: 'file' }],
  ])
  const found = await collectInstructionFiles(makeFs(files), '/repo/sub', undefined, '/home/.dsh')
  assert.deepEqual(found, {
    root: '/repo',
    projectFiles: ['/repo/sub/CLAUDE.md', 'AGENTS.md'],
    userGlobalFiles: ['AGENTS.md'],
    userGlobalHome: '/home/.dsh',
  })
})

test('instruction-hint scope：project 只报项目链，global 只报 $DSH_HOME/AGENTS.md', async () => {
  const files = new Map([
    ['/repo/.git', { type: 'directory' }],
    ['/repo/AGENTS.md', { type: 'file' }],
    ['/home/.dsh/AGENTS.md', { type: 'file' }],
  ])
  const fs = makeFs(files)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = '/home/.dsh'
  try {
    const run = async (scope) => {
      const resolve = createInstructionHintResolver(scope === undefined ? {} : { params: { scope } })
      return resolve({
        ctx: { get: (name) => (name === 'fs' ? fs : undefined) },
        agent: {},
        session: { id: 'scope-session', header: { cwd: '/repo/sub' } },
      })
    }
    const project = await run('project')
    assert.match(project.text, /Reference documents exist: AGENTS\.md \(project root: \/repo\)\./)
    assert.doesNotMatch(project.text, /user reference document/)
    const global = await run('global')
    assert.match(global.text, /A user reference document exists: \/home\/\.dsh\/AGENTS\.md\./)
    assert.doesNotMatch(global.text, /Reference documents exist/)
    const all = await run(undefined)
    assert.match(all.text, /Reference documents exist/)
    assert.match(all.text, /A user reference document exists/)
    const none = createInstructionHintResolver({ params: { scope: 'project' } })
    const empty = await none({
      ctx: { get: (name) => (name === 'fs' ? makeFs(new Map()) : undefined) },
      agent: {},
      session: { id: 'empty-session', header: { cwd: '/repo' } },
    })
    assert.equal(empty, null, '探测不到文件时返回 null，不注入消息')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
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

test('instruction-hint 只通过 placeholder fill 使用，不接受旧独立策略', async () => {
  assert.throws(() => createPromptConfigs([
    { id: 'direct', strategy: 'instruction-hint', params: { text: '参考文件提示' } },
  ]), /unknown strategy/)
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
