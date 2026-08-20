import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
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

test('官方源码重建后的本地参数化补丁仍存在', () => {
  const bootstrap = read('engine/compositions/library/tool-bootstrap.yml')
  assert.ok(bootstrap.includes('usePtcMode: __USE_PTC_MODE__'))
  assert.ok(bootstrap.includes('__BOOTSTRAP_MAX_TOKENS__'))
  const delegation = read('engine/compositions/library/delegation.yml')
  assert.equal((delegation.match(/__SUBAGENT_FLASH__/g) ?? []).length, 2)
  const bash = read('engine/compositions/library/tool-bash.yml')
  assert.ok(bash.includes('disabled: true'))
  const filesystem = read('engine/compositions/library/bootstrap-filesystem.yml')
  assert.ok(filesystem.includes('- id: bootstrap-filesystem'))
})
