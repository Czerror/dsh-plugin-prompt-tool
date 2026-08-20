/**
 * SillyTavern JSON 导入完整性验证（隔离环境，不触碰真实 DSH_HOME）：
 *   用法: node scripts/verify-st-import.mjs <SillyTavern.json> [对照 preset.yml]
 * 流程: importPresetPackage 端点导入 → 落盘 preset.yml → exportPreset 导出
 *       →（可选）逐条对照参照预设的 promptConfigs / modules / moduleConfigs。
 * 前置: 先 pnpm build（脚本动态 import lib/index.mjs）。
 */
import { basename, join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { parse: parseYaml } = require('yaml')
const libUrl = pathToFileURL(fileURLToPath(new URL('../lib/index.mjs', import.meta.url))).href

const jsonSrc = process.argv[2]
if (jsonSrc === undefined) {
  console.error('用法: node scripts/verify-st-import.mjs <SillyTavern.json> [对照 preset.yml]')
  process.exit(1)
}
const referencePreset = process.argv[3]

const home = mkdtempSync(join(tmpdir(), 'pt-st-verify-'))
process.env.DSH_HOME = home
const { registerSettingsBridge } = await import(libUrl)

const PREFIX = '/api/prompt-tool/settings'

const handlers = new Map()
const sctx = {
  settings: {
    describe: () => [{ ns: 'prompt-tool', value: {}, base: {} }],
    mutate: async () => {},
  },
  webServer: {
    register: ({ path, handler }) => { handlers.set(path, handler) },
  },
  effect: (fn) => fn(),
}
registerSettingsBridge(
  { inject: (_deps, cb) => cb(sctx) },
  'prompt-tool',
  () => true,
  () => ({ available: true, providers: [] }),
  () => ({ activeSkillsDirs: [], skillCatalog: [] }),
  () => '',
  () => true,
)

const post = async (handler, body) => {
  const payload = Buffer.from(JSON.stringify(body))
  const req = {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost' },
    [Symbol.asyncIterator]: async function* () { yield payload },
  }
  let status = 0
  let chunk = ''
  await handler(req, { writeHead(code) { status = code }, end(body2) { chunk = body2 } })
  return { status, chunk }
}

const importHandler = handlers.get(`${PREFIX}/import-preset-package`)
if (importHandler === undefined) throw new Error('import-preset-package 未注册')
const fileName = basename(jsonSrc)
const { status, chunk } = await post(importHandler, { files: [{ path: fileName, content: readFileSync(jsonSrc, 'utf8') }] })
const result = JSON.parse(chunk)
console.log('导入状态:', status, JSON.stringify(result).slice(0, 300))
if (status !== 200) {
  rmSync(home, { recursive: true, force: true })
  process.exit(1)
}

const importedFile = join(home, 'presets', result.value.id, 'preset.yml')
console.log('落盘:', importedFile, existsSync(importedFile) ? `(${(readFileSync(importedFile, 'utf8').length / 1024).toFixed(1)}KB)` : '缺失')
const imported = parseYaml(readFileSync(importedFile, 'utf8'))

const report = []

// 导出端点验证：导出内容应等于落盘文件（导出无转换，直接读生成目录）。
const exportHandler = handlers.get(`${PREFIX}/export-preset`)
if (exportHandler !== undefined) {
  const exported = await post(exportHandler, { id: imported.id })
  const exportedParsed = parseYaml(JSON.parse(exported.chunk).value.content)
  const exportedCount = exportedParsed.promptConfigs?.length
  report.push(`导出端点: ${exported.status}  导出 promptConfigs=${exportedCount} 条  ${exportedCount === imported.promptConfigs.length ? '（与落盘一致）' : '（不一致！）'}`)
}

if (referencePreset !== undefined && existsSync(referencePreset)) {
  const repo = parseYaml(readFileSync(referencePreset, 'utf8'))
  report.push(`顶层 id: 导入=${imported.id}  仓库=${repo.id}  ${imported.id === repo.id ? '一致' : '（预期差异：仓库为手动命名）'}`)
  report.push(`顶层 name: ${imported.name === repo.name ? '一致' : `导入=${imported.name}  仓库=${repo.name}`}`)
  report.push(`modules: ${JSON.stringify(imported.modules) === JSON.stringify(repo.modules) ? '一致' : `导入=${imported.modules} 仓库=${repo.modules}`}`)
  report.push(`moduleConfigs: ${JSON.stringify(imported.moduleConfigs) === JSON.stringify(repo.moduleConfigs) ? '一致' : `导入=${JSON.stringify(imported.moduleConfigs)} 仓库=${JSON.stringify(repo.moduleConfigs)}`}`)
  report.push(`promptConfigs 条数: 导入=${imported.promptConfigs.length}  仓库=${repo.promptConfigs.length}`)

  const byId = (list) => new Map(list.map((config) => [config.id, config]))
  const importedMap = byId(imported.promptConfigs)
  const repoMap = byId(repo.promptConfigs)
  const onlyImported = [...importedMap.keys()].filter((id) => !repoMap.has(id))
  const onlyRepo = [...repoMap.keys()].filter((id) => !importedMap.has(id))
  report.push(`仅导入有: ${onlyImported.length > 0 ? onlyImported.join(', ') : '无'}`)
  report.push(`仅仓库有: ${onlyRepo.length > 0 ? onlyRepo.join(', ') : '无'}`)

  let diffCount = 0
  const diffSamples = []
  for (const id of repoMap.keys()) {
    const a = repoMap.get(id)
    const b = importedMap.get(id)
    if (b === undefined) { diffCount += 1; continue }
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      diffCount += 1
      if (diffSamples.length < 5) diffSamples.push(`${id}: 仓库=${JSON.stringify(a).slice(0, 160)}  导入=${JSON.stringify(b).slice(0, 160)}`)
    }
  }
  report.push(`逐条字段差异（同 id 配置 JSON 不等）: ${diffCount} 条`)
  for (const sample of diffSamples) report.push(`  ${sample}`)
}

console.log('')
console.log(report.join('\n'))
rmSync(home, { recursive: true, force: true })
