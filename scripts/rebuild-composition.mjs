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
const OFFICIAL_PRESETS = ['standard', 'minimal', 'ptc', 'cordis']
const OFFICIAL_PRESET_TARGETS = new Map([
  ['standard', 'standard'],
  ['minimal', 'minimal'],
  ['ptc', 'ptc'],
  ['cordis', 'creative'],
])

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
    if (!out.includes(patch.from)) {
      throw new Error(`${id}: official patch marker missing in ${source}:\n${patch.from}`)
    }
    out = out.replaceAll(patch.from, patch.to)
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
  const persona = spec.promptConfigs?.find((config) => config?.id === 'persona-main')
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

  // 全部包内预设的 modules 清单必须在 source/local 或新 library 中齐全，且不能两处重叠。
  const presetRoot = join(root, 'preset')
  const checked = []
  for (const entry of readdirSync(presetRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const specFile = join(presetRoot, entry.name, 'preset.yml')
    if (!existsSync(specFile)) continue
    const spec = parseYaml(readFileSync(specFile, 'utf8'))
    for (const name of Array.isArray(spec.modules) ? spec.modules : []) {
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
