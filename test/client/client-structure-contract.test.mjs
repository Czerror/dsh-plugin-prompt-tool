// 合并自 ui-boundary.test.mjs(1) + feature-boundary.test.mjs(2) + structure-baseline.test.mjs(3) + no-host-dom.test.mjs(2)
//（2026-09-17 测试归一精简 Wave 3）：四者同属「客户端结构与边界契约」，全部保持源码契约/禁令的原有形式
//（读源码字符串、目录遍历、AST 级扫描），**不**改写为渲染断言——它们的价值就是低成本快速守卫目录、依赖方向与禁令。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { BRIDGE_ENDPOINTS } from '../../src/shared/bridge-contract.ts'

const clientDir = new URL('../../src/client/', import.meta.url)
const featuresDir = new URL('../../src/client/features/', import.meta.url)
const uiDir = new URL('../../src/client/ui/', import.meta.url)
/** 相对 `src/client/` 读取（原 structure-baseline 的形状）。 */
const read = (file) => readFileSync(new URL(file, clientDir), 'utf8')
/** 相对仓库根读取，路径自带 `src/client/` 前缀（原 no-host-dom 的形状）；两者语义不同故并存。 */
const readFromRoot = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

function sourceFiles(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix + entry.name
    if (entry.isDirectory()) return sourceFiles(new URL(`${entry.name}/`, dir), `${relative}/`)
    return /\.(?:ts|tsx)$/.test(entry.name) ? [relative] : []
  })
}

// —— ui 层依赖边界（原 ui-boundary.test.mjs） ——

