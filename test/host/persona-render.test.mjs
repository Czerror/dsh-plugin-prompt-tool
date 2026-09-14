import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

// 隔离 DSH_HOME：lib/index.mjs 顶层解析默认预设根，不能读到真实用户目录。
const home = mkdtempSync(join(tmpdir(), 'pt-persona-home-'))
process.env.DSH_HOME = home
const { removePresetModule, renderComposition } = await import('../../lib/index.mjs')

test('renderComposition：人设直接来自预设字段，不存在 persona 模块入口', () => {
  const persona = { prefix: 'USER PERSONA', suffix: 'USER SUFFIX', complete: true, includeRuntimeContext: false }
  const spec = { id: 'st-style', modules: [], persona }
  const rows = parse(renderComposition(spec, {}))
  assert.deepEqual(rows, [{ id: 'persona', name: '@deepseek-ai/dsh-persona', config: persona }])
  assert.deepEqual(spec.modules, [], '渲染不向预设模块清单补回 persona')
  assert.deepEqual(parse(renderComposition({ id: 'empty', modules: [] }, {})), [])
  assert.throws(() => renderComposition({ id: 'old-module', modules: ['persona'] }, {}), /persona.*not found/)
})

test('renderComposition：已撤销模块名全部拒绝，不补别名或改写模块清单', () => {
  const removed = ['persona', 'official-agent-instructions', 'official-tool-bash', 'official-tool-skill',
    'official-persistent-shell', 'official-tool-presentation', 'official-tool-cordis',
    'official-skill-filesystem-cordis', 'present', 'bootstrap-filesystem', 'custom-bash',
    'code-presentation', 'cot-drip', 'str-replace-editor']
  for (const name of removed) {
    const spec = { id: 'obsolete', modules: [name] }
    assert.throws(() => renderComposition(spec, {}), /composition module .* not found/, name)
    assert.deepEqual(spec.modules, [name], '不迁移调用者的模块清单')
  }
})

test('renderComposition：空人设不继承标准库默认文本，ST 段保持开放', () => {
  const rows = parse(renderComposition({ id: 'st', modules: ['prompt-config-engine'], persona: { prefix: '', complete: false } }, {}))
  assert.equal(rows.filter((row) => row.name === '@deepseek-ai/dsh-persona').length, 1)
  assert.deepEqual(rows[0].config, { prefix: '' })
})

test('removePresetModule：从 modules 清单移除模块并保留其余字段与注释', () => {
  const dir = join(home, '.agent-presets', 'sample')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'preset.yml'), [
    '# 用户注释',
    'name: 样例',
    'modules:',
    '  - keep-a',
    '  - tool-cordis',
    '  - keep-b',
    'params:',
    '  maxDepth: ""',
    '',
  ].join('\n'))
  assert.equal(removePresetModule(dir, 'tool-cordis'), true)
  const out = readFileSync(join(dir, 'preset.yml'), 'utf8')
  assert.doesNotMatch(out, /tool-cordis/)
  assert.match(out, /# 用户注释/)
  assert.match(out, /keep-a/)
  assert.match(out, /keep-b/)
  assert.match(out, /maxDepth/)
  assert.equal(removePresetModule(dir, 'tool-cordis'), false, '重复调用应为 no-op')
})

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})
