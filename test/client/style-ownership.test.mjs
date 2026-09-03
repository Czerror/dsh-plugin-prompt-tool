import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/client')

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : /\.(?:ts|tsx)$/.test(entry.name) ? [path] : []
  })
}

const cssClasses = (path) => new Set(
  [...readFileSync(path, 'utf8').matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)].map((match) => match[1]),
)

test('CSS Module：每个 class 引用都由导入模块提供', () => {
  for (const file of sourceFiles(root)) {
    const source = readFileSync(file, 'utf8')
    const maps = new Map()
    for (const match of source.matchAll(/import\s+(\w+)\s+from\s+['"]([^'"]+\.module\.css)['"]/g)) {
      maps.set(match[1], cssClasses(resolve(dirname(file), match[2])))
    }
    for (const match of source.matchAll(/const\s+(\w+)\s*=\s*\{\s*\.\.\.(\w+)\s*,\s*\.\.\.(\w+)\s*\}/g)) {
      maps.set(match[1], new Set([...(maps.get(match[2]) ?? []), ...(maps.get(match[3]) ?? [])]))
    }
    for (const [alias, classes] of maps) {
      for (const match of source.matchAll(new RegExp(`\\b${alias}\\.([A-Za-z_][A-Za-z0-9_]*)`, 'g'))) {
        assert.ok(classes.has(match[1]), `${file.slice(root.length + 1)} 引用缺失样式 ${alias}.${match[1]}`)
      }
    }
  }
})

test('旧 PromptUi 样式入口已删除且源码不再引用', () => {
  for (const file of sourceFiles(root)) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /PromptUi\.module\.css/, file)
  }
})
test('样式遵循宿主 token、发丝边框与圆角契约', () => {
  const cssFiles = readdirSync(root, { withFileTypes: true }).flatMap(function collect(entry) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      return readdirSync(path, { withFileTypes: true }).flatMap((child) => collect({
        ...child,
        name: join(entry.name, child.name),
        isDirectory: () => child.isDirectory(),
      }))
    }
    return entry.name.endsWith('.module.css') ? [path] : []
  })
  for (const path of cssFiles) {
    const source = readFileSync(path, 'utf8')
    assert.doesNotMatch(source, /:root\s*\{/, `${path} 不得定义插件全局主题`)
    assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}|rgba?\(/, `${path} 不得写静态色板`)
    assert.doesNotMatch(source, /border(?:-(?:top|right|bottom|left))?:\s*1px solid var\(--dsw-alias-border-/, `${path} 中性边框必须使用 0.5px`)
    for (const block of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (/border-radius:\s*(?:999px|50%)/.test(block[2])) {
        assert.match(block[2], /corner-shape:\s*round/, `${path} 的圆形/胶囊缺 corner-shape: round`)
      }
    }
  }
})
