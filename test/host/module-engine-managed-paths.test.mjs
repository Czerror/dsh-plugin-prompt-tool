import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-module-write-')
const writer = await import('../../src/host/write-module.ts')
const { prepareAssembly } = await import('../../src/runtime/agent-assembly.ts')

function moduleDirectory(id, extra = {}) {
  const directory = join(moduleRoot, id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'module.yml'), JSON.stringify({ id, modules: [], rules: [], ...extra }))
  return directory
}

test('重建只恢复 rules 并清理旧产物，资产与完整定义原字节保留', () => {
  const directory = moduleDirectory('minimal')
  const definition = readFileSync(join(directory, 'module.yml'))
  for (const file of ['memory.md', 'notes.txt', 'preset.md', 'agents.md']) writeFileSync(join(directory, file), `USER ${file}`)
  mkdirSync(join(directory, 'skills'))
  writeFileSync(join(directory, 'skills', 'SKILL.md'), 'USER SKILL')
  for (const name of ['configs', 'custom-tools', 'subagent-tools']) mkdirSync(join(directory, name))
  for (const name of ['rules.yml', 'agent.cordis.yml']) writeFileSync(join(directory, name), 'OLD')
  writer.ensureModuleReady('minimal', { modulesRoot: moduleRoot })
  assert.deepEqual(readFileSync(join(directory, 'module.yml')), definition)
  for (const file of ['memory.md', 'notes.txt', 'preset.md', 'agents.md']) assert.equal(readFileSync(join(directory, file), 'utf8'), `USER ${file}`)
  assert.equal(readFileSync(join(directory, 'skills', 'SKILL.md'), 'utf8'), 'USER SKILL')
  for (const name of ['configs', 'custom-tools', 'subagent-tools', 'rules.yml', 'agent.cordis.yml']) assert.equal(existsSync(join(directory, name)), false)
  assert.equal(existsSync(join(directory, 'rules', '_settings.yml')), true)
})

test('writeModule 暂存候选保持目标身份，失败保留原目标且拒绝越界 id', () => {
  const source = moduleDirectory('source')
  const target = moduleDirectory('target')
  writeFileSync(join(source, 'memory.md'), 'SOURCE MEMORY')
  writeFileSync(join(target, 'memory.md'), 'TARGET MEMORY')
  const staged = writer.writeModule({ modulesRoot: moduleRoot, moduleId: 'source', targetModuleId: 'target', sourceDir: source, stageOnly: true })
  assert.equal(basename(staged), 'target')
  assert.equal(JSON.parse(readFileSync(join(target, 'module.yml'), 'utf8')).id, 'target')
  assert.equal(readFileSync(join(target, 'memory.md'), 'utf8'), 'TARGET MEMORY')
  assert.equal(readFileSync(join(staged, 'memory.md'), 'utf8'), 'SOURCE MEMORY')
  assert.equal(existsSync(join(staged, 'rules', '_settings.yml')), true)
  writeFileSync(join(source, 'module.yml'), JSON.stringify({ id: 'source', modules: [], customTools: [{}] }))
  assert.throws(() => writer.writeModule({ modulesRoot: moduleRoot, moduleId: 'source', targetModuleId: 'target', sourceDir: source }), /customTools/)
  assert.equal(readFileSync(join(target, 'memory.md'), 'utf8'), 'TARGET MEMORY')
  assert.throws(() => writer.writeModule({ modulesRoot: moduleRoot, moduleId: '../outside' }), /id/)
})

test('配装仅从定义内联工具和策略，旧目录不再决定运行内容', async () => {
  const tool = { id: 'confirm', description: '确认', output: { schema: { type: 'json' } }, execute: { kind: 'ask-user' } }
  const directory = moduleDirectory('inline', { modules: ['tool-config-engine', 'subagent-tool-policy'], customTools: [tool] })
  const prepared = await prepareAssembly(moduleRoot, 'inline', () => true)
  const custom = prepared.modules.find(module => module.id === 'tool-config-engine')
  assert.deepEqual(custom.config.tools.map(tool => tool.name), ['confirm'])
  assert.deepEqual(custom.config.tools[0].output.schema, {})
  assert.equal(typeof custom.config.resourceRoot, 'string')
  assert.equal(prepared.modules.some(module => module.id === 'subagent-tool-policy'), false, '策略段缺失即停用')
  assert.equal(existsSync(join(directory, 'custom-tools')), false)
  const policy = { defaultProfile: 'read', ceiling: { allow: ['read'] }, profiles: [{ id: 'read', name: '只读', allow: ['read'] }] }
  writeFileSync(join(directory, 'module.yml'), JSON.stringify({ id: 'inline', modules: [], rules: [], subagentToolPolicy: policy }))
  const enabled = await prepareAssembly(moduleRoot, 'inline', () => true)
  assert.deepEqual(enabled.modules.find(module => module.id === 'subagent-tool-policy').config.policy, policy)
})
