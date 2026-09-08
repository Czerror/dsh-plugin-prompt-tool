import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

import { loadPresetSpec, renderComposition } from '../../lib/index.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))

function rowsOf(id) {
  const dir = join(root, 'preset', id)
  return parse(renderComposition(loadPresetSpec(dir), {}, dir), { logLevel: 'silent' })
}

const idsOf = (rows) => rows.map((row) => row.id)

test('内置预设集合移除 liangshen，保留 anchored + 四个官方基型 + custom', () => {
  const dirs = readdirSync(join(root, 'preset'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  assert.deepEqual(dirs, ['anchored', 'creative', 'custom', 'minimal', 'ptc', 'standard'])
  assert.equal(existsSync(join(root, 'preset', 'liangshen')), false)
})

test('standard 对齐官方 Standard，以官方 dsh-persona 行承载人设', () => {
  const ids = idsOf(rowsOf('standard'))
  assert.deepEqual(ids, [
    'persona', 'agent-instructions', 'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search',
    'tool-jobs', 'skill-filesystem', 'tool-skill', 'command-goal', 'tool-goal',
    'planning', 'compaction', 'delegation', 'tool-ask-user', 'tool-todo', 'tool-web', 'prompt-config-engine',
  ])
})

test('ptc 使用官方 alpha.4 呈现与 delegation 变体，不重复挂 code-presentation', () => {
  const rows = rowsOf('ptc')
  const ids = idsOf(rows)
  assert.deepEqual(ids, [
    'persona', 'agent-instructions', 'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search',
    'tool-jobs', 'skill-filesystem', 'tool-skill', 'command-goal', 'tool-goal',
    'planning', 'compaction', 'delegation', 'tool-ask-user', 'tool-todo', 'tool-web',
    'tool-presentation', 'prompt-config-engine',
  ])
  const presentation = rows.find((row) => row.id === 'tool-presentation')
  assert.equal(presentation.config.mode, 'ptc')
  assert.equal(ids.includes('code-presentation'), false, '官方 tool-presentation 已承担 PTC 呈现，不重复注册')
  const delegation = rows.find((row) => row.id === 'delegation')
  assert.equal(delegation.config.find((row) => row.id === 'tool-workflow').disabled, true)
})

test('creative 基础行顺序对齐官方 Cordis，但不再复制 tool-cordis（避免全局 provider 重复注册）', () => {
  const ids = idsOf(rowsOf('creative'))
  assert.deepEqual(ids, [
    'persona', 'agent-instructions', 'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search',
    'tool-jobs', 'command-goal', 'tool-goal', 'planning', 'compaction', 'delegation',
    'tool-ask-user', 'tool-todo', 'tool-web', 'skill-filesystem', 'tool-skill', 'prompt-config-engine',
  ])
  assert.ok(!ids.includes('tool-cordis'), 'tool-cordis 由官方 shipped「创造模式」(cordis) 预设提供')
  const skill = readFileSync(join(root, 'preset/creative/skills/editing-cordis-compositions/SKILL.md'), 'utf8')
  assert.match(skill, /supplies `standard`, `ptc`, `minimal`, and `cordis`/)
  assert.doesNotMatch(skill, /supplies `standard`, `code`, `minimal`/)
})

test('minimal 复用官方 shell 与 filesystem 组合，以顶层 persona 段驱动官方 dsh-persona 行', () => {
  const rows = rowsOf('minimal')
  const ids = idsOf(rows)
  assert.deepEqual(ids, ['persona', 'persistent-shell', 'bootstrap-filesystem', 'prompt-config-engine'])
  const spec = loadPresetSpec(join(root, 'preset', 'minimal'))
  assert.equal(spec.persona.prefix, 'You are a helpful software engineer assistant.')
  assert.equal(spec.persona.complete, true)
  assert.equal(spec.persona.includeRuntimeContext, false)
  const row = rows.find((item) => item.id === 'persona')
  assert.equal(row.name, '@deepseek-ai/dsh-persona')
  assert.deepEqual(row.config, {
    prefix: 'You are a helpful software engineer assistant.',
    complete: true,
    includeRuntimeContext: false,
  })
})

test('anchored 单文件显式声明上游核心与本项目保留差异', () => {
  const rows = rowsOf('anchored')
  const ids = idsOf(rows)
  const gate = rows.find((row) => row.id === 'context-gate')
  const bootstrap = rows.find((row) => row.id === 'tool-bootstrap')
  const delegation = rows.find((row) => row.id === 'delegation')
  const web = rows.find((row) => row.id === 'tool-web')
  assert.equal(gate.config.promoteOn, 'either')
  assert.equal(gate.config.includeSubagents, false, '本项目保留子代理首轮直通')
  assert.deepEqual(bootstrap.config.bootstrapTools, ['bash', 'str_replace_editor'])
  assert.deepEqual(bootstrap.config.compactionTools, ['read', 'write', 'edit', 'glob', 'grep', 'todo_write', 'ask_user_question'])
  assert.equal(bootstrap.config.includeSubagents, false)
  assert.equal(delegation.config.find((row) => row.id === 'tool-subagent').config.modelSelectionSettings, true)
  assert.equal(delegation.config.find((row) => row.id === 'tool-subagent-codex').config.backgroundMode, 'one-shot')
  assert.equal(web.config.fetch, true, '本项目保留 Web fetch 能力')
  for (const id of ['character-tools', 'world-book-tools', 'session-var-tools', 'tool-config-engine']) {
    assert.equal(ids.includes(id), false, `anchored 不应默认装配 ST 工具 ${id}`)
  }
})
