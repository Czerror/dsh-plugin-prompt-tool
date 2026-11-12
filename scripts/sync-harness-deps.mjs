// 固定源码构建输入；只生成 ignored 安装配置，不修改 manifest 或自动安装。
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { DSH_SOURCE_SHA } from './harness-source.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const sourceArg = process.argv.indexOf('--source-root')
const check = process.argv.includes('--check')
const sourceInput = sourceArg < 0 && check
  ? JSON.parse(readFileSync(join(root, '.scratch/harness/local.json'), 'utf8')).sourceRoot
  : process.argv[sourceArg + 1]
if (sourceArg < 0 && !check || !sourceInput) throw new Error('首次必须显式提供 --source-root <固定官方源码构建目录>')
const sourceRoot = resolve(sourceInput)
const sha = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
if (sha !== DSH_SOURCE_SHA) throw new Error(`源码 SHA 不匹配：${sha}`)
const tag = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'dsh-v0.2.2-rc.2^{commit}'], { encoding: 'utf8' }).trim()
if (tag !== sha) throw new Error('固定官方 tag 不匹配')
if (execFileSync('git', ['-C', sourceRoot, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()) throw new Error('固定源码存在已跟踪文件改动')
const { parse } = createRequire(join(sourceRoot, 'packages/settings/settings/package.json'))('yaml')
const target = join(sourceRoot, 'apps/desktop/.desktop-build/targets/win-x64')
const output = join(root, '.scratch/harness')
const packages = {}
const overrides = {}
const integrity = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`
for (const family of ['vendor', 'dsh']) {
  const packed = join(target, 'packed', family)
  for (const filename of readdirSync(packed).filter(name => name.endsWith('.tgz')).sort()) {
    const archive = join(packed, filename)
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32/tar.exe') : 'tar'
    const manifest = JSON.parse(execFileSync(tar, ['-xOf', archive, 'package/package.json'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }))
    if (!manifest.name.startsWith('@deepseek-ai/')) throw new Error(`非官方构建包：${manifest.name}`)
    if (manifest.name.startsWith('@deepseek-ai/dsh-') && manifest.version !== '0.2.2-rc.2') throw new Error(`构建版本不匹配：${manifest.name}@${manifest.version}`)
    const path = `.scratch/harness/packages/${filename}`
    const bytes = readFileSync(archive)
    const entry = manifest.main ?? manifest.types
    const entryHash = typeof entry === 'string'
      ? createHash('sha256').update(execFileSync(tar, ['-xOf', archive, `package/${entry.replace(/^\.\//, '')}`], { maxBuffer: 64 * 1024 * 1024 })).digest('hex')
      : undefined
    packages[manifest.name] = { version: manifest.version, path, integrity: integrity(bytes), ...(entryHash ? { entry, entryHash } : {}) }
    overrides[manifest.name] = `file:${path}`
    if (check) {
      if (integrity(readFileSync(join(root, path))) !== integrity(bytes)) throw new Error(`本地产物漂移：${filename}`)
    } else {
      mkdirSync(join(output, 'packages'), { recursive: true })
      copyFileSync(archive, join(root, path))
    }
  }
}
const workspace = parse(readFileSync(join(sourceRoot, 'pnpm-workspace.yaml'), 'utf8'))
const pi = '@earendil-works/pi-ai@1.3.0'
const patchSource = workspace.patchedDependencies?.[pi]
if (!patchSource) throw new Error('固定源码缺少 PI 1.3.0 官方 patch')
const patchPath = '.scratch/harness/patches/pi-ai-1.3.0.patch'
const patchBytes = readFileSync(join(sourceRoot, patchSource))
if (!check) {
  mkdirSync(join(output, 'patches'), { recursive: true })
  copyFileSync(join(sourceRoot, patchSource), join(root, patchPath))
} else if (integrity(readFileSync(join(root, patchPath))) !== integrity(patchBytes)) throw new Error('PI 官方 patch 漂移')
overrides['@earendil-works/pi-ai'] = '1.3.0'
const config = { overrides, patchedDependencies: { [pi]: patchPath } }
const hook = `// Generated from official source ${sha}; do not edit.\nmodule.exports = { hooks: { updateConfig(config) { return { ...config, overrides: { ...config.overrides, ...${JSON.stringify(config.overrides)} }, patchedDependencies: { ...config.patchedDependencies, ...${JSON.stringify(config.patchedDependencies)} } }; } } };\n`
const baseline = JSON.stringify({ sha, packages, patches: { [pi]: { path: patchPath, integrity: integrity(patchBytes) } } }, null, 2) + '\n'
for (const [name, content] of [['pnpmfile.cjs', hook], ['source.json', baseline]]) {
  if (check) {
    if (readFileSync(join(output, name), 'utf8') !== content) throw new Error(`生成输入漂移：${name}`)
  } else writeFileSync(join(output, name), content)
}
if (!check) writeFileSync(join(output, 'local.json'), JSON.stringify({ sourceRoot }) + '\n')
console.log(`固定源码 ${sha}；${Object.keys(packages).length} 个官方 tarball；PI 1.3.0 + 官方 patch。`)
console.log('安装：pnpm install --pnpmfile .scratch/harness/pnpmfile.cjs（首次添加 --no-frozen-lockfile，后续 --frozen-lockfile）')
