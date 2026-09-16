/**
 * 子代理工具策略「缺失即降级」的引擎行为（单一开关关闭后的运行时语义）。
 *
 * 关闭开关只删除预设顶层 `subagentToolPolicy` 段、保留模块声明，于是生成目录里
 * 没有 `subagent-tools/policy.yml`。引擎必须：不注册 shadow 工具、不抛错阻止预设启动；
 * 而文件存在但内容损坏仍然 fail loud（真错误不能被吞掉）。
 *
 * 有效策略下的正常注册（shadow 工具可用、解析生效）由 `subagent-tool-policy-runtime.test.mjs`
 * 用真实 Cordis/preset scope 覆盖，此处只验证降级与 fail loud 这两条边界。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { apply: applyToolPolicy } = await import('../../engine/subagent-tool-policy.mjs')

/** 引擎按 `new URL(raw, import.meta.url)` 解析 policyFile，绝对路径必须转成 file: URL。 */
const policyUrlOf = (file) => pathToFileURL(file).href

/** 归零的引擎 ctx：注册表 + 工具表 + 事件表，外加 preset scope。 */
function makeCtx() {
  const registered = []
  const listeners = new Map()
  const ctx = {
    logger: { warn: (message) => { ctx.warnings.push(String(message)) } },
    warnings: [],
    get: (name) => {
      if (name === 'tools') return { register: (tool) => { registered.push(tool); return () => {} } }
      if (name === 'agents') return { list: () => [] }
      if (name === 'subagents') return { getProvider: () => undefined }
      if (name === 'llm') return { resolveCallConfig: async () => {} }
      if (name === 'approval') return undefined
      return undefined
    },
    effect: (fn) => { fn(); return () => {} },
    on: (type, handler) => {
      const list = listeners.get(type) ?? []
      list.push(handler)
      listeners.set(type, list)
    },
    emit: (type, payload) => { for (const handler of listeners.get(type) ?? []) handler(payload) },
    tool: {},
  }
  return { ctx, registered, listeners }
}

test('策略文件缺失（开关关闭）：降级不注册 shadow，且不阻止预设启动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-degrade-'))
  try {
    const { ctx, registered } = makeCtx()
    const config = { policyFile: policyUrlOf(join(dir, 'subagent-tools', 'missing-policy.yml')) }
    assert.doesNotThrow(() => applyToolPolicy(ctx, config), '缺文件必须降级而不是抛错')
    assert.equal(registered.length, 0, '不注册 subagent / subagent_fork shadow')
    assert.ok(ctx.warnings.some((line) => line.includes('policy file missing')), '记录一条降级警告')
    // 即使有 agent 创建事件，也不会有 shadow 注册（能力装配了但策略未启用）。
    ctx.emit('agent/created', { agent: { id: 'a1', ctx: { get: () => undefined } } })
    assert.equal(registered.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('策略文件存在但内容损坏：仍然 fail loud，不静默丢弃策略', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-degrade-bad-'))
  try {
    const file = join(dir, 'policy.yml')
    // 合法 YAML 但不是 map：编译前的类型校验会拒绝。
    writeFileSync(file, 'just-a-string\n', 'utf8')
    const { ctx } = makeCtx()
    assert.throws(() => applyToolPolicy(ctx, { policyFile: policyUrlOf(file) }), /cannot load policy/, '内容损坏必须抛错')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('F13 现存策略的校验或 YAML 错误含 ENOENT 仍然拒绝加载', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-degrade-enoent-'))
  try {
    const file = join(dir, 'policy.yml')
    const invalid = {
      defaultProfile: 'ENOENT',
      ceiling: { allow: ['read'] },
      profiles: [{ id: 'default', name: 'Default', allow: ['read'] }],
    }
    for (const raw of [JSON.stringify(invalid), 'defaultProfile: [ENOENT']) {
      writeFileSync(file, raw, 'utf8')
      const { ctx, registered, listeners } = makeCtx()
      assert.throws(() => applyToolPolicy(ctx, { policyFile: policyUrlOf(file) }), /cannot load policy/, '现存文件损坏不得退回普通委派')
      assert.deepEqual(ctx.warnings, [], '不能谎报文件缺失')
      assert.equal(registered.length, 0)
      assert.equal(listeners.size, 0)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
