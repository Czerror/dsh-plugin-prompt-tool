// 合并自 composition-modules.test.mjs(5) + composition-source.test.mjs(3) + rebuild-composition.test.mjs(4)
//（2026-09-17 测试归一精简 Wave 2）：三者同属「组合库与官方来源」主题，顶层常量与 helper 名字零冲突，
//  因此原样保留各文件自己的常量，仅共用一套 import 与测试运行器。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parse } from 'yaml'
import { OFFICIAL_UPSTREAM, PRESET_SKILLS_PATH, PRESET_SOURCE_PATH, verifyLatestCompositionSource } from '../../scripts/composition-source.mjs'

// —— 组合库结构（原 composition-modules.test.mjs） ——

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

test('全部内置预设声明的模块都存在，且为合法 entry-list 模块', () => {
  const presetRoot = join(root, 'preset')
  const presetDirs = readdirSync(presetRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  assert.ok(presetDirs.length > 0, '至少存在一个内置预设')
  for (const dir of presetDirs) {
    const preset = parse(read(`preset/${dir}/preset.yml`), { logLevel: 'silent' })
    const modules = preset.modules
    if (!Array.isArray(modules)) continue
    for (const name of modules) {
      const file = modulePath(name)
      assert.match(readFileSync(file, 'utf8'), /^- id:/m, `${dir}: ${name} must be a top-level entry-list module`)
    }
  }
  const standard = parse(read('preset/pt-standard/preset.yml'), { logLevel: 'silent' })
  assert.ok(standard.modules.includes('command-goal'), '官方 standard 系预设应接入 command-goal')
  for (const name of ['character-tools', 'world-book-tools', 'session-var-tools', 'tool-config-engine']) {
    assert.equal(standard.modules.includes(name), false, `${name} 只由 ST 转换按需装配`)
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
  const official = read('engine/compositions/library/agent-instructions.yml')
  assert.match(official, /# source: .*web-app\/presets\/standard\.patch\.yml/)
  const ptc = read('engine/compositions/library/delegation-ptc.yml')
  assert.match(ptc, /# source: .*web-app\/presets\/ptc\.patch\.yml/)
  const local = read('engine/compositions/source/local/instruction-hint.yml')
  assert.match(local, /source\/local\/instruction-hint\.yml/)
  assert.ok(existsSync(join(root, 'engine/instruction-hint.mjs')), 'instruction-hint 必须位于通用 engine 根目录')
  assert.equal(existsSync(join(libraryDir, 'persona.yml')), false, '人设只由顶层 persona 字段提供，不保留模块')
  assert.equal(existsSync(join(localDir, 'persona.yml')), false, 'persona 不转移为本地模块')
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
    'skill-filesystem': ['skill-filesystem', 'skill-filesystem-cordis'],
    'tool-plugin-manager': ['tool-plugin-manager', 'tool-plugin-manager-disabled'],
  })
  for (const name of [
    'official-agent-instructions', 'official-tool-bash', 'official-tool-skill',
    'official-persistent-shell', 'official-tool-presentation', 'official-tool-cordis',
    'official-skill-filesystem-cordis', 'present', 'official-filesystem', 'persona-cordis', 'persona-minimal',
  ]) {
    assert.equal(existsSync(join(libraryDir, `${name}.yml`)), false, `${name} 不应重复切分官方基型已有行`)
  }
})

test('组合库无 __TOKEN__ 残留：参数桥模块齐备且官方 alpha.4 变体已更新', () => {
  for (const dir of [localDir, libraryDir]) {
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.yml'))) {
      const content = readFileSync(join(dir, file), 'utf8')
      assert.doesNotMatch(content, /^# source: (?:[A-Za-z]:[\\/]|\/)/m, file + ' 不得写入本机绝对 source 路径')
      assert.ok(!/__[A-Za-z0-9_]+__/.test(content), `${file} 不应含 __TOKEN__`)
    }
  }
  const presentation = parse(read('engine/compositions/library/tool-presentation.yml'), { logLevel: 'silent' })[0]
  assert.equal(presentation.config.mode, 'ptc', 'alpha.4 官方 PTC mode 名为 ptc')
  const present = parse(read('engine/compositions/library/tool-present.yml'), { logLevel: 'silent' })[0]
  assert.equal(present.id, 'present', 'tool-present 模块保留官方 present row id')
  const ptcDelegation = parse(read('engine/compositions/library/delegation-ptc.yml'), { logLevel: 'silent' })[0]
  const workflow = ptcDelegation.config.find((row) => row.id === 'tool-workflow')
  assert.equal(workflow.disabled, true, 'PTC 不暴露第二个模型编排面 workflow')
  assert.equal(existsSync(join(localDir, 'str-replace-editor.yml')), false, '编辑器不再作为独立 local 模块')
  const delegation = read('engine/compositions/library/delegation.yml')
  assert.match(delegation, /modelSelectionSettings: true/)
  assert.match(delegation, /backgroundMode: one-shot/)
  const bash = parse(read('engine/compositions/source/local/tool-bash-disabled.yml'), { logLevel: 'silent' })[0]
  assert.equal(bash.id, 'tool-bash-disabled')
  assert.equal(bash.name, '@deepseek-ai/dsh-tool-bash')
  assert.equal(bash.disabled, true)
  const pwsh = read('engine/compositions/library/tool-pwsh.yml')
  assert.match(pwsh, /disabled: !!js process\.platform !== 'win32'/, '普通 pwsh 只在 Windows 启用')
  const persistentShell = read('engine/compositions/source/local/persistent-shell-posix.yml')
  assert.match(persistentShell, /- id: persistent-shell-posix[\s\S]*?group: true\s+disabled: !!js process\.platform === 'win32'\s+isolate:/,
    'persistent-shell-posix 整组必须在 Windows 禁用，避免与普通 tool-pwsh 重复注册 pwsh')
  assert.match(persistentShell, /shellPath: !!js/, 'persistent-shell-posix 的 bash PTY 保留 /bin/bash → PATH 回退')
  const shellRows = parse(persistentShell, { logLevel: 'silent' })[0]
  assert.equal(shellRows.isolate.terminals, true)
  assert.deepEqual(shellRows.config.map((row) => row.id), ['pty', 'terminal-bash', 'persistent-bash', 'terminal-pwsh', 'persistent-pwsh'])
  // rc.2 官方 minimal 已无 filesystem 行：该能力只由显式声明本地模块的预设装配。
  const filesystem = read('engine/compositions/source/local/filesystem-editor.yml')
  const filesystemRows = parse(filesystem, { logLevel: 'silent' })
  assert.equal(filesystemRows.length, 1)
  assert.equal(filesystemRows[0].id, 'filesystem-editor')
  assert.equal(filesystemRows[0].group, true)
  assert.equal(filesystemRows[0].isolate.fs, true)
  assert.deepEqual(filesystemRows[0].config.map((row) => row.id), ['fs-local', 'str-replace-editor'])
  assert.equal(filesystemRows[0].config[1].config.maxOutputChars, 16000)
})

// —— 官方来源校验（原 composition-source.test.mjs） ——

const sha = 'a'.repeat(40)
const repo = 'D:/isolated/upstream'
const fakeGit = (head = sha, dirty = '', remote = `${sha}\trefs/heads/master`) => (args) => {
  if (args[0] === 'ls-remote') {
    assert.deepEqual(args, ['ls-remote', OFFICIAL_UPSTREAM, 'refs/heads/master'])
    return remote
  }
  assert.deepEqual(args.slice(0, 2), ['-C', repo])
  if (args[2] === 'rev-parse') return head
  assert.deepEqual(args.slice(2), ['status', '--porcelain', '--untracked-files=all', '--', PRESET_SOURCE_PATH, PRESET_SKILLS_PATH])
  return dirty
}

test('官方来源：接受已核验最新 HEAD，不绑定发布版本号', () => {
  assert.deepEqual(verifyLatestCompositionSource(repo, fakeGit()), { label: 'master', commit: sha })
  const next = 'b'.repeat(40)
  assert.deepEqual(verifyLatestCompositionSource(repo, fakeGit(next, '', `${next}\trefs/heads/master`)), { label: 'master', commit: next })
})

test('官方来源：过期 checkout、预设局部修改和未知远端均拒绝', () => {
  assert.throws(() => verifyLatestCompositionSource(repo, fakeGit('b'.repeat(40))), /source is stale/)
  assert.throws(() => verifyLatestCompositionSource(repo, fakeGit(sha, ' M packages/preset/agent-presets/presets/standard/agent.cordis.yml')), /local changes/)
  assert.throws(() => verifyLatestCompositionSource(repo, fakeGit(sha, '', '')), /invalid remote HEAD/)
  assert.throws(() => verifyLatestCompositionSource(repo, fakeGit(sha, '', `${sha}\trefs/heads/release`)), /invalid remote HEAD/)
})

test('官方来源：网络核验失败不能回落旧版本或继续生成', () => {
  assert.throws(() => verifyLatestCompositionSource(repo, () => { throw new Error('offline') }), /offline/)
})

// —— 分发库快照与重建脚本（原 rebuild-composition.test.mjs） ——

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
/** 离线复验最近一次同步的上游快照，不固定发布版本或请求实时网络。 */
const FIXTURE = join(ROOT, 'test', 'fixtures', 'dsh', 'current')
const FIXTURE_PRESETS = join(FIXTURE, PRESET_SOURCE_PATH)
const SCRIPT = join(ROOT, 'scripts', 'rebuild-composition.mjs')

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pt-rebuild-composition-'))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  cpSync(SCRIPT, join(root, 'scripts', 'rebuild-composition.mjs'))
  cpSync(join(ROOT, 'scripts', 'composition-source.mjs'), join(root, 'scripts', 'composition-source.mjs'))
  cpSync(join(ROOT, 'engine', 'compositions'), join(root, 'engine', 'compositions'), { recursive: true })
  cpSync(join(ROOT, 'preset'), join(root, 'preset'), { recursive: true })
  cpSync(join(ROOT, 'node_modules', 'yaml'), join(root, 'node_modules', 'yaml'), { recursive: true })
  return root
}

function upstreamFixture(root) {
  const target = join(root, 'upstream')
  cpSync(join(FIXTURE, 'packages'), join(target, 'packages'), { recursive: true })
  return target
}

function run(root, upstream) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'rebuild-composition.mjs'), upstream], {
    cwd: root,
    encoding: 'utf8',
  })
}

