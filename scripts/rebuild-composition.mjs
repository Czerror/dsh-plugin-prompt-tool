// rebuild-composition.mjs — 从 DeepSeek Harness 官方内置预设重建共享组合模块。
//
// 数据来源(官方):standard / minimal / ptc / cordis 的 agent.cordis.yml。
// 本脚本只保留一份共享行；官方预设确有语义差异时才生成变体模块
// （PTC delegation、Cordis skill-filesystem、Anchored shell 补丁等）。
// 本地模块以 engine/compositions/source/local/*.yml 为唯一源，不复制到 library/；
// library/ 只保留脚本从官方预设切出的行与确有语义差异的官方变体。
//
// 用法:node scripts/rebuild-composition.mjs [deepseek-harness 仓库路径]
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, renameSync, existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const root = fileURLToPath(new URL('..', import.meta.url))
const repoArg = process.argv.slice(2).find((arg) => arg !== '--')
const repo = resolve(repoArg ?? process.env.DSH_HARNESS_REPO ?? join(root, '..', 'deepseek-harness'))
const presetsDir = join(repo, 'packages', 'preset', 'agent-presets', 'presets')
const compositionDir = join(root, 'engine', 'compositions')
const libraryDir = join(compositionDir, 'library')
const localDir = join(compositionDir, 'source', 'local')
const sourceRepo = basename(repo) || 'deepseek-harness'

/**
 * Discover the upstream preset set instead of silently assuming a fixed list.
 * The four shipped targets below are the only known semantic mappings; a new
 * upstream preset therefore fails loudly until a matching local target exists.
 */
function discoverOfficialPresets() {
  if (!existsSync(presetsDir)) throw new Error(`official preset directory not found: ${presetsDir}`)
  const directories = readdirSync(presetsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  for (const entry of directories) {
    if (!existsSync(join(presetsDir, entry.name, 'agent.cordis.yml'))) {
      throw new Error(`official preset ${entry.name} is missing agent.cordis.yml`)
    }
  }
  return directories.map((entry) => entry.name).sort()
}

const OFFICIAL_PRESETS = discoverOfficialPresets()
if (OFFICIAL_PRESETS.length === 0) throw new Error(`no official presets with agent.cordis.yml found in ${presetsDir}`)
const TARGET_PRESET_OVERRIDES = new Map([['cordis', 'creative']])
const OFFICIAL_PRESET_TARGETS = new Map(
  OFFICIAL_PRESETS.map((preset) => [preset, TARGET_PRESET_OVERRIDES.get(preset) ?? preset]),
)
const targetOwners = new Map()
for (const [sourcePreset, targetPreset] of OFFICIAL_PRESET_TARGETS) {
  const previous = targetOwners.get(targetPreset)
  if (previous !== undefined) {
    throw new Error(`official presets ${previous} and ${sourcePreset} map to the same target ${targetPreset}`)
  }
  targetOwners.set(targetPreset, sourcePreset)
  if (!existsSync(join(root, 'preset', targetPreset, 'preset.yml'))) {
    throw new Error(`official preset ${sourcePreset} has no local target preset/${targetPreset}/preset.yml`)
  }
}

/**
 * 按顶层行切分官方组合文本。
 * 每一行前紧邻的顶层注释/空行归该行；下一行的说明不再泄漏到上一模块。
 */
function sections(text, source) {
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  const rows = []
  for (let i = 0; i < lines.length; i += 1) {
    if (/^- id:/.test(lines[i])) rows.push(i)
  }
  const starts = rows.map((row, index) => {
    const lower = index === 0 ? 0 : rows[index - 1] + 1
    let start = row
    while (start > lower) {
      const previous = lines[start - 1]
      if (previous.length !== 0 && !previous.startsWith('#')) break
      start -= 1
    }
    if (index === 0) {
      const marker = lines.findLastIndex((line, lineIndex) => lineIndex < row && /^# ──/.test(line))
      if (marker >= 0) start = marker
    }
    return start
  })
  const out = new Map()
  for (let index = 0; index < rows.length; index += 1) {
    const id = lines[rows[index]].replace(/^- id:\s*/, '').trim()
    const end = index + 1 < starts.length ? starts[index + 1] : lines.length
    const body = lines.slice(starts[index], end).join('\n').replace(/^\n+/, '').replace(/\n*$/, '\n')
    const parsed = parseYaml(body, { logLevel: 'silent' })
    if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0]?.id !== id) {
      throw new Error(`${source}: failed to split top-level row ${id}`)
    }
    if (out.has(id)) throw new Error(`${source}: duplicate top-level row id ${id}`)
    out.set(id, body)
  }
  return out
}

