import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
// 隔离 DSH_HOME：避免真实用户预设（如 .agent-presets/liangshen 官方格式）遮蔽包内模板。
const home = mkdtempSync(join(tmpdir(), 'pt-liangshen-'))
process.env.DSH_HOME = home
const { writePreset } = await import('../../lib/index.mjs')

/** liangshen 单文件预设渲染：全部机制参数化到引擎模块，无本地 .mjs。 */
test('preset/liangshen 渲染：模块清单 + moduleConfigs 表达两阶段锚定', () => {
  const gen = join(home, 'gen')
  try {
    writePreset('PROMPT', {
      presetDir: gen,
      presetTemplate: 'liangshen',
      presetOrder: 4,
      firstTurnAnchor: false,
      firstTurnText: '',
      firstTurnCustom: false,
      guideText: '',
      guideCustom: false,
      injectPrompt: true,
      modelProvider: '', subagentModelProvider: '', subagentModelName: '',
      modelName: '',
      bootstrapMaxTokens: 0,
      usePtcMode: true,
      promptConfigs: [],
    })

    const cordis = readFileSync(join(gen, 'liangshen', 'agent.cordis.yml'), 'utf8')
    assert.ok(!/__[A-Z0-9_]+__/.test(cordis), '无未解析 token')
    const rows = parseYaml(cordis)
    assert.ok(Array.isArray(rows), '组合必须是 YAML 数组')

    const byId = new Map(rows.map((row) => [row.id, row]))

    // 注入控制：context-gate 行（liangshen 拆解后承担 quarantine/deferred/hint）。
    const gate = byId.get('context-gate')
    assert.ok(gate, '应含 context-gate 行')
    assert.deepEqual(gate.config.messageSources, ['user', 'goal'], 'phase-1 消息源白名单')
    assert.deepEqual(gate.config.deferredSources, ['agent-instructions', 'skill-catalog'], '晋升后延迟注入源')
    assert.equal(gate.config.deferredGraceSteps, 1)
    assert.equal(gate.config.instructionHint, true)

    // 两阶段锚定：tool-bootstrap 行（引擎模块，非本地 .mjs）。
    const bootstrap = byId.get('tool-bootstrap')
    assert.ok(bootstrap, '应含 tool-bootstrap 行')
    assert.equal(bootstrap.name, '../.engine/tool-bootstrap.mjs', '指向预设根共享引擎模块而非本地 .mjs')
    assert.deepEqual(bootstrap.config.bootstrapTools, ['bash', 'str_replace_editor'])
    assert.equal(bootstrap.config.promoteGate, true)
    assert.equal(bootstrap.config.maxPromoteSteps, 4)
    assert.equal(bootstrap.config.promoteAfterFirstResponse, true)
    assert.equal(bootstrap.config.bootstrapMaxTokens, 1024)
    assert.equal(bootstrap.config.includeSubagents, true, 'liangshen 源：子代理跟随两阶段相位')
    assert.equal(bootstrap.config.usePtcMode, true)
    assert.equal(bootstrap.config.personaSectionsOnly, true)
    assert.equal(bootstrap.config.workspaceLine, true)
    assert.deepEqual(
      bootstrap.config.compactionTools,
      ['read', 'write', 'edit', 'glob', 'grep', 'todo_write', 'ask_user_question'],
    )

    // persona 已模块化：组合不再含 router-first-turn 行，人设由 promptConfigs 的
    // persona-main（system-section + deployment:persona）承担，非独占。
    assert.equal(byId.get('router-first-turn'), undefined, '组合不应含 router-first-turn 行')

    // 官方工具行：独立 str-replace-editor + 宿主 sandbox 的 tool-fs（无 fs-local）。
    assert.equal(byId.get('str-replace-editor').name, '@deepseek-ai/dsh-tool-str-replace-editor')
    assert.equal(byId.get('str-replace-editor').config.maxOutputChars, 16000)
    assert.ok(byId.get('tool-fs'), '宿主 sandbox 文件工具')
    assert.ok(!rows.some((row) => row.id === 'fs-local'), 'liangshen 不挂 fs-local 裸文件系统')

    // 行序：context-gate 必须 FIRST（waterfall 外层）。
    assert.equal(rows[0].id, 'context-gate', 'context-gate 必须为组合首行')
    assert.equal(rows[1].id, 'tool-bootstrap')

    // 其余官方工具行齐全。
    for (const id of ['agent-instructions', 'persistent-shell', 'custom-bash', 'tool-fs-search', 'tool-jobs', 'skill-filesystem', 'tool-skill', 'tool-goal', 'planning', 'compaction', 'delegation', 'tool-ask-user', 'tool-todo', 'tool-web']) {
      assert.ok(byId.get(id), `应含 ${id} 行`)
    }

    // liangshen 两条提示词配置：prompt-injector（custom-fallback）+ persona-main（主会话人设）。
    const configsDir = join(gen, 'liangshen', 'prompt-configs')
    const configFiles = readdirSync(configsDir).filter((f) => f.endsWith('.yml'))
    assert.deepEqual(configFiles, ['00-prompt-injector.yml', '10-persona-main.yml'])
    const injector = parseYaml(readFileSync(join(configsDir, '00-prompt-injector.yml'), 'utf8'))
    assert.equal(injector.strategy, 'custom-fallback')
    assert.equal(injector.params.firstTurnWord, 'we')
    assert.equal(injector.enabled, true)
    const persona = parseYaml(readFileSync(join(configsDir, '10-persona-main.yml'), 'utf8'))
    assert.equal(persona.params.sectionName, 'deployment:persona')
    assert.equal(persona.params.complete, undefined, 'liangshen 人设非独占')
    assert.equal(injector.promotion, 'main')
  } finally {
    rmSync(gen, { recursive: true, force: true })
  }
})

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})
