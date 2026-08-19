import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { buildCordis, parseFrontmatter, patchToolBootstrap } from '../lib/preset-core.mjs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('parseFrontmatter 保留 name/description/whenToUse/metadata 全部字段', () => {
  const { data, body } = parseFrontmatter(read('skills/sandboxmod/SKILL.md'))
  assert.equal(data.name, 'prompt')
  assert.ok(data.description?.includes('沙箱模式'))
  assert.ok(data.whenToUse?.includes('破解'))
  assert.deepEqual(data.metadata, {
    version: '1.1.0',
    models: ['deepseek-v4-flash-7013', 'deepseek-v4-pro-8013'],
    role: 'system',
  })
  assert.ok(body.includes('<system>'))
  assert.ok(body.includes('[本地协议]'))
})

test('无 frontmatter 时返回空 data 与原文本', () => {
  const text = '# 纯文本\n'
  const { data, body } = parseFrontmatter(text)
  assert.deepEqual(data, {})
  assert.equal(body, text)
})

test('buildCordis 生成合法 YAML：prompt-config-engine 指向提示词配置模块目录，且落在 tool-bootstrap 之后', () => {
  const out = buildCordis(read('preset.md'))
  assert.ok(!out.includes('__SLOTS__'))

  const bootstrap = out.indexOf('- id: tool-bootstrap\n')
  const engine = out.indexOf('- id: prompt-config-engine\n')
  const identity = out.indexOf('# ── identity')
  assert.ok(bootstrap >= 0)
  assert.ok(bootstrap < engine)
  assert.ok(engine < identity)

  const doc = parse(out, { logLevel: 'silent' })
  assert.ok(Array.isArray(doc))
  const row = doc.find((entry) => entry?.id === 'prompt-config-engine')
  assert.ok(row)
  assert.equal(row.name, './engine/prompt-config-engine.mjs')
  assert.equal(row.config.configsDir, '../prompt-configs')
  const rft = doc.find((entry) => entry?.id === 'router-first-turn')
  assert.ok(rft)
  assert.equal(rft.name, './anchored/router-first-turn.mjs')
})

test('buildCordis 恒生成 run-code-env 行（PTC env 提示词配置）', () => {
  const out = buildCordis('PROMPT')
  const doc = parse(out, { logLevel: 'silent' })
  const row = doc.find((entry) => entry?.id === 'run-code-env')
  assert.ok(row)
  assert.equal(row.name, './anchored/run-code-env.mjs')
  assert.equal(row.config.enabled, true)
  assert.ok(row.config.envKeys.includes('PATH'))
  assert.ok(row.config.envKeys.includes('USERPROFILE'))
})

test('buildCordis 关闭 anchorFirstTurn 时输出与无选项版本一致', () => {
  assert.equal(buildCordis('PROMPT', { anchorFirstTurn: false, anchorText: 'X' }), buildCordis('PROMPT'))
})

function findAllRows(doc, ids) {
  const found = []
  const walk = (rows) => {
    for (const row of rows) {
      if (row !== null && typeof row === 'object') {
        if (ids.has(row.id)) found.push(row)
        if (Array.isArray(row.config)) walk(row.config)
      }
    }
  }
  walk(Array.isArray(doc) ? doc : [])
  return found
}

test('buildCordis 开启 subagentFlash 时给 subagent/subagent_fork 加固定 Flash 路由', () => {
  const out = buildCordis('PROMPT', {
    subagentFlash: true,
    subagentFlashProvider: 'my-provider',
    subagentFlashModel: 'deepseek-v4-flash-7013',
  })
  const doc = parse(out, { logLevel: 'silent' })
  const rows = findAllRows(doc, new Set(['tool-subagent', 'tool-subagent-fork']))
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.equal(row.config.agentOptions.provider, 'my-provider')
    assert.equal(row.config.agentOptions.model, 'deepseek-v4-flash-7013')
    assert.match(row.config.persona, /decide the task type \(build or fix\)/)
    assert.match(row.config.persona, /Do not run environment checks/)
    assert.match(row.config.persona, /Think deeply first, then produce\./)
  }
})

test('buildCordis 适配 context-gate：放行 near-anchor/router-guide，子代理不关门', () => {
  const out = buildCordis('PROMPT')
  const doc = parse(out, { logLevel: 'silent' })
  const row = doc.find((entry) => entry?.id === 'context-gate')
  assert.ok(row)
  assert.equal(row.config.includeSubagents, false)
  assert.deepEqual(row.config.allowKinds, ['skill-invocation', 'near-anchor', 'router-guide'])
})

test('buildCordis custom-bash 运行时探测并显式写入超时/输出上限', () => {
  const out = buildCordis('PROMPT')
  assert.ok(!out.includes('bashPath:'))
  const doc = parse(out, { logLevel: 'silent' })
  const row = findAllRows(doc, new Set(['custom-bash']))[0]
  assert.ok(row)
  assert.equal(row.config.timeoutMs, 120000)
  assert.equal(row.config.maxOutputBytes, 64000)
})

