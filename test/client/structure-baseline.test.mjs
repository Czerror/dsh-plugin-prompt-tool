import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { BRIDGE_ENDPOINTS } from '../../src/shared/bridge-contract.ts'

const clientDir = new URL('../../src/client/', import.meta.url)
const read = (file) => readFileSync(new URL(file, clientDir), 'utf8')

function sourceFiles(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix + entry.name
    if (entry.isDirectory()) return sourceFiles(new URL(`${entry.name}/`, dir), `${relative}/`)
    return /\.(?:ts|tsx)$/.test(entry.name) ? [relative] : []
  })
}

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
  assert.deepEqual(ids, ['features', 'subagent', 'skills', 'presets', 'characters'])
})

test('导入入口统一复用 ImportFileButton，不在业务页重复实现 file input', () => {
  for (const file of [
    'features/skills/SkillsPage.tsx',
    'features/presets/PresetSwitcher.tsx',
    'features/characters/CharactersPage.tsx',
  ]) {
    const source = read(file)
    assert.match(source, /from ['"]\.\.\/\.\.\/ui\/ImportFileButton\.tsx['"]/, `${file} 应复用共享导入按钮`)
    assert.doesNotMatch(source, /type="file"/, `${file} 不应手写 file input`)
  }
  const button = read('ui/ImportFileButton.tsx')
  assert.match(button, /type="file"/, '共享导入按钮应保留唯一 file input')
  assert.match(button, /webkitdirectory/, '共享导入按钮应支持目录模式')
})
