import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as hostParse } from 'yaml'
import { parse as vendorParse } from '../../engine/vendor/yaml/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 同一份语料在宿主 yaml 与 vendored yaml 上必须产出同值或同错误。 */
function assertSameParse(raw) {
  const run = (parse) => {
    try {
      return { ok: true, value: parse(raw, { logLevel: 'silent' }) }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }
  assert.deepEqual(run(hostParse), run(vendorParse))
}

/** 语料 1：仓库内全部真实 YAML（含注释、块标量、!!js 标签、中文、CRLF）。 */
function collectCorpus() {
  const files = [
    'preset/anchored/preset.yml',
    ...readdirSync(join(root, 'templates'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => join('templates', entry.name)),
    ...readdirSync(join(root, 'templates', 'tools'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => join('templates', 'tools', entry.name)),
    ...readdirSync(join(root, 'engine', 'compositions', 'library'))
      .filter((name) => name.endsWith('.yml'))
      // 参数桥取代 __TOKEN__ 后组合库全部是合法 YAML；保留过滤防御未来引入占位符。
      .filter((name) => !/__[A-Za-z0-9_]+__/.test(readFileSync(join(root, 'engine', 'compositions', 'library', name), 'utf8')))
      .map((name) => join('engine', 'compositions', 'library', name)),
  ]
  return files
    .map((file) => join(root, file))
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, 'utf8'))
}

/** 语料 2：包内 SKILL.md frontmatter（BOM 剥离后两个解析器仍一致）。 */
function collectFrontmatter() {
  const dirs = readdirSync(join(root, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, 'skills', entry.name, 'SKILL.md'))
  return dirs
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, 'utf8'))
    .map((text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text))
    .map((text) => /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1])
    .filter((block) => typeof block === 'string')
}

/** 语料 3：手写边界用例。 */
const trickyCases = [
  'name: demo\n\nblock: |\n  line one\n  line two\nfold: >\n  folded\n  text\n',
  'description: \'value: with colon # not a comment\'\nlist:\n  - 1\n  - "two"\n',
  'meta:\n  nested:\n    a: 1\n  tags: [x, y]\nflags: [on, off, yes, no, true, false]\n',
  'anchor: &base\n  a: 1\nmerge:\n  <<: *base\n  b: 2\n',
  'unicode: 中文与emoji测试\nquoted: "escaped \\"quote\\""\n',
  'multi: [1, 2, 3]\nnull1: null\nnull2: ~\nnumber: 3.14\n',
].map((raw) => raw.replace(/\n/g, '\r\n')) // CRLF 版本也测一遍

test('yaml 双解析器语料一致：宿主 npm yaml 与 vendored yaml', () => {
  const corpus = [...collectCorpus(), ...collectFrontmatter(), ...trickyCases]
  assert.ok(corpus.length >= 30, `corpus should cover real files, got ${corpus.length}`)
  for (const [index, raw] of corpus.entries()) {
    assertSameParse(raw)
    assert.ok(true, `case ${index}`)
  }
})

test('yaml vendor：版本与来源记录完整，且与 node_modules 浏览器构建逐字节一致', () => {
  const vendorPackage = JSON.parse(readFileSync(join(root, 'engine', 'vendor', 'yaml', 'package.json'), 'utf8'))
  const hostPackage = JSON.parse(readFileSync(join(root, 'node_modules', 'yaml', 'package.json'), 'utf8'))
  assert.equal(vendorPackage.version, hostPackage.version)
  assert.ok(vendorPackage.source.includes('npmjs.com/package/yaml'))
  assert.equal(vendorPackage.type, 'module')

  const sourceRoot = join(root, 'node_modules', 'yaml', 'browser')
  const vendorRoot = join(root, 'engine', 'vendor', 'yaml')
  const sourceFiles = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== 'package.json')
    .map((entry) => join(entry.parentPath ?? join(sourceRoot, entry.name), entry.name))
  assert.ok(sourceFiles.length > 50, `expected browser dist tree, got ${sourceFiles.length} files`)
  for (const file of sourceFiles) {
    const relative = file.slice(sourceRoot.length + 1)
    const target = join(vendorRoot, relative)
    assert.ok(existsSync(target), `vendored file missing: ${relative}`)
    assert.equal(readFileSync(target, 'utf8'), readFileSync(file, 'utf8'), `vendored file differs: ${relative}`)
  }
})
