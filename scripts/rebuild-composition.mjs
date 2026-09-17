// rebuild-composition.mjs — 从 DeepSeek Harness 官方内置预设重建共享组合模块。
//
// 数据来源(官方):standard / minimal / ptc / cordis 的 agent.cordis.yml。
// 本脚本只保留一份共享行；官方预设确有语义差异时才生成变体模块
// （PTC delegation、Cordis skill-filesystem）。本地改写属于 source/local，不冒充官方变体。
// 本地模块以 engine/compositions/source/local/*.yml 为唯一源，不复制到 library/；
// library/ 只保留脚本从官方预设切出的行与确有语义差异的官方变体。
//
// 默认核验官方最新 master 后重建；不会修改宿主源码仓库。
// 显式目录参数用于离线重放已记录提交的快照，不代表实时最新。
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, renameSync, existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { verifyLatestCompositionSource } from './composition-source.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const repoArg = process.argv.slice(2).find((arg) => arg !== '--')
const repo = resolve(repoArg ?? process.env.DSH_HARNESS_REPO ?? join(root, '..', 'deepseek-harness'))
const presetsDir = join(repo, 'packages', 'preset', 'agent-presets', 'presets')
const compositionDir = join(root, 'engine', 'compositions')
const libraryDir = join(compositionDir, 'library')
const localDir = join(compositionDir, 'source', 'local')

/**
 * 离线快照标识：读取 PROVENANCE.md（分支或 tag + 实际提交），
 * 这样生成文件的来源行不会退化成「本机目录名」这种无法追溯的标签。
 */
function upstreamProvenance(repoDir) {
  const label = basename(repoDir) || 'deepseek-harness'
  const file = join(repoDir, 'PROVENANCE.md')
  if (!existsSync(file)) return { label, commit: undefined }
  const text = readFileSync(file, 'utf8')
  const field = (name) => new RegExp(`来源\\s*${name}[^\\n]*?([0-9A-Za-z][0-9A-Za-z.\\-_]*)`).exec(text)?.[1]
  return { label: field('分支') ?? field('tag') ?? label, commit: field('提交') }
}

const upstream = repoArg === undefined ? verifyLatestCompositionSource(repo) : upstreamProvenance(repo)
const sourceRepo = upstream.label

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
// 本地模板已与官方预设同名（cordis 对齐官方命名），不再需要目标覆盖；保留本表以备将来再改名。
const TARGET_PRESET_OVERRIDES = new Map()
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

/**
 * 官方模块映射。相同语义只保留一份；确有差异的行使用独立文件名。
 * persona 由 preset.yml 顶层字段直接生成官方行，不属于模块库。
 */
const OFFICIAL_MODULES = [
  { id: 'agent-instructions', preset: 'standard' },
  { id: 'tool-bash', preset: 'standard' },
  { id: 'tool-pwsh', preset: 'standard' },
  { id: 'tool-fs', preset: 'standard' },
  { id: 'tool-fs-search', preset: 'standard' },
  { id: 'tool-jobs', preset: 'standard' },
  { id: 'skill-filesystem', preset: 'standard' },
  { id: 'tool-skill', preset: 'standard' },
  { id: 'command-goal', preset: 'standard' },
  { id: 'tool-goal', preset: 'standard' },
  { id: 'planning', preset: 'standard' },
  { id: 'compaction', preset: 'standard' },
  { id: 'delegation', preset: 'standard' },
  { id: 'delegation-ptc', preset: 'ptc', sourceId: 'delegation' },
  { id: 'tool-ask-user', preset: 'standard' },
  { id: 'tool-todo', preset: 'standard' },
  { id: 'tool-web', preset: 'standard' },
  // rc.2 起 standard / ptc / cordis 都在末尾挂 present 行，语义完全相同，只保留一份。
  { id: 'tool-present', preset: 'standard', sourceId: 'present' },
  // standard / ptc 的 plugin-manager 行是 disabled 态，cordis 的是启用态：同 id 两版，各留一个模块。
  { id: 'tool-plugin-manager-disabled', preset: 'standard', sourceId: 'tool-plugin-manager' },
  { id: 'tool-presentation', preset: 'ptc' },
  { id: 'tool-cordis', preset: 'cordis' },
  { id: 'skill-filesystem-cordis', preset: 'cordis', sourceId: 'skill-filesystem' },
  { id: 'tool-plugin-manager', preset: 'cordis' },
  { id: 'persistent-shell', preset: 'minimal' },
]

