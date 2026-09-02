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

function assertPrefix(actual, expected, label) {
  assert.deepEqual(actual.slice(0, expected.length), expected, `${label} 官方基础行顺序漂移`)
}

test('内置预设集合移除 liangshen，保留 anchored + 四个官方基型 + custom', () => {
  const dirs = readdirSync(join(root, 'preset'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  assert.deepEqual(dirs, ['anchored', 'creative', 'custom', 'minimal', 'ptc', 'standard'])
  assert.equal(existsSync(join(root, 'preset', 'liangshen')), false)
})

test('standard 基础行顺序对齐官方 Standard，再追加 prompt-tool 模块', () => {
  const ids = idsOf(rowsOf('standard'))
  assertPrefix(ids, [
    'agent-instructions', 'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search',
    'tool-jobs', 'skill-filesystem', 'tool-skill', 'command-goal', 'tool-goal',
    'planning', 'compaction', 'delegation', 'tool-ask-user', 'tool-todo', 'tool-web',
  ], 'standard')
  assert.ok(ids.includes('prompt-config-engine'))
  assert.ok(ids.includes('code-presentation'), 'standard 保留 prompt-tool 晋升后 PTC opt-in 行')
})

test('ptc 使用官方 alpha.4 呈现与 delegation 变体，不重复挂 code-presentation', () => {
  const rows = rowsOf('ptc')
  const ids = idsOf(rows)
  assertPrefix(ids, [
    'agent-instructions', 'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search',
    'tool-jobs', 'skill-filesystem', 'tool-skill', 'command-goal', 'tool-goal',
    'planning', 'compaction', 'delegation', 'tool-ask-user', 'tool-todo', 'tool-web',
    'tool-presentation',
  ], 'ptc')
  const presentation = rows.find((row) => row.id === 'tool-presentation')
  assert.equal(presentation.config.mode, 'ptc')
  assert.equal(ids.includes('code-presentation'), false, '官方 tool-presentation 已承担 PTC 呈现，不重复注册')
  const delegation = rows.find((row) => row.id === 'delegation')
  assert.equal(delegation.config.find((row) => row.id === 'tool-workflow').disabled, true)
})

test('creative 基础行顺序对齐官方 Cordis，创作技能位于 tool-cordis 之后', () => {
  const ids = idsOf(rowsOf('creative'))
  assertPrefix(ids, [
    'agent-instructions', 'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search',
    'tool-jobs', 'command-goal', 'tool-goal', 'planning', 'compaction', 'delegation',
    'tool-ask-user', 'tool-todo', 'tool-web', 'tool-cordis', 'skill-filesystem', 'tool-skill',
  ], 'creative')
  const skill = readFileSync(join(root, 'preset/creative/skills/editing-cordis-compositions/SKILL.md'), 'utf8')
  assert.match(skill, /supplies `standard`, `ptc`, `minimal`, and `cordis`/)
  assert.doesNotMatch(skill, /supplies `standard`, `code`, `minimal`/)
})

test('minimal 基础行对齐官方 Minimal；persona 继续由单文件配置卡表达', () => {
  const ids = idsOf(rowsOf('minimal'))
  assert.deepEqual(ids.slice(0, 2), ['persistent-shell', 'bootstrap-filesystem'])
  assert.equal(ids.includes('persona'), false)
  const spec = loadPresetSpec(join(root, 'preset', 'minimal'))
  const persona = spec.promptConfigs.find((config) => config.id === 'persona-main')
  assert.equal(persona.text, 'You are a helpful software engineer assistant.')
  assert.equal(persona.params.complete, true)
  assert.equal(persona.params.suppressRuntimeContext, true)
})

test('anchored 单文件显式声明上游核心与本项目保留差异', () => {
  const rows = rowsOf('anchored')
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
})
