import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const root = fileURLToPath(new URL('../..', import.meta.url))
const compositionRoot = join(root, 'engine/compositions')
const localDir = join(compositionRoot, 'source/local')
const libraryDir = join(compositionRoot, 'library')
const read = (path) => readFileSync(join(root, path), 'utf8')
const namesOf = (dir) => readdirSync(dir).filter((file) => file.endsWith('.yml')).map((file) => file.slice(0, -4)).sort()
const modulePath = (name) => {
  const candidates = [join(localDir, `${name}.yml`), join(libraryDir, `${name}.yml`)].filter((file) => existsSync(file))
  assert.equal(candidates.length, 1, `${name} 必须只存在于 source/local 或 library 其中一处`)
  return candidates[0]
}
const moduleText = (name) => readFileSync(modulePath(name), 'utf8')

 test('模块清单由参数文件决定:preset/anchored/preset.yml 声明 30 个模块,且全部存在', () => {
  const preset = parse(read('preset/anchored/preset.yml'))
  const modules = preset.modules
  assert.ok(Array.isArray(modules))
  assert.equal(modules.length, 30)
  assert.ok(modules.includes('command-goal'), '官方 standard 系预设应接入 command-goal')
  assert.ok(modules.includes('character-tools'), '角色卡工具由独立模块装配')
  assert.ok(modules.includes('world-book-tools'), '世界书工具由独立模块装配')
  assert.ok(modules.includes('session-var-tools'), '会话变量工具由独立模块装配')
  for (const name of modules) {
    const file = modulePath(name)
    assert.match(readFileSync(file, 'utf8'), /^- id:/m, `${name} must be a top-level entry-list module`)
  }
})

test('组合源与生成库职责分离：本地模块不复制到 library', () => {
  const local = new Set(namesOf(localDir))
  const library = new Set(namesOf(libraryDir))
  const overlap = [...local].filter((name) => library.has(name)).sort()
  assert.deepEqual(overlap, [], 'source/local 与 library 不得存在同名模块')

  for (const name of local) {
    const rows = parse(moduleText(name), { logLevel: 'silent' })
    assert.ok(Array.isArray(rows) && rows.length === 1, `source/local/${name}.yml 必须且仅含一个顶层行`)
    assert.equal(rows[0].id, name, `source/local/${name}.yml 文件名与行 id 必须一致`)
  }
  for (const name of library) {
    const rows = parse(moduleText(name), { logLevel: 'silent' })
    assert.ok(Array.isArray(rows) && rows.length === 1, `library/${name}.yml 必须且仅含一个顶层行`)
  }
})

test('模块来源可追溯：官方切块、本地源和通用 instruction-hint 各有明确归属', () => {
  const official = read('engine/compositions/library/official-agent-instructions.yml')
  assert.match(official, /# source: .*agent-presets\/presets\/standard\/agent\.cordis\.yml/)
  const ptc = read('engine/compositions/library/delegation-ptc.yml')
  assert.match(ptc, /# source: .*agent-presets\/presets\/ptc\/agent\.cordis\.yml/)
  const local = read('engine/compositions/source/local/context-gate.yml')
  assert.match(local, /source\/local\/context-gate\.yml/)
  assert.ok(existsSync(join(root, 'engine/instruction-hint.mjs')), 'instruction-hint 必须位于通用 engine 根目录')
  assert.ok(existsSync(join(root, 'engine/compositions/library/persona.yml')), '动态 ST 转换仍需 persona 模块')
})

test('官方行变体仅保留确有语义差异的重复行', () => {
  const owners = new Map()
  for (const file of namesOf(libraryDir)) {
    const rows = parse(moduleText(file), { logLevel: 'silent' })
    const id = rows[0].id
    if (!owners.has(id)) owners.set(id, [])
    owners.get(id).push(file)
  }
  const duplicates = Object.fromEntries([...owners]
    .filter(([, files]) => files.length > 1)
    .map(([id, files]) => [id, files.sort()]))
  assert.deepEqual(duplicates, {
    delegation: ['delegation', 'delegation-ptc'],
    'persistent-shell': ['official-persistent-shell', 'persistent-shell'],
    'skill-filesystem': ['official-skill-filesystem-cordis', 'skill-filesystem'],
    'tool-bash': ['official-tool-bash', 'tool-bash'],
  })
})

test('组合库无 __TOKEN__ 残留：参数桥模块齐备且官方 alpha.4 变体已更新', () => {
  for (const dir of [localDir, libraryDir]) {
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.yml'))) {
      const content = readFileSync(join(dir, file), 'utf8')
      assert.doesNotMatch(content, /^# source: (?:[A-Za-z]:[\\/]|\/)/m, file + ' 不得写入本机绝对 source 路径')
      assert.ok(!/__[A-Za-z0-9_]+__/.test(content), `${file} 不应含 __TOKEN__`)
    }
  }
  const presentation = parse(read('engine/compositions/library/official-tool-presentation.yml'), { logLevel: 'silent' })[0]
  assert.equal(presentation.config.mode, 'ptc', 'alpha.4 官方 PTC mode 名为 ptc')
  const ptcDelegation = parse(read('engine/compositions/library/delegation-ptc.yml'), { logLevel: 'silent' })[0]
  const workflow = ptcDelegation.config.find((row) => row.id === 'tool-workflow')
  assert.equal(workflow.disabled, true, 'PTC 不暴露第二个模型编排面 workflow')
  const editor = read('engine/compositions/source/local/str-replace-editor.yml')
  assert.match(editor, /maxOutputChars: 16000/)
  const delegation = read('engine/compositions/library/delegation.yml')
  assert.match(delegation, /modelSelectionSettings: true/)
  assert.match(delegation, /backgroundMode: one-shot/)
  const bash = read('engine/compositions/library/tool-bash.yml')
  assert.ok(bash.includes('disabled: true'))
  const pwsh = read('engine/compositions/library/tool-pwsh.yml')
  assert.match(pwsh, /disabled: !!js process\.platform !== 'win32'/, '普通 pwsh 只在 Windows 启用')
  const persistentShell = read('engine/compositions/library/persistent-shell.yml')
  assert.match(persistentShell, /- id: persistent-shell[\s\S]*?group: true\s+disabled: !!js process\.platform === 'win32'\s+isolate:/,
    'anchored persistent-shell 整组必须在 Windows 禁用，避免与普通 tool-pwsh 重复注册 pwsh')
  assert.match(persistentShell, /shellPath: !!js/, 'anchored bash PTY 保留 /bin/bash → PATH 回退')
  const filesystem = read('engine/compositions/library/bootstrap-filesystem.yml')
  assert.ok(filesystem.includes('- id: bootstrap-filesystem'))
})
