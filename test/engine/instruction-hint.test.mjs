import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildInstructionHint,
  collectInstructionFiles,
  createInstructionHintResolver,
  instructionHintMessages,
} from '../../engine/instruction-hint.mjs'
import { createPromptConfigs } from '../../engine/prompt-config-engine.mjs'

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

test('instruction-hint 直接策略与 placeholder fill 共用同一能力', async () => {
  const configs = createPromptConfigs([
    { id: 'direct', strategy: 'instruction-hint', params: { text: '参考文件提示' } },
    { id: 'filled', strategy: 'placeholder', fill: 'instruction-hint', params: { text: '参考文件提示' } },
  ])
  const args = {
    ctx: { get: () => undefined },
    agent: { signal: undefined },
    session: { id: 's1', header: { cwd: '/repo' } },
  }
  const direct = await configs.find((config) => config.id === 'direct').resolve(args)
  const filled = await configs.find((config) => config.id === 'filled').resolve(args)
  for (const result of [direct, filled]) {
    assert.equal(result.text, '参考文件提示')
    assert.match(result.id, /^instruction-hint-s1-[0-9a-f-]+$/)
    assert.equal(result.source.kind, 'instruction-hint')
  }
  assert.notEqual(direct.id, filled.id)
})

test('buildInstructionHint 兼容无 id 的输入并生成随机 id', () => {
  const hint = buildInstructionHint(undefined, ['/repo/AGENTS.md'])
  assert.match(hint.id, /^instruction-hint-[0-9a-f-]+$/)
  assert.equal(hint.source.form, 'hint')
})
