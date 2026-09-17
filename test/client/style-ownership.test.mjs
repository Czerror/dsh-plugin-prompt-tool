import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

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

test('tools feature 布局与中性边框只由 CSS Modules 持有', () => {
  for (const file of sourceFiles(join(root, 'features', 'tools'))) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /style=\{\{/, `${file} 不得内联布局或边框样式`)
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
    assert.doesNotMatch(source, /(?:linear|radial)-gradient\(/, `${path} 不得恢复装饰渐变`)
    assert.doesNotMatch(source, /--dsw-alias-(?:fill-field|label-brand|label-error)\b|--dsw-font-mono\b/, `${path} 使用已发布的语义变量`)
    assert.doesNotMatch(source, /outline:\s*none|outline-offset:\s*-/, `${path} 不得隐藏或内缩焦点轮廓`)
    assert.doesNotMatch(source, /::-webkit-scrollbar|scrollbar-color:/, `${path} 滚动条由宿主主题所有`)
    assert.doesNotMatch(source, /transition:\s*all|translateY\(-1px\)/, `${path} 不得恢复整属性过渡或装饰位移`)
    for (const block of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (/border-radius:\s*(?:999px|50%)/.test(block[2])) {
        assert.match(block[2], /corner-shape:\s*round/, `${path} 的圆形/胶囊缺 corner-shape: round`)
      }
    }
  }
})

test('危险按钮统一为描边染红：data-danger 只落在 .pillButton 上', () => {
  // 官方 Button 没有 danger 变体（primary|ghost|outline|toolbar），data-danger 在它上面
  // 没有任何样式后果；删除确认的确认按钮也曾因此与取消按钮不同高、不同色。
  for (const file of sourceFiles(root)) {
    const source = readFileSync(file, 'utf8')
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ES2024, true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const visit = (node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const attribute = (name) => node.attributes.properties.find(
          (property) => ts.isJsxAttribute(property) && property.name.getText(parsed) === name,
        )
        if (attribute('data-danger') !== undefined) {
          const tag = node.tagName.getText(parsed)
          assert.notEqual(tag, 'Button', `${file.slice(root.length + 1)}：官方 Button 没有 danger 变体，data-danger 不会染红`)
          if (tag === 'button') {
            assert.match(attribute('className')?.initializer?.getText(parsed) ?? '', /pillButton/,
              `${file.slice(root.length + 1)}：危险按钮必须用 .pillButton 才拿到描边染红规则`)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(parsed)
  }
  // 统一的危险形态是描边染红：透明底 + error 混色的文字与描边，不是实心红底。
  const css = readFileSync(join(root, 'ui', 'controls.module.css'), 'utf8')
  const rule = css.match(/\.pillButton\[data-danger\]\s*\{([^{}]*)\}/)
  assert.ok(rule, '缺少 .pillButton[data-danger] 危险形态规则')
  assert.match(rule[1], /color:\s*color-mix\(in srgb, var\(--dsw-alias-state-error-primary\)/)
  assert.match(rule[1], /border-color:\s*color-mix\(in srgb, var\(--dsw-alias-state-error-primary\)/)
  assert.doesNotMatch(rule[1], /background:\s*var\(--dsw-alias-state-error-primary\)/, '危险形态是描边染红，不是实心红底')
  assert.match(css, /\.pillButton\[data-danger\]:hover:not\(:disabled\)/, '危险按钮的 hover 仍走同一形态')
  // 取消与确认必须同族：两者都是 .pillButton，只在 data-danger 上分主次。
  const dialog = readFileSync(join(root, 'ui', 'ConfirmDialog.tsx'), 'utf8')
  assert.match(dialog, /styles\.pillButton\}/)
  assert.match(dialog, /className=\{styles\.pillButton\} data-danger/)
})
