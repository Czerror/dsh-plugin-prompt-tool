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

test('buildCordis 生成合法 YAML，router-first-turn 与 prompt-injector 落在 tool-bootstrap 之后', () => {
  const prompt = read('preset.md')
  const out = buildCordis(prompt)
  assert.ok(!out.includes('__PROMPT_TOOL_TEXT__'))
  assert.ok(out.includes('Local fixture template:'))

  const bootstrap = out.indexOf('- id: tool-bootstrap\n')
  const router = out.indexOf('- id: router-first-turn\n')
  const injector = out.indexOf('- id: prompt-injector\n')
  const identity = out.indexOf('# ── identity')
  assert.ok(bootstrap >= 0)
  assert.ok(bootstrap < router)
  assert.ok(router < injector)
  assert.ok(injector < identity)

  const doc = parse(out, { logLevel: 'silent' })
  assert.ok(Array.isArray(doc))
  const row = doc.find((entry) => entry?.id === 'prompt-injector')
  assert.ok(row)
  assert.equal(typeof row.config.promptText, 'string')
  assert.ok(row.config.promptText.includes('Local fixture template:'))
})

test('buildCordis 处理空提示词时不残留占位符且结构完整', () => {
  const out = buildCordis('')
  assert.ok(!out.includes('__PROMPT_TOOL_TEXT__'))
  const doc = parse(out, { logLevel: 'silent' })
  assert.ok(Array.isArray(doc))
  assert.ok(doc.some((entry) => entry?.id === 'router-first-turn'))
  assert.ok(doc.some((entry) => entry?.id === 'prompt-injector'))
  assert.ok(!doc.some((entry) => entry?.id === 'near-anchor'))
})

test('buildCordis 开启 anchorFirstTurn 时注入 near-anchor 行与自定义锚定句', () => {
  const out = buildCordis('PROMPT', { anchorFirstTurn: true, anchorText: 'ANCHOR SENTENCE' })
  assert.ok(!out.includes('__PROMPT_TOOL_TEXT__'))
  assert.ok(!out.includes('__ANCHOR_TEXT__'))
  const doc = parse(out, { logLevel: 'silent' })
  const rows = doc.filter((entry) => entry?.id === 'near-anchor' || entry?.id === 'prompt-injector')
  assert.deepEqual(rows.map((entry) => entry.id), ['near-anchor', 'prompt-injector'])
  assert.equal(rows[0].config.anchorText, 'ANCHOR SENTENCE')
  assert.equal(rows[0].config.useCustom, false)
})

test('buildCordis 开启 anchorCustom 时 near-anchor 固定使用自定义文本', () => {
  const out = buildCordis('PROMPT', { anchorFirstTurn: true, anchorText: 'CUSTOM', anchorCustom: true })
  assert.ok(!out.includes('__USE_CUSTOM__'))
  const doc = parse(out, { logLevel: 'silent' })
  const row = doc.find((entry) => entry?.id === 'near-anchor')
  assert.ok(row)
  assert.equal(row.config.useCustom, true)
  assert.equal(row.config.anchorText, 'CUSTOM')
})

test('buildCordis 开启 anchorFirstTurn 且空锚点文本时生成自动模式配置', () => {
  const out = buildCordis('PROMPT', { anchorFirstTurn: true, anchorText: '' })
  const doc = parse(out, { logLevel: 'silent' })
  const row = doc.find((entry) => entry?.id === 'near-anchor')
  assert.ok(row)
  assert.equal(row.config.anchorText, '')
})

test('buildCordis 关闭 anchorFirstTurn 时输出与无选项版本一致', () => {
  assert.equal(buildCordis('PROMPT', { anchorFirstTurn: false, anchorText: 'X' }), buildCordis('PROMPT'))
})

