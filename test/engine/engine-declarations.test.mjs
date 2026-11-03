import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 引擎是纯 .mjs，不进 tsc；这里用目标文件自己的 export 语句做真值源，
// 校验每个具名 import 都还有对应导出，防止删导出忘改调用方。
const root = fileURLToPath(new URL('../..', import.meta.url))

function filesUnder(dir, match) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'vendor' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(full, match))
    else if (match(entry.name)) out.push(full)
  }
  return out
}

const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+\.mjs)['"]/g
const EXPORT_DECL_RE = /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g
const EXPORT_LIST_RE = /export\s*\{([^}]*)\}/g

function exportedNames(text) {
  // 星号重导出无法静态枚举，交给运行期；这里刻意跳过而不是误报。
  if (/export\s*\*\s*from/.test(text)) return 'star'
  const names = new Set()
  for (const match of text.matchAll(EXPORT_DECL_RE)) names.add(match[1])
  for (const match of text.matchAll(EXPORT_LIST_RE)) {
    for (const part of match[1].split(',')) {
      const item = part.trim()
      if (item.length === 0) continue
      const asIndex = item.lastIndexOf(' as ')
      names.add(asIndex === -1 ? item : item.slice(asIndex + 4).trim())
    }
  }
  if (/export\s+default\b/.test(text)) names.add('default')
  return names
}

function importedNames(text) {
  const out = []
  for (const match of text.matchAll(IMPORT_RE)) {
    for (const part of match[1].split(',')) {
      const item = part.trim()
      if (item.length === 0 || item.startsWith('type ')) continue
      const asIndex = item.indexOf(' as ')
      out.push({ name: asIndex === -1 ? item : item.slice(0, asIndex).trim(), spec: match[2] })
    }
  }
  return out
}

function missingImports(files) {
  const problems = []
  for (const file of files) {
    const exportsByTarget = new Map()
    for (const { name, spec } of importedNames(readFileSync(file, 'utf8'))) {
      const target = resolve(dirname(file), spec)
      if (!exportsByTarget.has(target)) {
        try {
          exportsByTarget.set(target, exportedNames(readFileSync(target, 'utf8')))
        } catch {
          exportsByTarget.set(target, null)
        }
      }
      const names = exportsByTarget.get(target)
      if (names === 'star') continue
      if (names === null || !names.has(name)) {
        problems.push(file.slice(root.length + 1) + ' 导入了 ' + name + '，但 ' + spec + ' 没有导出它')
      }
    }
  }
  return problems
}

test('engine 内部具名 import 都有对应导出', () => {
  assert.deepEqual(missingImports(filesUnder(join(root, 'engine'), (name) => name.endsWith('.mjs'))), [])
})

test('src 对 engine 的具名 import 都有对应导出', () => {
  assert.deepEqual(missingImports(filesUnder(join(root, 'src'), (name) => name.endsWith('.ts') || name.endsWith('.tsx'))), [])
})
