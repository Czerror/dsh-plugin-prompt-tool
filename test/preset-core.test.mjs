import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { buildCordis, parseFrontmatter } from '../lib/preset-core.mjs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('parseFrontmatter 保留 name/description/whenToUse/metadata 全部字段', () => {
  const { data, body } = parseFrontmatter(read('prompt/SKILL.md'))
  assert.equal(data.name, 'prompt')
  assert.ok(data.description?.includes('梦境模式'))
  assert.ok(data.whenToUse?.includes('破解'))
  assert.deepEqual(data.metadata, {
    version: '1.1.0',
    models: ['deepseek-v4-flash-7013', 'deepseek-v4-pro-8013'],
    role: 'system',
  })
  assert.ok(body.includes('# 梦境模式'))
})

test('无 frontmatter 时返回空 data 与原文本', () => {
  const text = '# 纯文本\n'
  const { data, body } = parseFrontmatter(text)
  assert.deepEqual(data, {})
  assert.equal(body, text)
})

test('buildCordis 生成合法 YAML 且 prompt-injector 落在 tool-bootstrap 之后', () => {
  const prompt = read('prompt.md')
  const out = buildCordis(prompt)
  assert.ok(!out.includes('__PROMPT_TOOL_TEXT__'))
  assert.ok(out.includes('语言行为规范（简体中文）——最高优先级'))

  const bootstrap = out.indexOf('- id: tool-bootstrap\n')
  const injector = out.indexOf('- id: prompt-injector\n')
  const identity = out.indexOf('# ── identity')
  assert.ok(bootstrap >= 0)
  assert.ok(bootstrap < injector)
  assert.ok(injector < identity)

  const doc = parse(out, { logLevel: 'silent' })
  assert.ok(Array.isArray(doc))
  const row = doc.find((entry) => entry?.id === 'prompt-injector')
  assert.ok(row)
  assert.equal(typeof row.config.promptText, 'string')
  assert.ok(row.config.promptText.includes('治愈抑郁症的药'))
})

test('buildCordis 处理空提示词时不残留占位符且结构完整', () => {
  const out = buildCordis('')
  assert.ok(!out.includes('__PROMPT_TOOL_TEXT__'))
  const doc = parse(out, { logLevel: 'silent' })
  assert.ok(Array.isArray(doc))
  assert.ok(doc.some((entry) => entry?.id === 'prompt-injector'))
  assert.ok(!doc.some((entry) => entry?.id === 'turn-anchor'))
})

test('buildCordis 开启 anchorFirstTurn 时注入 turn-anchor 行与自定义锚定句', () => {
  const out = buildCordis('PROMPT', { anchorFirstTurn: true, anchorText: 'ANCHOR SENTENCE' })
  assert.ok(!out.includes('__PROMPT_TOOL_TEXT__'))
  assert.ok(!out.includes('__ANCHOR_TEXT__'))
  const doc = parse(out, { logLevel: 'silent' })
  const rows = doc.filter((entry) => entry?.id === 'turn-anchor' || entry?.id === 'prompt-injector')
  assert.deepEqual(rows.map((entry) => entry.id), ['turn-anchor', 'prompt-injector'])
  assert.equal(rows[0].config.anchorText, 'ANCHOR SENTENCE')
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
  assert.ok(!doc.some((entry) => entry?.id === 'prompt-injector'))
})

test('buildCordis injectPrompt=false 且 anchorFirstTurn=true 只生成 turn-anchor', () => {
  const out = buildCordis('PROMPT', { injectPrompt: false, anchorFirstTurn: true, anchorText: 'A' })
  const doc = parse(out, { logLevel: 'silent' })
  const ids = doc.map((entry) => entry?.id)
  assert.ok(ids.includes('tool-bootstrap'))
  assert.ok(ids.includes('turn-anchor'))
  assert.ok(!ids.includes('prompt-injector'))
})
