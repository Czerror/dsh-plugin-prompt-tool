// 补建其他预设时的内容隔离：激活预设的 promptConfigs 覆盖层不得写进目标预设。
//
// 背景（真实事故）：`applyState` 的补建循环为「非激活且需要重渲染」的预设调用
// writePreset 时，原来透传了激活预设的 `options.promptConfigs`（settings 覆盖层）。
// writePreset 把该覆盖层当作最高优先级，于是目标预设的 prompt-configs 被写成激活
// 预设的内容——切换预设后注入的仍是旧预设文本，且组合带上渲染标记后不再重建（固化）。
//
// 观测点在插件入口：补建循环是内部闭包，只有驱动 apply() 才能覆盖调用方传参。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离 DSH_HOME：paths.ts 模块级常量在 import 时求值，必须先设 env 再动态 import lib。
const home = mkdtempSync(join(tmpdir(), 'pt-preset-isolation-'))
process.env.DSH_HOME = home
const { apply, writePluginState } = await import('../../lib/index.mjs')

function makeCtx(settingsValue) {
  const makeSctx = () => ({
    settings: {
      describe: () => [],
      register: (_ns, _schema, opts) => {
        try { opts.base() } catch { /* mock 环境无宿主上下文 */ }
        return { get: () => settingsValue, watch: (cb) => cb(settingsValue) }
      },
      installSection: (_owner, _ns, _schema, _entry, hooks) => {
        hooks.setSource(() => settingsValue)
        hooks.onChange()
      },
      get: () => undefined,
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
    logger: { warn: () => {} },
    effect: (fn) => { fn(); return () => {} },
    on: () => () => {},
    skills: { registerProvider: () => {} },
    get: (name) => (name === 'webServer' ? {} : undefined),
    provide: () => () => {},
    baseUrl: 'http://localhost:3000',
    inject: (deps, cb) => { cb(makeSctx()); return () => {} },
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

test('补建其他预设不得携带激活预设的 promptConfigs（切换目标内容隔离）', (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const presetDir = join(home, '.agent-presets')
  writePluginState({ seeded: true })
  // 激活预设：有一条独有配置，切换前它是「当前编辑上下文」。
  mkdirSync(join(presetDir, 'anchored'), { recursive: true })
  writeFileSync(join(presetDir, 'anchored', 'preset.yml'), presetYml('anchored', 'anchored-only', 'ANCHORED-ONLY-TEXT'), 'utf8')
  // 目标预设：组合缺失 → needsPresetRender 为真 → 走补建循环；自身也有一条独有配置。
  mkdirSync(join(presetDir, 'standard'), { recursive: true })
  writeFileSync(join(presetDir, 'standard', 'preset.yml'), presetYml('standard', 'standard-only', 'STANDARD-ONLY-TEXT'), 'utf8')

  const value = settings('anchored')
  apply(makeCtx(value), value)

  // 目标预设：自身配置保留，激活预设的配置一个字都不能出现。
  const target = readConfigs(presetDir, 'standard')
  assert.match(target, /standard-only/, '目标预设自身配置必须渲染')
  assert.doesNotMatch(target, /anchored-only/, '不得携带激活预设的配置 id')
  assert.doesNotMatch(target, /ANCHORED-ONLY-TEXT/, '不得携带激活预设的配置正文')
  assert.equal(existsSync(join(presetDir, 'standard', 'agent.cordis.yml')), true, '补建应产出可挂载的组合')

  // 激活预设照常渲染自己的配置（修复不得反向影响当前预设路径）。
  const active = readConfigs(presetDir, 'anchored')
  assert.match(active, /anchored-only/, '激活预设自身配置照常渲染')
  assert.doesNotMatch(active, /standard-only/, '激活预设也不应携带目标预设的配置')
})