test('buildCordis 默认不注入 bootstrapMaxTokens（本项目默认无封顶）', () => {
  const out = buildCordis('PROMPT')
  assert.ok(!out.includes('bootstrapMaxTokens:'))
})

test('buildCordis 按配置注入任意正整数 bootstrapMaxTokens', () => {
  const out = buildCordis('PROMPT', { bootstrapMaxTokens: 2048 })
  const doc = parse(out, { logLevel: 'silent' })
  const row = findAllRows(doc, new Set(['tool-bootstrap']))[0]
  assert.ok(row)
  assert.equal(row.config.bootstrapMaxTokens, 2048)
})

test('buildCordis 关闭 subagentFlash 时子代理行不出现 agentOptions', () => {
  const out = buildCordis('PROMPT')
  const doc = parse(out, { logLevel: 'silent' })
  const row = findAllRows(doc, new Set(['tool-subagent']))[0]
  assert.ok(row)
  assert.equal(row.config.agentOptions, undefined)
})

test('buildCordis 默认开启使用 PTC 模式', () => {
  const out = buildCordis('PROMPT')
  const doc = parse(out, { logLevel: 'silent' })
  const bootstrap = doc.find((entry) => entry?.id === 'tool-bootstrap')
  const search = doc.find((entry) => entry?.id === 'dev-tool-search')
  assert.ok(bootstrap)
  assert.equal(bootstrap.config.usePtcMode, true)
  assert.equal(search, undefined)
})

test('buildCordis 可显式关闭使用 PTC 模式：恢复原生完整目录', () => {
  const out = buildCordis('PROMPT', { usePtcMode: false })
  const doc = parse(out, { logLevel: 'silent' })
  const bootstrap = doc.find((entry) => entry?.id === 'tool-bootstrap')
  assert.ok(bootstrap)
  assert.equal(bootstrap.config.usePtcMode, false)
})

test('preset/anchored/tool-bootstrap.mjs 已是含共享工具与 PTC 逻辑的最终自有快照', () => {
  const source = read('preset/anchored/tool-bootstrap.mjs')
  assert.ok(source.includes("from '../engine/shared.mjs'"))
  assert.ok(source.includes("tools.presentAs('code')"))
  assert.ok(source.includes('if (usePtcMode) applyCodePresentation(agent)'))
  assert.ok(!source.includes('dev_tool_search'))
  assert.ok(!source.includes('RESIDENT_DISCOVERY_TOOLS'))
})

test('preset/shared.mjs 提供公共晋升解析与消息工具', () => {
  const source = read('preset/engine/shared.mjs')
  assert.ok(source.includes('export const PROMOTE_EVENTS'))
  assert.ok(source.includes('export function parsePromoteOn'))
  assert.ok(source.includes('export function newMessageId'))
  assert.ok(source.includes('export function extractText'))
  assert.ok(source.includes('export function isDelegated'))
})

test('preset/prompt-config-engine.mjs 内置 instruction-hint 的 agents-instruction.txt 读取逻辑', () => {
  const source = read('preset/engine/prompt-config-engine.mjs')
  assert.ok(source.includes("new URL('./agents-instruction.txt', import.meta.url)"))
  assert.ok(source.includes('agentsInstructionText.length > 0'))
  assert.ok(source.includes('configsDir'))
  assert.ok(source.includes('loadPromptConfigFiles'))
  assert.ok(source.includes('parsePromptConfigYaml'))
})

test('旧独立注入模块已移除：agent.cordis.yml 不再注册 near-anchor/router-guide/prompt-injector/instruction-hint 行', () => {
  const out = buildCordis('PROMPT')
  assert.ok(!out.includes('- id: near-anchor\n'))
  assert.ok(!out.includes('- id: router-guide\n'))
  assert.ok(!out.includes('- id: prompt-injector\n'))
  assert.ok(!out.includes('- id: instruction-hint\n'))
  assert.ok(out.includes('- id: prompt-config-engine\n'))
})

test('patchToolBootstrap 注入 PTC 呈现状态机与晋升后的完整目录分支', () => {
  const source = read('upstream/dsh-anchored-standard/preset/tool-bootstrap.mjs')
  const patched = patchToolBootstrap(source)
  assert.ok(patched.includes("const usePtcMode = booleanOption(source.usePtcMode, 'usePtcMode', true)"))
  assert.ok(patched.includes("tools.presentAs('code')"))
  assert.ok(patched.includes('if (usePtcMode) applyCodePresentation(agent)'))
  assert.ok(patched.includes('agentBySession.set(agent.session, agent)'))
  assert.ok(patched.includes('return assembled'))
  assert.ok(patched.includes("event.type === 'compaction/end'"))
  assert.ok(!patched.includes('const RESIDENT_DISCOVERY_TOOLS'))
  assert.ok(!patched.includes('const unlockedFor = (session) => {'))
  // 晋升分支位于受控阶段注释之前，目录不再被 resident 白名单裁剪。
  const promoted = patched.indexOf('if (usePtcMode) applyCodePresentation(agent)')
  const controlled = patched.indexOf('// Controlled phase:', promoted)
  assert.ok(promoted >= 0)
  assert.ok(controlled > promoted)
})
