import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

import {
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

// 本文件其余用例都从 legacy-defaults.yml 注入模板（见文件头 helper），所以
// `apply()` 的注册前置条件在那些用例里**恒被满足**——组合源本身缺模板这件事测不出来。
// 下面这条改读**线上真实组合源**，并复刻 apply():273 的判据。
// 背景：组合源一度只配 enabled/promoteOn/includeSubagents，于是把参数桥开关打开后
// apply() 在第一行就 return —— 配置合法、零效果、零报错（与 count.delegated 同类）。
test('组合源指令提示行自带必需模板，apply 前置条件可满足（缺模板=静默失效）', () => {
  const rows = parse(readFileSync(new URL('../../engine/compositions/source/local/instruction-hint.yml', import.meta.url), 'utf8'))
  const row = rows.find((entry) => entry?.id === 'instruction-hint')
  assert.ok(row !== undefined, '组合源必须有 instruction-hint 行')
  const cfg = row.config ?? {}
  assert.equal(cfg.enabled, false, '缺省关闭，由参数桥 params.instructionHint 打开')
  assert.equal(cfg.promoteOn, 'either', '晋升词表与 tool-bootstrap 同源')
  assert.equal(cfg.includeSubagents, true, '子代理首次请求即视为已晋升，故需显式纳入')
  for (const key of ['projectTemplate', 'globalTemplate', 'suffixTemplate', 'messageTemplate']) {
    assert.equal(typeof cfg[key], 'string', `${key} 必须随行声明（运行时不得读 legacy-defaults.yml）`)
    assert.ok(cfg[key].trim().length > 0, `${key} 不得为空`)
  }
  // 与迁移路径（rules-migration.ts 的 legacyPolicyDefaults().instructionHint）同源，
  // 否则「迁移进来的定义」与「新装的组合源」行为分叉。
  for (const key of ['projectTemplate', 'globalTemplate', 'suffixTemplate', 'messageTemplate']) {
    assert.equal(cfg[key], templates[key], `${key} 必须与 legacy-defaults.yml 逐字一致`)
  }
  // 逐字复刻 instruction-hint.mjs#apply 第一行：
  //   if (!enabled || templateOf(source,'messageTemplate').trim().length === 0) return
  // 组合源缺省 enabled=false，所以这里固定把 enabled 当 true 来单独检验模板那一半——
  // 缺模板才是「开关打开也无效」的静默失效，正是本条要锁住的。
  assert.equal(cfg.messageTemplate.trim().length > 0, true, '开关打开后必须能注册（缺模板会静默失效）')
})
