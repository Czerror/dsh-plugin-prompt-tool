import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'

const soul = await import(new URL('../../engine/soul-tools.mjs', import.meta.url).href)
const kit = await import(new URL('../../engine/soul/kit-bridge.mjs', import.meta.url).href)
const { prepareAssembly } = await import('../../src/runtime/agent-assembly.ts')

function register() {
  const tools = []
  soul.apply({ tools: { register: (definition) => { tools.push(definition); return () => {} } } })
  return new Map(tools.map(tool => [tool.name, tool]))
}

test('soul-tools 行：注册 8 个工具，语料随包可读', async () => {
  const tools = register()
  assert.deepEqual([...tools.keys()].sort(), [
    'agent_soul_check', 'agent_soul_doctor', 'agent_soul_install', 'agent_soul_layers',
    'agent_soul_manifest', 'agent_soul_plan', 'agent_soul_scaffold', 'agent_soul_verify',
  ])
  const layers = await tools.get('agent_soul_layers').execute({}, {})
  assert.equal(layers.ok, true)
  assert.match(layers.text, /五层/)
  const manifest = await tools.get('agent_soul_manifest').execute({}, {})
  assert.equal(manifest.layers.length, 5)
  const doctor = await tools.get('agent_soul_doctor').execute({}, {})
  assert.equal(doctor.ok, true)
  assert.match(doctor.text, /七/)
})

test('soul-tools roots：盘根、系统目录、用户主目录与同目录复用均拒绝', () => {
  const root = mkdtempSync(join(tmpdir(), 'pt-soul-roots-'))
  try {
    assert.throws(() => kit.envFromArgs({ soul: parse(root).root }), /盘根/)
    assert.throws(() => kit.envFromArgs({ soul: homedir() }), /用户主目录/)
    assert.deepEqual(kit.envFromArgs({ soul: root }), { ECHO_SOUL: root })
    assert.throws(() => kit.envFromArgs({ soul: root, memory: root }), /同一个目录/)
    if (process.platform === 'win32') assert.throws(() => kit.envFromArgs({ soul: 'C:\\Windows\\soul' }), /系统目录/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('内置 soul 模块：声明 soul-tools 并编译 8 条规则', async () => {
  const moduleRoot = fileURLToPath(new URL('../../modules/', import.meta.url))
  const assembly = await prepareAssembly(moduleRoot, 'soul', () => true)
  assert.deepEqual(assembly.modules.map(module => module.id), ['soul-tools'])
  assert.ok(assembly.rules.length >= 8, '规则应全部编译')
})
