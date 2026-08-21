import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerTuiCommand } from '../../lib/index.mjs'

// 隔离 DSH_HOME + 临时预设目录：参数/提示词配置按预设存储（settings 不再承载）。
const home = mkdtempSync(join(tmpdir(), 'pt-tui-home-'))
process.env.DSH_HOME = home
const tuiDir = join(home, 'preset-dir')
mkdirSync(tuiDir, { recursive: true })
writeFileSync(join(tuiDir, 'preset.yml'), [
  'params:',
  '  firstTurnAnchor: true',
  'promptConfigs:',
  '  - id: extra',
  '    name: 额外配置',
  '    enabled: true',
  '    layer: pre-step',
  '    strategy: static',
  '    text: 注入文本',
  '    params: { maxTokens: 4096 }',
  '  - id: sys',
  '    enabled: false',
  '    layer: system-section',
  '    strategy: static',
  '',
].join('\n'), 'utf8')

function makeTui() {
  const commands = []
  const mutations = []
  const savedParams = []
  const sctx = {
    commands: { register(def) { commands.push(def); return () => {} } },
    settings: { mutate: async (_ns, ops) => { mutations.push(ops) } },
  }
  const ctx = { inject(_deps, callback) { callback(sctx) } }
  const source = () => ({
    modelsAvailable: true,
    activeSkillsDirs: ['D:/skills'],
    skillCatalog: [],
    skillSwitches: {},
    ...Object.fromEntries([
      'writeAgents', 'writePreset', 'injectAgentsPrompt',
    ].map((key) => [key, true])),
  })
  registerTuiCommand(
    ctx,
    'prompt-tool',
    source,
    () => ({ available: true, providers: ['deepseek-official'] }),
    () => Promise.resolve({ 'deepseek-official': ['deepseek-v4-flash', 'deepseek-v4-pro'] }),
    () => tuiDir,
    (key, value) => savedParams.push([key, value]),
  )
  const handler = commands[0].handler
  return {
    run: (raw) => handler({ rawInput: raw }),
    mutations,
    savedParams,
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
      modelsAvailable: true, activeSkillsDirs: [], skillCatalog: [], skillSwitches: {},
      writeAgents: true, writePreset: true, injectAgentsPrompt: false,
    })
    registerTuiCommand(ctx, 'prompt-tool', source, () => ({ available: true, providers: [] }), () => Promise.resolve({}), () => dir)
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

test('TUI：/prompt-tool config <id> off 写激活预设 promptConfigs（savePresetParam 回调）', async () => {
  const { run, savedParams } = makeTui()
  const result = await run('config extra off')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已把提示词配置 extra 设为 关/)
  assert.equal(savedParams.length, 1)
  assert.equal(savedParams[0][0], 'promptConfigs')
  const nextConfigs = savedParams[0][1]
  assert.equal(nextConfigs.find((config) => config.id === 'extra').enabled, false)
  assert.equal(nextConfigs.find((config) => config.id === 'sys').enabled, false)
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

test('TUI：参数开关切换走 savePresetParam 回调，全局开关仍走 settings mutate', async () => {
  const { run, mutations, savedParams } = makeTui()
  const paramResult = await run('toggle firstTurnAnchor')
  assert.equal(paramResult.kind, 'success')
  assert.equal(savedParams.length, 1)
  assert.equal(savedParams[0][0], 'firstTurnAnchor')
  assert.equal(savedParams[0][1], false)
  assert.equal(mutations.length, 0, '参数开关不应写 settings')
  const globalResult = await run('toggle writeAgents')
  assert.equal(globalResult.kind, 'success')
  assert.equal(mutations.length, 1)
  assert.deepEqual(mutations[0][0].path, ['writeAgents'])
  assert.equal(savedParams.length, 1, '全局开关不应走参数回调')
})

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})
