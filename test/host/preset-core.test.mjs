import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildCordis } from '../../lib/preset-core.mjs'
import { parseFrontmatter } from '../../lib/index.mjs'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

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

test('engine/tool-bootstrap.mjs 已是含共享工具与 PTC 逻辑的引擎模块', () => {
  const source = read('engine/tool-bootstrap.mjs')
  assert.ok(source.includes("from './shared.mjs'"))
  assert.ok(source.includes("tools.presentAs('code')"))
  assert.ok(source.includes('if (usePtcMode) applyCodePresentation(agent)'))
  assert.ok(!source.includes('dev_tool_search'))
  assert.ok(!source.includes('RESIDENT_DISCOVERY_TOOLS'))
})

test('preset/shared.mjs 提供公共晋升解析与消息工具', () => {
  const source = read('engine/shared.mjs')
  assert.ok(source.includes('export const PROMOTE_EVENTS'))
  assert.ok(source.includes('export function parsePromoteOn'))
  assert.ok(source.includes('export function newMessageId'))
  assert.ok(source.includes('export function extractText'))
  assert.ok(source.includes('export function isDelegated'))
})

test('engine/fillers.mjs 内置 instruction-hint 的 agents-instruction.txt 读取逻辑', () => {
  const source = read('engine/fillers.mjs')
  assert.ok(source.includes('new URL(path, import.meta.url)'), '共享引擎下路径经 params.agentsInstructionPath 注入')
  assert.ok(source.includes("agentsInstructionPath"), 'fillers 支持显式路径参数')
  assert.ok(source.includes('agentsInstructionText.length > 0'))
  const facade = read('engine/prompt-config-engine.mjs')
  assert.ok(facade.includes('configsDir'))
  assert.ok(facade.includes('loadPromptConfigFiles'))
  assert.ok(facade.includes('parsePromptConfigYaml'))
})

test('旧独立注入模块已移除：agent.cordis.yml 不再注册 near-anchor/router-guide/prompt-injector/instruction-hint 行', () => {
  const out = buildCordis('PROMPT')
  assert.ok(!out.includes('- id: near-anchor\n'))
  assert.ok(!out.includes('- id: router-guide\n'))
  assert.ok(!out.includes('- id: prompt-injector\n'))
  assert.ok(!out.includes('- id: instruction-hint\n'))
  assert.ok(out.includes('- id: prompt-config-engine\n'))
})
