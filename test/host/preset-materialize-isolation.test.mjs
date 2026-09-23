// 入口行为回归：保存只物化当前预设，补建不改动任何已有目录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

// 隔离 DSH_HOME：paths.ts 模块级常量在 import 时求值，必须先设 env 再动态 import lib。
const home = mkdtempSync(join(tmpdir(), 'pt-preset-isolation-'))
process.env.DSH_HOME = home
const { apply } = await import('../../src/index.ts')

function makeCtx(settingsValue) {
  let onChange
  const makeSctx = () => ({
    settings: {
      describe: () => [],
      configure: () => () => {},
      mutate: async () => {},
    },
    webServer: { register: () => () => {} },
    commands: { register: () => () => {} },
    tools: { register: () => () => {} },
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    on: () => () => {},
    get: () => undefined,
  })
  return {
    config: Object.fromEntries(Object.keys(settingsValue).map((key) => [key, { get: () => settingsValue[key] }])),
    save: () => { settingsValue.presetOrder += 1; onChange() },
    logger: { warn: () => {} },
    effect: (fn) => { fn(); return () => {} },
    on: (event, callback) => { if (event === 'loader/volatile-update') onChange = callback; return () => {} },
    skills: { registerProvider: () => {} },
    get: (name) => (name === 'webServer' ? {} : undefined),
    provide: () => () => {},
    baseUrl: 'http://localhost:3000',
    inject: (deps, cb) => { if (!deps.includes('agentPresets')) cb(makeSctx()); return () => {} },
  }
}

const settings = (presetTemplate) => ({
  writePreset: true,
  presetTemplate,
  skillOrder: [],
  skillsDirs: [],
  skillRankBase: 250,
  presetOrder: 5,
  fallbackText: '',
})

/** 预设参数源：自带一条独有配置，modules 声明为插件格式（否则补建循环会跳过手写预设）。 */
const presetYml = (id, configId, text) => [
  `id: ${id}`,
  `name: ${id}`,
  'modules: [prompt-config-engine]',
  'promptConfigs:',
  `  - id: ${configId}`,
  `    name: ${configId}`,
  '    strategy: static',
  `    text: ${text}`,
  '',
].join('\n')

const readConfigs = (presetDir, id) => {
  const dir = join(presetDir, id, 'prompt-configs')
  if (!existsSync(dir)) return ''
  return readdirSync(dir).map((name) => readFileSync(join(dir, name), 'utf8')).join('\n')
}

test('补建只创建缺失目录，已有非当前预设的定义与资源保持原样', (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const presetDir = join(home, '.agent-presets')
  // 激活预设：有一条独有配置，切换前它是「当前编辑上下文」。
  mkdirSync(join(presetDir, 'anchored'), { recursive: true })
  writeFileSync(join(presetDir, 'anchored', 'preset.yml'), presetYml('anchored', 'anchored-only', 'ANCHORED-ONLY-TEXT'), 'utf8')
  // 已有目录缺组合也不能自动重建；只有切换/保存当前预设才物化。
  mkdirSync(join(presetDir, 'target-preset'), { recursive: true })
  writeFileSync(join(presetDir, 'target-preset', 'preset.yml'), presetYml('target-preset', 'standard-only', 'STANDARD-ONLY-TEXT'), 'utf8')

  const value = settings('anchored')
  const ctx = makeCtx(value)
  apply(ctx, ctx.config)
  assert.equal(readConfigs(presetDir, 'anchored'), '', '启动保留已有目录')
  ctx.save()

  const original = readFileSync(join(presetDir, 'target-preset', 'preset.yml'), 'utf8')
  const target = readConfigs(presetDir, 'target-preset')
  assert.equal(original, presetYml('target-preset', 'standard-only', 'STANDARD-ONLY-TEXT'))
  assert.equal(target, '', '已有非当前预设不自动生成 prompt-configs')
  assert.equal(existsSync(join(presetDir, 'target-preset', 'agent.cordis.yml')), false)

  // 激活预设照常渲染自己的配置（修复不得反向影响当前预设路径）。
  const active = readConfigs(presetDir, 'anchored')
  assert.match(active, /anchored-only/, '激活预设自身配置照常渲染')
  assert.doesNotMatch(active, /standard-only/, '激活预设也不应携带目标预设的配置')
})

test('当前 pt-standard 保存物化自身的变量和能力模块，其他预设不受影响', (t) => {
  const presetDir = join(home, '.agent-presets')
  t.after(() => rmSync(home, { recursive: true, force: true }))
  // B7 T3：载体换成存活模块（原 promoted-code-mode / tool-bootstrap 已随能力删除）。
  for (const [id, value, module] of [
    ['pt-standard', 'ACTIVE', 'tool-git-bash'],
    ['standard', 'OTHER', 'tool-config-engine'],
  ]) {
    mkdirSync(join(presetDir, id), { recursive: true })
    writeFileSync(join(presetDir, id, 'preset.yml'),
      `id: ${id}\nname: ${id}\nmodules: [prompt-config-engine, ${module}]\nvariables:\n  owner: ${value}\n`, 'utf8')
  }
  const other = readFileSync(join(presetDir, 'standard', 'preset.yml'), 'utf8')
  const value = settings('pt-standard')
  const ctx = makeCtx(value)
  apply(ctx, ctx.config)
  assert.equal(existsSync(join(presetDir, 'pt-standard', 'agent.cordis.yml')), false, '启动不重建已有目录')
  ctx.save()
  const rows = parse(readFileSync(join(presetDir, 'pt-standard', 'agent.cordis.yml'), 'utf8'))
  assert.ok(rows.some((row) => row.id === 'tool-git-bash'))
  assert.ok(!rows.some((row) => row.id === 'tool-config-engine'))
  assert.deepEqual(parse(readFileSync(join(presetDir, 'pt-standard', 'prompt-configs', 'variables.yml'), 'utf8')), { owner: 'ACTIVE' })
  assert.equal(readFileSync(join(presetDir, 'standard', 'preset.yml'), 'utf8'), other)
  assert.equal(existsSync(join(presetDir, 'standard', 'agent.cordis.yml')), false)
})
