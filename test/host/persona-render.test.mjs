import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离 DSH_HOME：lib/index.mjs 顶层解析默认预设根，不能读到真实用户目录。
const home = mkdtempSync(join(tmpdir(), 'pt-persona-home-'))
process.env.DSH_HOME = home
const { removePresetModule, renderComposition } = await import('../../lib/index.mjs')

test('renderComposition：modules 含 persona 的预设按官方 prefix 契约渲染', () => {
  const raw = renderComposition({ id: 'st-style', modules: ['persona'] }, {})
  assert.match(raw, /prefix:/)
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