test('ui 模块只依赖 React、宿主原子、同层文件与共享样式', () => {
  for (const file of readdirSync(uiDir).filter((name) => /\.(?:ts|tsx)$/.test(name))) {
    const source = readFileSync(new URL(file, uiDir), 'utf8')
    assert.doesNotMatch(source, /from ['"].*\/data\//, `${file} 不得依赖 data`)
    assert.doesNotMatch(source, /from ['"].*\/features\//, `${file} 不得依赖 feature`)
    assert.doesNotMatch(source, /bridgeCall|PromptToolStore/, `${file} 不得读取业务状态或 bridge`)
  }
})

// —— feature 边界与客户端根目录（原 feature-boundary.test.mjs） ——

const featureNames = readdirSync(featuresDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
const siblingImport = new RegExp(`from ['"]\\.\\./(${featureNames.join('|')})/`)

test('feature 不直接导入其他 feature 内部实现', () => {
  for (const feature of featureNames) {
    const dir = new URL(`${feature}/`, featuresDir)
    for (const file of readdirSync(dir).filter((name) => /\.(?:ts|tsx)$/.test(name))) {
      const source = readFileSync(new URL(file, dir), 'utf8')
      assert.doesNotMatch(source, siblingImport, `${feature}/${file} 存在跨 feature 内部依赖`)
    }
  }
})

test('客户端根目录只保留入口、字典、共享类型与待拆样式', () => {
  const files = readdirSync(new URL('../../src/client/', import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()
  assert.deepEqual(files, ['index.ts', 'locales-cards.ts', 'locales-params.ts', 'locales-prompts.ts', 'locales-triggers.ts', 'locales.ts', 'prompt-tool-types.ts'])
})

// —— 结构与接线基线（原 structure-baseline.test.mjs） ——

test('client bridge 调用只使用共享契约 key，不出现字面路径', () => {
  const validKeys = new Set(Object.keys(BRIDGE_ENDPOINTS))
  const calls = []
  for (const file of sourceFiles(clientDir)) {
    const source = read(file)
    assert.doesNotMatch(source, /bridge(?:Post|Upload)(?:<.*>)?\(\s*['"]\//, `${file} 不得调用字面 bridge 路径`)
    for (const match of source.matchAll(/bridgeCall\(\s*['"]([^'"]+)['"]/g)) calls.push({ file, key: match[1] })
  }
  assert.ok(calls.length > 0, '基线应发现类型化 bridge 调用')
  for (const call of calls) assert.ok(validKeys.has(call.key), `${call.file} 使用未声明 endpoint key ${call.key}`)
})

test('工作台顶层页面 id 与顺序保持稳定', () => {
  const source = read('app/workspace/workspace-pages.ts')
  const ids = [...source.matchAll(/id: '([^']+)'/g)].map((match) => match[1])
  assert.deepEqual(ids, ['features', 'subagent', 'tools', 'skills', 'presets', 'characters'])
})

test('浏览器导入复用共享 file input；技能页只使用宿主目录选择', () => {
  for (const file of [
    'features/presets/PresetSwitcher.tsx',
    'features/characters/CharactersPage.tsx',
  ]) {
    const source = read(file)
    assert.match(source, /from ['"]\.\.\/\.\.\/ui\/Import(?:FileButton|Dialog)\.tsx['"]/, `${file} 应复用共享导入入口`)
    assert.doesNotMatch(source, /<input\b[^>]*\btype\s*=\s*(?:["']file["']|\{\s*["']file["']\s*\})/, `${file} 不应手写 file input；允许定位共享组件已有输入`)
  }
  const button = read('ui/ImportFileButton.tsx')
  assert.match(read('ui/ImportDialog.tsx'), /from ['"]\.\/ImportFileButton\.tsx['"]/, '共享弹窗复用唯一文件输入')
  assert.match(button, /<input\b[^>]*\btype="file"/, '共享导入按钮应保留唯一 file input')
  assert.match(button, /webkitdirectory/, '共享导入按钮应支持目录模式')
  const skills = read('features/skills/SkillsPage.tsx')
  assert.match(skills, /api\.pickDirectory\(\)/)
  assert.doesNotMatch(skills, /ImportFileButton|webkitdirectory|type="file"/, '技能页不保留浏览器上传入口')
})

// —— 宿主 DOM 禁令与角色卡分流（原 no-host-dom.test.mjs） ——

test('客户端装配层不自建 root 或观察宿主 DOM（官方 slot + shell.overlay 悬浮入口）', () => {
  for (const file of [
    'src/client/index.ts',
    'src/client/app/workbench/register-workbench.tsx',
    'src/client/app/workbench/SettingsTab.tsx',
  ]) {
    const source = readFromRoot(file)
    assert.ok(!source.includes('MutationObserver'), `${file} 不应观察宿主 DOM`)
    assert.ok(!source.includes('createRoot'), `${file} 不应自建 React root`)
    assert.ok(!source.includes('[class*='), `${file} 不应包含宿主 CSS 类选择器`)
    assert.ok(!source.includes('[data-pane='), `${file} 不应包含宿主 data-pane 选择器`)
    assert.ok(!source.includes('centerCol'), `${file} 不应依赖宿主中央列结构`)
    assert.ok(!source.includes('logoRow'), `${file} 不应依赖宿主侧边栏结构`)
  }

  const css = readFromRoot('src/client/app/workspace/PromptWorkspace.module.css')
  assert.ok(!css.includes('data-dsh-prompt-tool-active'), 'CSS 不应依赖宿主 html active 属性')
  assert.ok(!css.includes('centerCol'), 'CSS 不应依赖宿主中央列结构')
  assert.ok(!css.includes('data-dsh-workspace-slot'), 'CSS 不应探测官方 workspace DOM 槽位')
})

test('角色卡与预设导入共用先暂存后预览的字节传输入口', () => {
  const page = readFromRoot('src/client/features/characters/CharactersPage.tsx')
  const client = readFromRoot('src/client/data/bridge-client.ts')
  assert.match(page, /useImportPreviewFlow/)
  assert.doesNotMatch(page, /bridgeUpload|charactersImportStream/)
  assert.match(client, /BRIDGE_ENDPOINTS\.assetUpload/)
  assert.doesNotMatch(client, /BRIDGE_ENDPOINTS\.charactersImportStream/)
})
