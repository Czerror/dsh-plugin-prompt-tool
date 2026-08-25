// rebuild-composition.mjs — 从官方 deepseek-harness 内置预设源码重建 anchored-standard 组合模块。
//
// 数据来源(官方):
//   <repo>/apps/cli/config/agent-presets/standard/agent.cordis.yml
//   <repo>/apps/cli/config/agent-presets/minimal/agent.cordis.yml
// 官方契约:预设目录 = agent.cordis.yml(顶层 Cordis 行列表,entryListSchema 解析 `!!js`)
//          + preset.yml(仅展示元数据)。
//
// 本脚本:
//   1. 从官方 standard/minimal 按"顶层行 id + 段注释"切出模块;
//   2. 叠加本项目声明的本地补丁(见 PATCHES 与 applyLocalPatches);
//   3. 本地新增模块从 source/local/ 逐字复制;
//   4. 写出 library/*.yml 与 anchored-standard.yml 组合清单。
// 用法:node scripts/rebuild-composition.mjs [deepseek-harness 仓库路径]
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const root = fileURLToPath(new URL('..', import.meta.url))
const repo = resolve(process.argv[2] ?? process.env.DSH_HARNESS_REPO ?? join(root, '..', 'deepseek-harness'))
const presetsDir = join(repo, 'apps', 'cli', 'config', 'agent-presets')
const compositionDir = join(root, 'engine', 'compositions')
const libraryDir = join(compositionDir, 'library')
const localDir = join(compositionDir, 'source', 'local')

/** 按顶层行 id 切分官方组合文本;段注释归入其后第一个行模块。 */
function sections(text) {
  const lines = text.split('\n')
  const rows = []
  const markers = []
  for (let i = 0; i < lines.length; i += 1) {
    if (/^- id:/.test(lines[i])) rows.push(i)
    if (/^# ──/.test(lines[i])) markers.push(i)
  }
  const out = new Map()
  for (let r = 0; r < rows.length; r += 1) {
    const id = lines[rows[r]].replace(/^- id:\s*/, '').trim()
    const prevRow = r === 0 ? -1 : rows[r - 1]
    const ownMarkers = markers.filter((marker) => marker > prevRow && marker < rows[r])
    const start = ownMarkers.length > 0 ? ownMarkers[ownMarkers.length - 1] : rows[r]
    const end = r + 1 < rows.length ? rows[r + 1] : lines.length
    out.set(id, lines.slice(start, end).join('\n').replace(/\n+$/, '\n'))
  }
  return out
}

const standard = sections(readFileSync(join(presetsDir, 'standard', 'agent.cordis.yml'), 'utf8'))
const minimal = sections(readFileSync(join(presetsDir, 'minimal', 'agent.cordis.yml'), 'utf8'))

/** 本地补丁:模块 id → 对官方切块应用的字符串替换(全部幂等,缺失时 fail loud)。 */
const PATCHES = {
  'tool-bash': [
    { from: 'disabled: !!js process.platform === \'win32\'', to: 'disabled: true' },
  ],
  'persistent-shell': [
    { from: '  group: true\n', to: '  group: true\n  disabled: !!js process.platform === \'win32\'\n' },
    {
      from: "    - id: terminal-bash\n      name: '@deepseek-ai/dsh-terminal-bash'\n      config:\n",
      to: "    - id: terminal-bash\n      name: '@deepseek-ai/dsh-terminal-bash'\n      config:\n        shellPath: !!js \"process.getBuiltinModule?.('node:fs')?.existsSync('/bin/bash') ? '/bin/bash' : 'bash'\"\n",
    },
  ],
  'bootstrap-filesystem': [
    { from: '- id: filesystem\n', to: '- id: bootstrap-filesystem\n' },
  ],
  delegation: [
    { from: 'backgroundMode: one-shot', to: 'enableRunInBackground: false' },
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

/** 模块清单:顺序即最终 agent.cordis.yml 的行序。 */
const MODULES = [
  { id: 'context-gate', from: 'local' },
  { id: 'tool-bootstrap', from: 'local' },
  { id: 'code-presentation', from: 'local' },
  { id: 'tool-config-engine', from: 'local' },
  { id: 'prompt-config-engine', from: 'local' },
  { id: 'run-code-env', from: 'local' },
  { id: 'persona', from: 'minimal' },
  { id: 'tool-bash', from: 'standard' },
  { id: 'tool-pwsh', from: 'standard' },
  { id: 'persistent-shell', from: 'minimal' },
  { id: 'custom-bash', from: 'local' },
  { id: 'tool-fs', from: 'standard' },
  { id: 'tool-fs-search', from: 'standard' },
  { id: 'str-replace-editor', from: 'local' },
  { id: 'bootstrap-filesystem', from: 'minimal', sourceId: 'filesystem' },
  { id: 'tool-filter', from: 'local' },
  { id: 'tool-jobs', from: 'standard' },
  { id: 'skill-filesystem', from: 'standard' },
  { id: 'skill-search', from: 'local' },
  { id: 'tool-goal', from: 'standard' },
  { id: 'planning', from: 'standard' },
  { id: 'compaction', from: 'standard' },
  { id: 'delegation', from: 'standard' },
  { id: 'tool-ask-user', from: 'standard' },
  { id: 'tool-todo', from: 'standard' },
  { id: 'tool-web', from: 'standard' },
]

rmSync(libraryDir, { recursive: true, force: true })
mkdirSync(libraryDir, { recursive: true })

for (const { id, from, sourceId } of MODULES) {
  let body
  let provenance
  if (from === 'local') {
    body = readFileSync(join(localDir, `${id}.yml`), 'utf8')
    provenance = `# module: ${id}\n# source: engine/compositions/source/local/${id}.yml (本地附加,非官方模块)\n\n`
  } else {
    const map = from === 'minimal' ? minimal : standard
    const section = map.get(sourceId ?? id)
    if (section === undefined) throw new Error(`${id}: official ${from} preset has no top-level row ${sourceId ?? id}`)
    body = applyPatches(id, section, `${from}/agent.cordis.yml`)
    const patches = PATCHES[id]?.length ?? 0
    provenance = `# module: ${id}\n# source: ${repo}/apps/cli/config/agent-presets/${from}/agent.cordis.yml\n# local patches: ${patches}\n\n`
  }
  writeFileSync(join(libraryDir, `${id}.yml`), provenance + body)
}

// 模块清单由参数文件 preset/anchored/preset.yml 决定:rebuild 只重建库并校验清单。
const presetFile = join(root, 'preset', 'anchored', 'preset.yml')
const presetSpec = parseYaml(readFileSync(presetFile, 'utf8'))
const declared = Array.isArray(presetSpec.modules) ? presetSpec.modules : []
for (const name of declared) {
  if (!readFileSync(join(libraryDir, `${name}.yml`), 'utf8').includes('- id:')) {
    throw new Error(`preset modules: ${name} is missing from rebuilt library`)
  }
}

console.log(`rebuilt ${MODULES.length} modules from official source at ${repo}`)
console.log(`preset modules declared by ${presetFile}: ${declared.length}`)
console.log(`local modules: ${readdirSync(localDir).sort().join(', ')}`)
