import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))

/** 子进程隔离验证：官方格式预设（preset.yml 仅元数据 + agent.cordis.yml）导入后可用。 */
test('官方格式预设：无 id 回退目录名，无 modules/composition 回退 agent.cordis.yml 渲染', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-official-'))
  try {
    // 构造官方格式预设（preset.yml 无 id；组合文件在预设目录）。
    const presetDir = join(home, '.agent-presets', 'official-demo')
    mkdirSync(presetDir, { recursive: true })
    writeFileSync(join(presetDir, 'preset.yml'), [
      'name: 官方格式演示',
      'description: preset.yml 仅元数据',
      'order: 7',
      '',
    ].join('\n'), 'utf8')
    writeFileSync(join(presetDir, 'agent.cordis.yml'), [
      '- id: demo-row',
      "  name: '@deepseek-ai/dsh-demo'",
      '',
    ].join('\n'), 'utf8')
    // 官方格式预设可引用模板目录内的本地模块（./xxx.mjs 相对路径）。
    writeFileSync(join(presetDir, 'demo-local.mjs'), 'export function apply() {}\n', 'utf8')

    const script = `
      import { readFileSync, existsSync } from 'node:fs'
      import { join } from 'node:path'
      const { listPresets, writePreset, resolvePresetDir } = await import('./lib/index.mjs')
      const found = listPresets().find((p) => p.id === 'official-demo')
      if (!found) throw new Error('official-demo 未出现在预设清单')
      if (found.name !== '官方格式演示') throw new Error('name 读取错误')
      if (!resolvePresetDir('official-demo').includes('.agent-presets')) throw new Error('resolvePresetDir 未指向预设根')
      const gen = join(process.env.DSH_HOME, '.agent-presets')
      writePreset('PROMPT', {
        presetDir: gen, presetTemplate: 'official-demo', presetOrder: 7,
        firstTurnAnchor: false, firstTurnText: '', firstTurnCustom: false,
        guideText: '', guideCustom: false, injectPrompt: true,
        modelProvider: '', subagentModelProvider: '', subagentModelName: '', modelName: '',
        bootstrapMaxTokens: 0, usePtcMode: true,
        promptConfigs: [],
      })
      const cordis = readFileSync(join(gen, 'official-demo', 'agent.cordis.yml'), 'utf8')
      if (!cordis.includes('demo-row')) throw new Error('组合未回退 agent.cordis.yml')
      if (/__[A-Za-z0-9_]+__/.test(cordis)) throw new Error('存在未解析 token')
      if (!existsSync(join(gen, 'official-demo', 'demo-local.mjs'))) throw new Error('模板目录本地模块未复制到生成目录')
      console.log('OK')
    `
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: rootDir,
      env: { ...process.env, DSH_HOME: home },
      encoding: 'utf8',
    })
    if (res.status !== 0) throw new Error(`probe failed: ${res.stderr || res.stdout}`)
    assert.match(res.stdout, /OK/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

/** bootstrap-filesystem 内嵌编辑器参数化：params 覆盖官方默认 16000。 */
test('官方 bootstrap-filesystem 行：params 覆盖嵌套编辑器 maxOutputChars', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-editor-param-'))
  try {
    const presetDir = join(home, '.agent-presets', 'editor-param')
    mkdirSync(presetDir, { recursive: true })
    writeFileSync(join(presetDir, 'preset.yml'), [
      'id: editor-param',
      'name: 编辑器参数覆盖',
      'modules:',
      '  - bootstrap-filesystem',
      'params:',
      '  strReplaceEditorMaxOutputChars: 32000',
      '',
    ].join('\n'), 'utf8')

    const script = `
      import { readFileSync } from 'node:fs'
      import { join } from 'node:path'
      const { writePreset } = await import('./lib/index.mjs')
      const gen = join(process.env.DSH_HOME, '.agent-presets')
      writePreset('PROMPT', {
        presetDir: gen, presetTemplate: 'editor-param', presetOrder: 1,
        firstTurnAnchor: false, firstTurnText: '', firstTurnCustom: false,
        guideText: '', guideCustom: false, injectPrompt: true,
        modelProvider: '', subagentModelProvider: '', subagentModelName: '', modelName: '',
        bootstrapMaxTokens: 0, usePtcMode: true,
        promptConfigs: [],
      })
      const cordis = readFileSync(join(gen, 'editor-param', 'agent.cordis.yml'), 'utf8')
      if (!cordis.includes('maxOutputChars: 32000')) throw new Error('params 覆盖未生效: ' + cordis)
      if (/__[A-Za-z0-9_]+__/.test(cordis)) throw new Error('存在未解析 token')
      console.log('OK')
    `
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: rootDir,
      env: { ...process.env, DSH_HOME: home },
      encoding: 'utf8',
    })
    if (res.status !== 0) throw new Error(`probe failed: ${res.stderr || res.stdout}`)
    assert.match(res.stdout, /OK/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('旧 str-replace-editor 模块名运行时归一到 bootstrap-filesystem', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-editor-alias-'))
  try {
    const presetDir = join(home, '.agent-presets', 'editor-alias')
    mkdirSync(presetDir, { recursive: true })
    writeFileSync(join(presetDir, 'preset.yml'), [
      'id: editor-alias',
      'name: 旧编辑器别名',
      'modules:',
      '  - str-replace-editor',
      '  - prompt-config-engine',
      '',
    ].join('\n'), 'utf8')

    const script = `
      import { readFileSync } from 'node:fs'
      import { join } from 'node:path'
      import { parse } from 'yaml'
      const { writePreset } = await import('./lib/index.mjs')
      const gen = join(process.env.DSH_HOME, '.agent-presets')
      writePreset('PROMPT', {
        presetDir: gen, presetTemplate: 'editor-alias', presetOrder: 1,
        firstTurnAnchor: false, firstTurnText: '', firstTurnCustom: false,
        guideText: '', guideCustom: false, injectPrompt: true,
        modelProvider: '', subagentModelProvider: '', subagentModelName: '', modelName: '',
        bootstrapMaxTokens: 0, usePtcMode: true, promptConfigs: [],
      })
      const rows = parse(readFileSync(join(gen, 'editor-alias', 'agent.cordis.yml'), 'utf8'))
      if (rows.map((row) => row.id).join(',') !== 'bootstrap-filesystem,prompt-config-engine') {
        throw new Error('旧模块别名未归一: ' + rows.map((row) => row.id).join(','))
      }
      if (rows[0].config.map((row) => row.id).join(',') !== 'fs-local,str-replace-editor') {
        throw new Error('filesystem 子行不完整')
      }
      console.log('OK')
    `
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: rootDir,
      env: { ...process.env, DSH_HOME: home },
      encoding: 'utf8',
    })
    if (res.status !== 0) throw new Error(`probe failed: ${res.stderr || res.stdout}`)
    assert.match(res.stdout, /OK/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