function listFixtureFiles(dir, prefix = '') {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...listFixtureFiles(join(dir, entry.name), relative))
    else files.push(relative)
  }
  return files
}

test('当前上游快照与 PROVENANCE 指纹一致，提交可更新但不能伪造来源', () => {
  const provenance = readFileSync(join(FIXTURE, 'PROVENANCE.md'), 'utf8')
  const listed = new Map()
  for (const match of provenance.matchAll(/^\| `([^`]+)` \| (\d+) \| `([0-9a-f]{64})` \|$/gm)) {
    listed.set(match[1], { size: Number(match[2]), sha256: match[3] })
  }
  assert.ok(listed.size >= 4, 'PROVENANCE 必须列出全部 fixture 文件')

  const actual = listFixtureFiles(join(FIXTURE, 'packages'))
  for (const relative of actual) {
    const entry = listed.get(relative)
    assert.ok(entry !== undefined, `${relative} 未登记在 PROVENANCE.md`)
    const bytes = readFileSync(join(FIXTURE, 'packages', relative))
    assert.equal(bytes.length, entry.size, `${relative} 字节数与固定输入不符`)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${relative} 内容与固定输入不符`)
  }
  for (const relative of listed.keys()) {
    assert.ok(actual.includes(relative), `PROVENANCE 登记的 ${relative} 在 fixture 中缺失`)
  }
  assert.match(provenance, /来源提交：`[0-9a-f]{40}`/, 'PROVENANCE 必须记录实际来源提交')
  assert.match(provenance, /来源分支：`master`/)
})