const officialSections = new Map()
const officialRows = new Map()
for (const preset of OFFICIAL_PRESETS) {
  const source = `${preset}/agent.cordis.yml`
  const text = readFileSync(join(presetsDir, preset, 'agent.cordis.yml'), 'utf8')
  officialSections.set(preset, sections(text, source))
  const parsed = parseYaml(text, { logLevel: 'silent' })
  if (!Array.isArray(parsed)) throw new Error(`${source}: composition must be a top-level row list`)
  const ids = []
  for (const [index, row] of parsed.entries()) {
    const id = row !== null && typeof row === 'object' && !Array.isArray(row) ? row.id : undefined
    if (typeof id !== 'string' || id.length === 0) throw new Error(`${source}: row ${index + 1} must declare a non-empty id`)
    ids.push(id)
  }
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index)
  if (duplicate !== undefined) throw new Error(`${source}: duplicate top-level row id ${duplicate}`)
  officialRows.set(preset, new Map(parsed.map((row) => [row.id, row])))
}

/** 本地补丁:输出模块 id → 对官方切块应用的字符串替换(全部幂等,缺失时 fail loud)。 */
const PATCHES = {
  // Anchored Standard 在 Windows 使用 custom-bash；普通 tool-bash 永久关闭。
  'tool-bash': [
    { from: 'disabled: !!js process.platform === \'win32\'', to: 'disabled: true' },
  ],
  'bootstrap-filesystem': [
    { from: '- id: filesystem\n', to: '- id: bootstrap-filesystem\n' },
  ],
  'persistent-shell': [
    {
      // Anchored 同时挂普通 tool-pwsh；Windows 整组关闭 persistent-shell，避免重复注册 pwsh。
      from: "- id: persistent-shell\n  name: cordis:group\n  group: true\n  isolate:",
      to: "- id: persistent-shell\n  name: cordis:group\n  group: true\n  disabled: !!js process.platform === 'win32'\n  isolate:",
    },
    {
      // 对齐 dsh-anchored-standard issue #44：NixOS 等无 /bin/bash 时回退 PATH 中的 bash。
      from: "- id: terminal-bash\n      name: '@deepseek-ai/dsh-terminal-bash'\n      disabled: !!js process.platform === 'win32'\n      config:\n        timeoutMs: 300000",
      to: "- id: terminal-bash\n      name: '@deepseek-ai/dsh-terminal-bash'\n      disabled: !!js process.platform === 'win32'\n      config:\n        shellPath: !!js \"process.getBuiltinModule?.('node:fs')?.existsSync('/bin/bash') ? '/bin/bash' : 'bash'\"\n        timeoutMs: 300000",
    },
  ],
}

function applyPatches(id, text, source) {
  let out = text
  for (const patch of PATCHES[id] ?? []) {
    const occurrences = out.split(patch.from).length - 1
    if (occurrences === 0) {
      throw new Error(`${id}: official patch marker missing in ${source}:\n${patch.from}`)
    }
    if (occurrences !== 1) {
      throw new Error(`${id}: official patch marker occurs ${occurrences} times in ${source}; expected exactly once`)
    }
    out = out.replace(patch.from, patch.to)
  }
  return out
}

/**
 * 官方模块映射。相同语义只保留一份；确有差异的行使用独立文件名。
 * persona 由各 preset.yml 的 system-section 配置卡等价表达，不重复生成 Cordis 行。
 */
