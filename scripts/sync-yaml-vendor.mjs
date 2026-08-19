/**
 * sync-yaml-vendor — 刷新 engine/vendor/yaml。
 *
 * 生成目录里的引擎必须在没有插件 node_modules 的环境运行，因此运行时 YAML
 * 解析器使用 npm `yaml` 的浏览器 ESM 构建（node_modules/yaml/browser），
 * 由本脚本整体同步进 engine/vendor/yaml：
 *   - browser/index.js（default 导出包装）
 *   - browser/dist/（完整 ESM 实现，与源码逐字节一致）
 *   - LICENSE
 *   - 元数据 package.json（记录版本与来源）
 *
 * 用法：pnpm sync:yaml
 * 升级流程：pnpm add -D yaml@<version>（或按依赖范围重装）→ pnpm sync:yaml
 *           → 跑 test/engine/yaml-vendor-parity.test.mjs 验证双解析器一致。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = join(root, 'node_modules', 'yaml')
const targetRoot = join(root, 'engine', 'vendor', 'yaml')

const packagePath = join(sourceRoot, 'package.json')
if (!existsSync(packagePath)) {
  console.error('sync-yaml-vendor: node_modules/yaml not found — run `pnpm install` first.')
  process.exit(1)
}

const sourcePackage = JSON.parse(readFileSync(packagePath, 'utf8'))
const version = typeof sourcePackage.version === 'string' ? sourcePackage.version : 'unknown'

rmSync(targetRoot, { recursive: true, force: true })
mkdirSync(targetRoot, { recursive: true })
cpSync(join(sourceRoot, 'browser', 'index.js'), join(targetRoot, 'index.js'))
cpSync(join(sourceRoot, 'browser', 'dist'), join(targetRoot, 'dist'), { recursive: true })
cpSync(join(sourceRoot, 'LICENSE'), join(targetRoot, 'LICENSE'))
writeFileSync(
  join(targetRoot, 'package.json'),
  JSON.stringify(
    {
      name: 'yaml-vendor',
      version,
      private: true,
      type: 'module',
      description: 'Vendored ESM build of npm `yaml` for the generated agent preset runtime (zero external dependency).',
      source: 'https://www.npmjs.com/package/yaml',
      vendoredFrom: 'node_modules/yaml/browser (ESM dist)',
      license: typeof sourcePackage.license === 'string' ? sourcePackage.license : 'ISC',
      repository: typeof sourcePackage.repository === 'string' ? sourcePackage.repository : 'github:eemeli/yaml',
    },
    null,
    2,
  ) + '\n',
  'utf8',
)
console.log(`sync-yaml-vendor: engine/vendor/yaml refreshed from npm yaml@${version}`)
