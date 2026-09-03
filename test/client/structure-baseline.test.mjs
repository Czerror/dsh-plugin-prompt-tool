import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { BRIDGE_ENDPOINTS } from '../../src/shared/bridge-contract.ts'

const clientDir = new URL('../../src/client/', import.meta.url)
const read = (file) => readFileSync(new URL(file, clientDir), 'utf8')

test('client bridge 字面路径全部属于共享契约', () => {
  const valid = new Set(Object.values(BRIDGE_ENDPOINTS))
  const calls = []
  for (const file of readdirSync(clientDir).filter((name) => /\.(?:ts|tsx)$/.test(name))) {
    for (const line of read(file).split(/\r?\n/)) {
      const match = line.match(/bridge(?:Post|Upload)(?:<.*>)?\(\s*['"]([^'"]+)['"]/) 
      if (match !== null) calls.push({ file, path: match[1] })
    }
  }
  assert.ok(calls.length > 0, '基线应发现 bridge 调用')
  for (const call of calls) assert.ok(valid.has(call.path), `${call.file} 使用未声明路径 ${call.path}`)
})

test('工作台顶层页面 id 与顺序保持稳定', () => {
  const source = read('PromptWorkspace.tsx')
  const block = source.slice(source.indexOf('const TOP_PAGES'), source.indexOf('/** 侧边栏独立工作台'))
  const ids = [...block.matchAll(/id: '([^']+)'/g)].map((match) => match[1])
  assert.deepEqual(ids, ['features', 'subagent', 'skills', 'presets', 'characters'])
})