const OFFICIAL_MODULES = [
  // 动态 ST/角色卡转换仍可显式装配标准 persona。
  { id: 'persona', preset: 'standard' },
  { id: 'official-agent-instructions', preset: 'standard', sourceId: 'agent-instructions' },
  { id: 'official-tool-bash', preset: 'standard', sourceId: 'tool-bash' },
  { id: 'tool-bash', preset: 'standard', sourceId: 'tool-bash' },
  { id: 'tool-pwsh', preset: 'standard' },
  { id: 'tool-fs', preset: 'standard' },
  { id: 'tool-fs-search', preset: 'standard' },
  { id: 'tool-jobs', preset: 'standard' },
  { id: 'skill-filesystem', preset: 'standard' },
  { id: 'official-tool-skill', preset: 'standard', sourceId: 'tool-skill' },
  { id: 'command-goal', preset: 'standard' },
  { id: 'tool-goal', preset: 'standard' },
  { id: 'planning', preset: 'standard' },
  { id: 'compaction', preset: 'standard' },
  { id: 'delegation', preset: 'standard' },
  { id: 'delegation-ptc', preset: 'ptc', sourceId: 'delegation' },
  { id: 'tool-ask-user', preset: 'standard' },
  { id: 'tool-todo', preset: 'standard' },
  { id: 'tool-web', preset: 'standard' },
  { id: 'official-tool-presentation', preset: 'ptc', sourceId: 'tool-presentation' },
  { id: 'official-tool-cordis', preset: 'cordis', sourceId: 'tool-cordis' },
  { id: 'official-skill-filesystem-cordis', preset: 'cordis', sourceId: 'skill-filesystem' },
  { id: 'official-persistent-shell', preset: 'minimal', sourceId: 'persistent-shell' },
  { id: 'persistent-shell', preset: 'minimal', sourceId: 'persistent-shell' },
  { id: 'bootstrap-filesystem', preset: 'minimal', sourceId: 'filesystem' },
]

/**
 * Target preset module names in official row order. Most rows keep their id;
 * these aliases are the deliberate local split/variant names. The generated
 * prompt-config-engine is a local module appended to every official target.
 */
const TARGET_MODULE_OVERRIDES = {
  standard: {
    'agent-instructions': 'official-agent-instructions',
    'tool-bash': 'official-tool-bash',
    'tool-skill': 'official-tool-skill',
  },
  minimal: {
    'persistent-shell': 'official-persistent-shell',
    // Minimal keeps the upstream filesystem group (including its editor).
    filesystem: 'bootstrap-filesystem',
  },
  ptc: {
    'agent-instructions': 'official-agent-instructions',
    'tool-bash': 'official-tool-bash',
    'tool-skill': 'official-tool-skill',
    delegation: 'delegation-ptc',
    'tool-presentation': 'official-tool-presentation',
  },
  cordis: {
    'agent-instructions': 'official-agent-instructions',
    'tool-bash': 'official-tool-bash',
    'tool-skill': 'official-tool-skill',
    'tool-cordis': 'official-tool-cordis',
    'skill-filesystem': 'official-skill-filesystem-cordis',
  },
}
const TARGET_EXTRA_MODULES = ['prompt-config-engine']

const localFiles = readdirSync(localDir).filter((file) => file.endsWith('.yml')).sort()
const localIds = new Set(localFiles.map((file) => file.slice(0, -4)))
const officialIds = new Set()
for (const { id } of OFFICIAL_MODULES) {
  if (officialIds.has(id) || localIds.has(id)) throw new Error(`duplicate composition module id: ${id}`)
  officialIds.add(id)
}

// source/local 是可直接装配的源文件；校验后原样保留，不生成 library 副本。
for (const file of localFiles) {
  const id = file.slice(0, -4)
  const parsed = parseYaml(readFileSync(join(localDir, file), 'utf8'), { logLevel: 'silent' })
  if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0]?.id !== id) {
    throw new Error(`source/local/${file}: local module must contain exactly one row whose id is ${id}`)
  }
}

function duplicateValues(values) {
  const seen = new Set()
  const duplicates = new Set()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    else seen.add(value)
  }
  return [...duplicates]
}

/** Derive the exact target module sequence from the discovered official rows. */
function expectedTargetModules(sourcePreset) {
  const rows = officialRows.get(sourcePreset)
  if (rows === undefined) throw new Error(`official preset ${sourcePreset} was not loaded`)
  const overrides = TARGET_MODULE_OVERRIDES[sourcePreset] ?? {}
  const expected = []
  for (const id of rows.keys()) {
    // The local prompt-config-engine/persona-main pair is the persona carrier;
    // do not duplicate the upstream Cordis persona row in a target composition.
    if (id === 'persona') continue
    expected.push(overrides[id] ?? id)
  }
  expected.push(...TARGET_EXTRA_MODULES)
  return expected
}

function listFiles(dir, prefix = '') {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix.length > 0 ? join(prefix, entry.name) : entry.name
    if (entry.isDirectory()) files.push(...listFiles(join(dir, entry.name), relative))
    else if (entry.isFile()) files.push(relative)
  }
  return files
}