test('分发库记录当前上游快照的实际提交，不沿用旧发布版本出处', () => {
  const provenance = readFileSync(join(FIXTURE, 'PROVENANCE.md'), 'utf8')
  const commit = /来源提交：`([0-9a-f]{40})`/.exec(provenance)?.[1]
  assert.ok(commit)
  const library = join(ROOT, 'engine', 'compositions', 'library')
  for (const file of readdirSync(library).filter((name) => name.endsWith('.yml'))) {
    const source = readFileSync(join(library, file), 'utf8')
    assert.match(source, new RegExp(`^# commit: ${commit}$`, 'm'), file)
    assert.match(source, /^# source: master\/packages\/bundle\/web-app\/presets\//m, file)
  }
})

test('rebuild-composition：动态发现官方预设并拒绝缺行、重复和乱序', () => {
  const root = fixture()
  try {
    const upstream = upstreamFixture(root)
    const first = run(root, upstream)
    assert.equal(first.status, 0, first.stderr || first.stdout)

    // C-01/C-03：官方 minimal 已删除 filesystem 行，本地编辑能力改为 source/local 模块。
    const library = join(root, 'engine', 'compositions', 'library')
    const localModules = join(root, 'engine', 'compositions', 'source', 'local')
    assert.equal(existsSync(join(library, 'filesystem-editor.yml')), false, '本地编辑器不属于官方快照')
    assert.equal(existsSync(join(localModules, 'filesystem-editor.yml')), true, '本地 filesystem-editor 必须存在')
    assert.equal(existsSync(join(library, 'persona.yml')), false, '人设直接由预设字段生成，不得拆回模块库')
    assert.equal(existsSync(join(library, 'tool-bash-disabled.yml')), false)
    assert.equal(existsSync(join(localModules, 'tool-bash-disabled.yml')), true)
    assert.equal(existsSync(join(localModules, 'persistent-shell-posix.yml')), true)
    const generated = readdirSync(library).filter((name) => name.endsWith('.yml'))
    assert.equal(generated.length, 24)
    const upstreamRows = ['standard', 'minimal', 'ptc', 'cordis'].flatMap((name) =>
      parse(readFileSync(join(FIXTURE_PRESETS, `${name}.patch.yml`), 'utf8'), { logLevel: 'silent' })[0].insert[0].config.plugins)
    for (const name of generated) {
      const rows = parse(readFileSync(join(library, name), 'utf8'), { logLevel: 'silent' })
      assert.equal(rows.length, 1)
      assert.notEqual(rows[0].id, 'persona')
      assert.ok(upstreamRows.some((row) => isDeepStrictEqual(row, rows[0])), `${name} 必须与固定官方来源完全同构，不得带本地补丁`)
    }
    // C-02：rc.2 的 present 行必须被覆盖，且来源行记录固定 tag 与提交。
    const present = readFileSync(join(library, 'tool-present.yml'), 'utf8')
    // 临时上游目录不带 PROVENANCE.md，来源行只保证指向 minimal 之外的官方基型；
    // tag/commit 由上面「固定上游 fixture 与 PROVENANCE 指纹一致」用例锁定。
    assert.match(present, /^# source: .*\/packages\/bundle\/web-app\/presets\/standard\.patch\.yml$/m)

    const before = readFileSync(join(library, 'tool-web.yml'), 'utf8')
    const file = join(root, 'preset', 'pt-standard', 'preset.yml')
    const original = readFileSync(file, 'utf8')
    writeFileSync(file, original.replace('  - tool-web\n', ''), 'utf8')
    const missing = run(root, upstream)
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr + missing.stdout, /modules do not match official standard order/)
    // C-04：失败必须原子回滚，原生成目录逐字节保留。
    assert.equal(readFileSync(join(library, 'tool-web.yml'), 'utf8'), before, '失败的重建不得改写原生成目录')
    assert.equal(existsSync(`${library}.rebuild-tmp`), false, '失败后不得残留临时目录')

    writeFileSync(file, original.replace('  - tool-web\n', '  - tool-web\n  - tool-web\n'), 'utf8')
    const duplicate = run(root, upstream)
    assert.notEqual(duplicate.status, 0)
    assert.match(duplicate.stderr + duplicate.stdout, /duplicate modules: tool-web/)

    writeFileSync(file, original.replace('  - tool-present\n  - tool-plugin-manager-disabled\n  - prompt-config-engine\n', '  - prompt-config-engine\n  - tool-plugin-manager-disabled\n  - tool-present\n'), 'utf8')
    const reordered = run(root, upstream)
    assert.notEqual(reordered.status, 0)
    assert.match(reordered.stderr + reordered.stdout, /modules do not match official standard order/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rebuild-composition：缺失官方预设或必要技能资产时 fail loud', () => {
  const root = fixture()
  try {
    const upstream = upstreamFixture(root)
    rmSync(join(root, 'preset', 'pt-cordis', 'skills', 'editing-cordis-compositions', 'SKILL.md'))
    const missingAsset = run(root, upstream)
    assert.notEqual(missingAsset.status, 0)
    assert.match(missingAsset.stderr + missingAsset.stdout, /required asset missing/)

    const extra = join(upstream, PRESET_SOURCE_PATH, 'new-preset.patch.yml')
    writeFileSync(extra, '- insert: []\n', 'utf8')
    const missingTarget = run(root, upstream)
    assert.notEqual(missingTarget.status, 0)
    assert.match(missingTarget.stderr + missingTarget.stdout, /no local target preset\/pt-new-preset\/preset\.yml/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
