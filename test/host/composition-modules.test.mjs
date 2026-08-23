import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const root = fileURLToPath(new URL('../..', import.meta.url))
const read = (path) => readFileSync(join(root, path), 'utf8')

test('模块清单由参数文件决定:preset/anchored/preset.yml 声明 23 个模块,且全部存在', () => {
  const preset = parse(read('preset/anchored/preset.yml'))
  const modules = preset.modules
  assert.ok(Array.isArray(modules))
  assert.equal(modules.length, 23)
  for (const name of modules) {
    const file = `engine/compositions/library/${name}.yml`
    assert.ok(existsSync(join(root, file)), `missing module ${file}`)
    assert.match(read(file), /^- id:/m, `${name} must be a top-level entry-list module`)
  }
})

test('模块来源可追溯:官方切块带 provenance,本地附加模块单独标记', () => {
  const official = read('engine/compositions/library/persona.yml')
  assert.match(official, /# source: deepseek-harness official standard agent preset \(persona\)/)
  const local = read('engine/compositions/library/context-gate.yml')
  assert.match(local, /本地附加/)
})

test('组合库无 __TOKEN__ 残留：参数桥模块齐备且行默认可解析', () => {
  // 对象桥取代 token 后，library 全部文件都应是合法 YAML（无占位符）。
  const library = readdirSync(join(root, 'engine/compositions/library')).filter((f) => f.endsWith('.yml'))
  for (const file of library) {
    assert.ok(!/__[A-Za-z0-9_]+__/.test(read(join('engine/compositions/library', file))), `${file} 不应含 __TOKEN__`)
  }
  // 参数桥模块：code-presentation（PTC 呈现拆出行）/ tool-filter（掩码）独立存在。
  const presentation = read('engine/compositions/library/code-presentation.yml')
  assert.match(presentation, /- id: code-presentation/)
  assert.match(presentation, /本地附加/)
  assert.ok(existsSync(join(root, 'engine/compositions/library/tool-filter.yml')))
  // 官方行参数化默认保留（str-replace-editor 默认官方值 16000）。
  const editor = read('engine/compositions/library/str-replace-editor.yml')
  assert.match(editor, /maxOutputChars: 16000/)
  const delegation = read('engine/compositions/library/delegation.yml')
  assert.ok(!delegation.includes('__subagentConfig__'))
  const bash = read('engine/compositions/library/tool-bash.yml')
  assert.ok(bash.includes('disabled: true'))
  const filesystem = read('engine/compositions/library/bootstrap-filesystem.yml')
  assert.ok(filesystem.includes('- id: bootstrap-filesystem'))
})