/** Required non-definition assets (currently Cordis skills) must stay in sync. */
function assertTargetAssets(sourcePreset, targetPreset) {
  const sourceDir = join(presetsDir, sourcePreset)
  const targetDir = join(root, 'preset', targetPreset)
  for (const relative of listFiles(sourceDir)) {
    if (relative === 'preset.yml' || relative === 'agent.cordis.yml') continue
    const sourceFile = join(sourceDir, relative)
    const targetFile = join(targetDir, relative)
    if (!existsSync(targetFile)) {
      throw new Error(`${targetPreset}: required asset missing (${relative}) for official ${sourcePreset}`)
    }
    let sourceBytes
    let targetBytes
    try {
      sourceBytes = readFileSync(sourceFile)
      targetBytes = readFileSync(targetFile)
    } catch (error) {
      throw new Error(`${targetPreset}: required asset unreadable (${relative}): ${String(error?.message ?? error)}`)
    }
    if (!sourceBytes.equals(targetBytes)) {
      throw new Error(`${targetPreset}: required asset differs from official ${sourcePreset} (${relative})`)
    }
  }
}

function assertTargetModules(sourcePreset, targetPreset, tmpDir) {
  const specFile = join(root, 'preset', targetPreset, 'preset.yml')
  let spec
  try {
    spec = parseYaml(readFileSync(specFile, 'utf8'), { logLevel: 'silent' })
  } catch (error) {
    throw new Error(`${targetPreset}: preset.yml cannot be parsed: ${String(error?.message ?? error)}`)
  }
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(`${targetPreset}: preset.yml must contain a mapping`)
  }
  const actual = spec.modules
  if (!Array.isArray(actual) || actual.some((name) => typeof name !== 'string' || name.length === 0)) {
    throw new Error(`${targetPreset}: modules must be a non-empty-string array`)
  }
  const duplicate = duplicateValues(actual)
  if (duplicate.length > 0) {
    throw new Error(`${targetPreset}: duplicate modules: ${duplicate.join(', ')}`)
  }
  const expected = expectedTargetModules(sourcePreset)
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`${targetPreset}: modules do not match official ${sourcePreset} order (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
  }
  for (const name of actual) {
    if (!localIds.has(name) && !existsSync(join(tmpDir, `${name}.yml`))) {
      throw new Error(`${targetPreset}: module ${name} is missing from source/local and rebuilt library`)
    }
  }
  assertTargetAssets(sourcePreset, targetPreset)
}

/** 稳定语义签名：用于验证四套官方预设的每个非 persona 行都有拆解来源。 */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  }
  return value
}
const signature = (value) => JSON.stringify(stable(value))
for (const [sourcePreset, targetPreset] of OFFICIAL_PRESET_TARGETS) {
  const spec = parseYaml(readFileSync(join(root, 'preset', targetPreset, 'preset.yml'), 'utf8'))
  const personas = Array.isArray(spec?.promptConfigs)
    ? spec.promptConfigs.filter((config) => config?.id === 'persona-main')
    : []
  if (personas.length !== 1) throw new Error(`${targetPreset}: expected exactly one promptConfigs persona-main entry`)
  const persona = personas[0]
  if (persona.layer !== 'system-section' || persona.strategy !== 'static' || persona.params?.sectionName !== 'deployment:persona') {
    throw new Error(`${targetPreset}: persona-main must use system-section/static deployment:persona`)
  }
  const params = persona?.params ?? {}
  const mapped = {
    text: persona?.text,
    ...(params.complete !== undefined ? { complete: params.complete } : {}),
    ...(params.suppressRuntimeContext !== undefined ? { includeRuntimeContext: !params.suppressRuntimeContext } : {}),
  }
  const expected = officialRows.get(sourcePreset)?.get('persona')?.config
  if (signature(mapped) !== signature(expected)) throw new Error(`${targetPreset}: persona-main does not match official ${sourcePreset} persona`)
}
const coveredSignatures = new Set()
for (const { preset, sourceId, id } of OFFICIAL_MODULES) {
  const row = officialRows.get(preset)?.get(sourceId ?? id)
  if (row === undefined) throw new Error(`${id}: official ${preset} preset has no top-level row ${sourceId ?? id}`)
  coveredSignatures.add(signature(row))
}
for (const preset of OFFICIAL_PRESETS) {
  for (const [id, row] of officialRows.get(preset)) {
    if (id === 'persona') continue
    if (!coveredSignatures.has(signature(row))) {
      throw new Error(`official preset row not decomposed: ${preset}/${id}`)
    }
  }
}

// 原子重建:先构建到临时目录,全部成功后 rename 替换 libraryDir。
const tmpDir = `${libraryDir}.rebuild-tmp`
rmSync(tmpDir, { recursive: true, force: true })
mkdirSync(tmpDir, { recursive: true })

try {
  for (const { id, preset, sourceId } of OFFICIAL_MODULES) {
    const rowId = sourceId ?? id
    const section = officialSections.get(preset)?.get(rowId)
    if (section === undefined) throw new Error(`${id}: official ${preset} preset has no top-level row ${rowId}`)
    const body = applyPatches(id, section, `${preset}/agent.cordis.yml`)
    const patches = PATCHES[id]?.length ?? 0
    const provenance = `# module: ${id}\n# source: ${sourceRepo}/packages/preset/agent-presets/presets/${preset}/agent.cordis.yml\n# local patches: ${patches}\n\n`
    writeFileSync(join(tmpDir, `${id}.yml`), provenance + body)
  }

  // 每个模块必须是且仅是一个顶层 Cordis 行；变体允许文件名与行 id 不同。
  for (const file of readdirSync(tmpDir).filter((item) => item.endsWith('.yml')).sort()) {
    const parsed = parseYaml(readFileSync(join(tmpDir, file), 'utf8'), { logLevel: 'silent' })
    if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0]?.id !== 'string') {
      throw new Error(`${file}: generated module must contain exactly one top-level Cordis row`)
    }
  }

  // 官方目标预设必须完整复刻上游行序（含本地别名/附加模块），并校验
  // Cordis 预设携带的 skills 等必要资产；不能只检查文件是否存在。
  for (const [sourcePreset, targetPreset] of OFFICIAL_PRESET_TARGETS) {
    assertTargetModules(sourcePreset, targetPreset, tmpDir)
  }

  // 其余包内预设也至少拒绝重复 modules，并确保每项有唯一来源。
  const presetRoot = join(root, 'preset')
  const checked = []
  for (const entry of readdirSync(presetRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const specFile = join(presetRoot, entry.name, 'preset.yml')
    if (!existsSync(specFile)) continue
    const spec = parseYaml(readFileSync(specFile, 'utf8'))
    const modules = Array.isArray(spec.modules) ? spec.modules : []
    const duplicate = duplicateValues(modules)
    if (duplicate.length > 0) throw new Error(`preset ${entry.name}: duplicate modules: ${duplicate.join(', ')}`)
    for (const name of modules) {
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error(`preset ${entry.name}: modules must contain non-empty strings`)
      }
      const inSource = localIds.has(name)
      const inLibrary = existsSync(join(tmpDir, `${name}.yml`))
      if (inSource && inLibrary) throw new Error(`preset ${entry.name}: module ${name} is duplicated across source/local and library`)
      if (!inSource && !inLibrary) throw new Error(`preset ${entry.name}: module ${name} is missing from source/local and rebuilt library`)
    }
    checked.push(entry.name)
  }

  // 失败安全替换：旧 library 先改名备份，新库 rename 到位；替换失败恢复备份。
  const backupDir = `${libraryDir}.bak-${Date.now().toString(36)}`
  let hadOld = false
  if (existsSync(libraryDir)) {
    renameSync(libraryDir, backupDir)
    hadOld = true
  }
  try {
    renameSync(tmpDir, libraryDir)
  } catch (error) {
    if (hadOld) {
      try { renameSync(backupDir, libraryDir) } catch { /* 保留 backup 供人工恢复 */ }
    }
    throw error
  }
  if (hadOld) rmSync(backupDir, { recursive: true, force: true })
  console.log(`rebuilt ${OFFICIAL_MODULES.length} official modules from ${repo}; ${localFiles.length} local source modules kept in source/local`)
  console.log(`official presets covered: ${OFFICIAL_PRESETS.join(', ')}`)
  console.log(`preset modules checked: ${checked.join(', ')}`)
} catch (error) {
  rmSync(tmpDir, { recursive: true, force: true })
  throw error
}