/**
 * Target preset module names in official row order. Most rows keep their id;
 * these names identify official variants, not compatibility aliases. The generated
 * prompt-config-engine is a local module appended to every official target.
 */
const TARGET_MODULE_OVERRIDES = {
  standard: {
    present: 'tool-present',
    'tool-plugin-manager': 'tool-plugin-manager-disabled',
  },
  ptc: {
    delegation: 'delegation-ptc',
    present: 'tool-present',
    'tool-plugin-manager': 'tool-plugin-manager-disabled',
  },
  cordis: {
    'skill-filesystem': 'skill-filesystem-cordis',
    present: 'tool-present',
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

/**
 * 目标预设显式跳过的官方行：tool-cordis 注册进程全局的 cordisInspect
 * provider（id "Service"），与官方 shipped「创造模式」(cordis) 预设同时
 * 挂载必然重复注册；该能力由官方预设提供，本地 cordis 模板不再复制。
 * （`tool-plugin-manager` 已随官方 cordis 一并拆解并挂载，不再跳过。）
 */
const TARGET_SKIPPED_ROWS = { cordis: new Set(['tool-cordis']) }

/** Derive the exact target module sequence from the discovered official rows. */
function expectedTargetModules(sourcePreset) {
  const rows = officialRows.get(sourcePreset)
  if (rows === undefined) throw new Error(`official preset ${sourcePreset} was not loaded`)
  const overrides = TARGET_MODULE_OVERRIDES[sourcePreset] ?? {}
  const skipped = TARGET_SKIPPED_ROWS[sourcePreset] ?? new Set()
  const expected = []
  for (const id of rows.keys()) {
    // The persona row is carried by preset.yml 顶层 persona 段 and auto-inserted
    // by renderComposition; the modules list stays free of the duplicate row.
    if (id === 'persona') continue
    if (skipped.has(id)) continue
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
/** 空白归一化：官方与本地 persona 都以 prefix/suffix 两段承载。 */
const normalizePersonaText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
const personaSegments = (value) => String(value ?? '')
  .split(/\n\s*\n/)
  .map((part) => normalizePersonaText(part))
  .filter((part) => part.length > 0)
for (const [sourcePreset, targetPreset] of OFFICIAL_PRESET_TARGETS) {
  const spec = parseYaml(readFileSync(join(root, 'preset', targetPreset, 'preset.yml'), 'utf8'))
  const persona = spec?.persona
  if (persona === null || typeof persona !== 'object' || Array.isArray(persona) || typeof persona.prefix !== 'string') {
    throw new Error(`${targetPreset}: expected a top-level persona block with a string prefix`)
  }
  const expected = officialRows.get(sourcePreset)?.get('persona')?.config ?? {}
  for (const [label, part] of [['prefix', persona.prefix], ['suffix', persona.suffix]]) {
    const text = normalizePersonaText(part)
    for (const segment of personaSegments(label === 'prefix' ? expected.prefix : expected.suffix)) {
      if (!text.includes(segment)) {
        throw new Error(`${targetPreset}: persona.${label} is missing official ${sourcePreset} ${label} segment: ${segment.slice(0, 60)}...`)
      }
    }
  }
  if ((persona.complete === true) !== (expected.complete === true)) {
    throw new Error(`${targetPreset}: persona.complete does not match official ${sourcePreset} persona`)
  }
  if ((persona.includeRuntimeContext === false) !== (expected.includeRuntimeContext === false)) {
    throw new Error(`${targetPreset}: persona.includeRuntimeContext does not match official ${sourcePreset} persona`)
  }
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
    const commit = upstream.commit === undefined ? '' : `# commit: ${upstream.commit}\n`
    const provenance = `# module: ${id}\n# source: ${sourceRepo}/packages/preset/agent-presets/presets/${preset}/agent.cordis.yml\n${commit}# local patches: 0\n\n`
    writeFileSync(join(tmpDir, `${id}.yml`), provenance + section)
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