test('buildCordis 关闭 injectPrompt 时只保留工具引导，不生成 prompt-injector 行', () => {
  const out = buildCordis('PROMPT', { injectPrompt: false, anchorFirstTurn: false })
  assert.ok(!out.includes('__PROMPT_TOOL_TEXT__'))
  const doc = parse(out, { logLevel: 'silent' })
  assert.ok(Array.isArray(doc))
  assert.ok(doc.some((entry) => entry?.id === 'tool-bootstrap'))
  assert.ok(doc.some((entry) => entry?.id === 'router-first-turn'))
  assert.ok(!doc.some((entry) => entry?.id === 'prompt-injector'))
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

test('buildCordis 适配 context-gate：放行 near-anchor，子代理不关门', () => {
  const out = buildCordis('PROMPT')
  const doc = parse(out, { logLevel: 'silent' })
  const row = doc.find((entry) => entry?.id === 'context-gate')
  assert.ok(row)
  assert.equal(row.config.includeSubagents, false)
  assert.deepEqual(row.config.allowKinds, ['skill-invocation', 'near-anchor', 'router-guide'])
})

test('buildCordis 恒生成 router-guide 行，默认自动引导', () => {
  const out = buildCordis('PROMPT')
  const doc = parse(out, { logLevel: 'silent' })
  const row = doc.find((entry) => entry?.id === 'router-guide')
  assert.ok(row)
  assert.equal(row.config.useCustom, false)
  assert.equal(row.config.text, '')
  assert.equal(row.config.enabled, false)
})

test('buildCordis 开启 anchorFirstTurn 时 router-guide 启用', () => {
  const out = buildCordis('PROMPT', { anchorFirstTurn: true })
  const doc = parse(out, { logLevel: 'silent' })
  const row = doc.find((entry) => entry?.id === 'router-guide')
  assert.ok(row)
  assert.equal(row.config.enabled, true)
  assert.equal(row.config.useCustom, false)
})

test('buildCordis guideCustom=true 时固定自定义每轮引导', () => {
  const out = buildCordis('PROMPT', { anchorFirstTurn: true, guideCustom: true, guideText: 'CUSTOM GUIDE' })
  assert.ok(!out.includes('__GUIDE_TEXT__'))
  const doc = parse(out, { logLevel: 'silent' })
  const row = doc.find((entry) => entry?.id === 'router-guide')
  assert.ok(row)
  assert.equal(row.config.enabled, true)
  assert.equal(row.config.useCustom, true)
  assert.equal(row.config.text, 'CUSTOM GUIDE')
})

test('buildCordis 恒生成 router-guide 行', () => {
  const out = buildCordis('PROMPT')
  const doc = parse(out, { logLevel: 'silent' })
  assert.ok(doc.some((entry) => entry?.id === 'router-guide'))
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

test('buildCordis injectPrompt=false 且 anchorFirstTurn=true 只生成 near-anchor', () => {
  const out = buildCordis('PROMPT', { injectPrompt: false, anchorFirstTurn: true, anchorText: 'A' })
  const doc = parse(out, { logLevel: 'silent' })
  const ids = doc.map((entry) => entry?.id)
  assert.ok(ids.includes('tool-bootstrap'))
  assert.ok(ids.includes('router-first-turn'))
  assert.ok(ids.includes('near-anchor'))
  assert.ok(!ids.includes('prompt-injector'))
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

test('preset/tool-bootstrap.mjs 已是含共享工具与 PTC 逻辑的最终自有快照', () => {
  const source = read('preset/tool-bootstrap.mjs')
  assert.ok(source.includes("from './shared.mjs'"))
  assert.ok(source.includes("tools.presentAs('code')"))
  assert.ok(source.includes('if (usePtcMode) applyCodePresentation(agent)'))
  assert.ok(!source.includes('dev_tool_search'))
  assert.ok(!source.includes('RESIDENT_DISCOVERY_TOOLS'))
})

test('preset/shared.mjs 提供公共晋升解析与消息工具', () => {
  const source = read('preset/shared.mjs')
  assert.ok(source.includes('export const PROMOTE_EVENTS'))
  assert.ok(source.includes('export function parsePromoteOn'))
  assert.ok(source.includes('export function newMessageId'))
  assert.ok(source.includes('export function extractText'))
  assert.ok(source.includes('export function isDelegated'))
})

test('preset/instruction-hint.mjs 已自带 agents-instruction.txt 读取逻辑', () => {
  const source = read('preset/instruction-hint.mjs')
  assert.ok(source.includes("readFileSync(new URL('./agents-instruction.txt', import.meta.url)"))
  assert.ok(source.includes('if (agentsInstructionText.length > 0)'))
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
