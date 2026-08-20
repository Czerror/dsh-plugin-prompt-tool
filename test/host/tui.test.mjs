import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerTuiCommand } from '../../lib/index.mjs'

const promptConfigs = [
  { id: 'extra', name: '额外配置', enabled: true, layer: 'pre-step', strategy: 'static', text: '注入文本', params: { maxTokens: 4096 } },
  { id: 'sys', enabled: false, layer: 'system-section', strategy: 'static' },
]

function makeTui() {
  const commands = []
  const mutations = []
  const sctx = {
    commands: { register(def) { commands.push(def); return () => {} } },
    settings: { mutate: async (_ns, ops) => { mutations.push(ops) } },
  }
  const ctx = { inject(_deps, callback) { callback(sctx) } }
  const source = () => ({
    firstTurnText: '',
    deepseekAvailable: true,
    subagentFlashProvider: '',
    subagentFlashModel: '',
    bootstrapMaxTokens: 0,
    activeSkillsDir: 'D:/skills',
    skillCatalog: [],
    skillSwitches: {},
    promptConfigs,
    ...Object.fromEntries([
      'writeAgents', 'writePreset', 'injectPrompt', 'injectAgentsPrompt', 'firstTurnAnchor',
      'firstTurnCustom', 'guideCustom', 'usePtcMode',
    ].map((key) => [key, true])),
  })
  registerTuiCommand(ctx, 'prompt-tool', source, () => true, () => ({ available: true, providers: ['deepseek-official'] }))
  const handler = commands[0].handler
  return {
    run: (raw) => handler({ rawInput: raw }),
    mutations,
  }
}

test('TUI：/prompt-tool status 列出提示词配置行', async () => {
  const { run } = makeTui()
  const result = await run('status')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /config extra\s+开  layer=pre-step strategy=static/)
  assert.match(result.text, /config sys\s+关  layer=system-section strategy=static/)
})

test('TUI：presetDir 提供时 status 显示生成目录实际配置（settings 空也非 0 配置）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-tool-tui-'))
  try {
    mkdirSync(join(dir, 'prompt-configs'), { recursive: true })
    writeFileSync(join(dir, 'prompt-configs', '00-real.yml'),
      'id: real-config\nname: 实际配置\nenabled: true\nlayer: pre-step\nstrategy: static\ntext: T\n')
    const commands = []
    const sctx = {
      commands: { register(def) { commands.push(def); return () => {} } },
      settings: { mutate: async () => {} },
    }
    const ctx = { inject(_deps, callback) { callback(sctx) } }
    const source = () => ({
      firstTurnText: '', deepseekAvailable: true, subagentFlashProvider: '', subagentFlashModel: '',
      bootstrapMaxTokens: 0, activeSkillsDir: '', skillCatalog: [], skillSwitches: {}, promptConfigs: [],
      writeAgents: true, writePreset: true, injectPrompt: true, injectAgentsPrompt: false,
      firstTurnAnchor: true, firstTurnCustom: false, guideCustom: false, usePtcMode: true,
    })
    registerTuiCommand(ctx, 'prompt-tool', source, () => true, () => ({ available: true, providers: [] }), () => dir)
    const result = await commands[0].handler({ rawInput: 'status' })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /config real-config\s+开/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TUI：/prompt-tool config <id> 渲染单条详情含 params JSON', async () => {
  const { run } = makeTui()
  const result = await run('config extra')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /提示词配置 extra/)
  assert.match(result.text, /params\s+\{"maxTokens":4096\}/)
  assert.match(result.text, /注入文本/)
})

test('TUI：/prompt-tool config <id> off 写回 settings.promptConfigs 数组', async () => {
  const { run, mutations } = makeTui()
  const result = await run('config extra off')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已把提示词配置 extra 设为 关/)
  assert.equal(mutations.length, 1)
  assert.deepEqual(mutations[0][0].path, ['promptConfigs'])
  assert.equal(mutations[0][0].value.find((config) => config.id === 'extra').enabled, false)
  assert.equal(mutations[0][0].value.find((config) => config.id === 'sys').enabled, false)
})

test('TUI：未知 id 与缺 id 分别给出错误与用法', async () => {
  const { run } = makeTui()
  const missing = await run('config nope')
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /未找到提示词配置 nope/)
  const usage = await run('config')
  assert.equal(usage.kind, 'error')
  assert.match(usage.text, /\/prompt-tool config <id>/)
})
