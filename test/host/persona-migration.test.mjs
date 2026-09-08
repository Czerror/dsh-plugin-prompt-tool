import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离 DSH_HOME：lib/index.mjs 顶层解析默认预设根，不能读到真实用户目录。
const home = mkdtempSync(join(tmpdir(), 'pt-persona-home-'))
process.env.DSH_HOME = home
const { migratePersonaLoaderConfig, removePresetModule, renderComposition } = await import('../../lib/index.mjs')

test('migratePersonaLoaderConfig：旧 text 改为 required prefix，保留注释与其余行', () => {
  const raw = [
    '# header comment',
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    '    text: You are a helpful software engineer assistant.',
    '',
    '- id: tool-filter',
    '  name: ../.engine/tool-filter.mjs',
    '',
  ].join('\n')
  const out = migratePersonaLoaderConfig(raw)
  assert.match(out, /# header comment/)
  assert.match(out, /prefix: You are a helpful software engineer assistant\./)
  assert.doesNotMatch(out, /^\s+text:/m, '旧 text 字段应被移除')
  assert.match(out, /tool-filter/, '其余组合行原样保留')
})

test('migratePersonaLoaderConfig：新契约组合与非 persona 组合原样返回', () => {
  const fresh = "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    prefix: hi\n"
  assert.equal(migratePersonaLoaderConfig(fresh), fresh)
  const unrelated = '- id: tool-filter\n  name: ./tool-filter.mjs\n'
  assert.equal(migratePersonaLoaderConfig(unrelated), unrelated)
})

test('renderComposition：modules 含 persona 的预设渲染出新 prefix 契约', () => {
  const raw = renderComposition({ id: 'st-style', modules: ['persona'] }, {})
  assert.match(raw, /prefix:/)
  assert.doesNotMatch(raw, /^\s+text:/m)
})

test('renderComposition：手写旧 text 组合渲染时迁移为 prefix', () => {
  const legacy = "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    text: hi\n"
  const raw = renderComposition({ id: 'legacy', composition: legacy }, {})
  assert.match(raw, /prefix: hi/)
  assert.doesNotMatch(raw, /^\s+text:/m)
})

test('removePresetModule：从 modules 清单移除模块并保留其余字段与注释', () => {
  const dir = join(home, '.agent-presets', 'sample')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'preset.yml'), [
    '# 用户注释',
    'name: 样例',
    'modules:',
    '  - keep-a',
    '  - official-tool-cordis',
    '  - keep-b',
    'params:',
    '  maxDepth: ""',
    '',
  ].join('\n'))
  assert.equal(removePresetModule(dir, 'official-tool-cordis'), true)
  const out = readFileSync(join(dir, 'preset.yml'), 'utf8')
  assert.doesNotMatch(out, /official-tool-cordis/)
  assert.match(out, /# 用户注释/)
  assert.match(out, /keep-a/)
  assert.match(out, /keep-b/)
  assert.match(out, /maxDepth/)
  assert.equal(removePresetModule(dir, 'official-tool-cordis'), false, '重复调用应为 no-op')
})

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})
