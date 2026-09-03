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
  const source = read('PromptWorkspace.tsx')
  const block = source.slice(source.indexOf('const TOP_PAGES'), source.indexOf('/** 侧边栏独立工作台'))
  const ids = [...block.matchAll(/id: '([^']+)'/g)].map((match) => match[1])
  assert.deepEqual(ids, ['features', 'subagent', 'skills', 'presets', 'characters'])
})
