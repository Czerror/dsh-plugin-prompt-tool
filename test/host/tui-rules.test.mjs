import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-tui-rules-')
const { registerTuiCommand } = await import('../../src/runtime/tui.ts')
const { readModulesEnabled } = await import('../../src/shared/module-settings.ts')
const { resolveRequestedModuleDir } = await import('../../src/host/config-store.ts')
const { DEFAULT_MODULE_ID } = await import('../../src/shared/module-ids.ts')

test('TUI 主语由用户声明：会话声明后随后命令都作用在它上面，单条前缀可覆盖，未声明即拒', async () => {
  const dir = join(moduleRoot, 'tui-rules')
  mkdirSync(dir, { recursive: true })
  const body = id => ({ id, name: id, group: 'mode', exclusive: true, enabled: id === 'first', then: [{ id: 'body', kind: 'inject-text', config: { layer: 'pre-step', text: id } }] })
  const file = join(dir, 'module.yml')
  writeFileSync(file, JSON.stringify({ id: 'tui-rules', modules: [], configOrder: { first: 0, second: 100 }, rules: [body('first'), body('second')] }))
  const otherDir = join(moduleRoot, 'tui-other')
  mkdirSync(otherDir, { recursive: true })
  writeFileSync(join(otherDir, 'module.yml'), JSON.stringify({ id: 'tui-other', modules: [], rules: [] }))
  let handler
  let refreshes = 0
  let rejectRefresh = false
  const savedParams = []
  const ctx = { inject: (_deps, callback) => callback({ commands: { register: command => { handler = command.handler } } }) }
  registerTuiCommand(ctx, 'prompt-tool', () => ({ modulesEnabled: true, skillCatalog: [], activeSkillsDirs: [], enabledModules: ['tui-rules', 'tui-other'] }),
    () => ({ available: true, providers: [] }), async () => ({}),
    moduleId => resolveRequestedModuleDir(moduleRoot, moduleId),
    async (moduleId, key, value) => { savedParams.push([moduleId, key, value]) }, undefined, async id => {
      assert.equal(id, 'tui-rules'); refreshes++
      // 复刻下游真实措辞（agent-assembly 的刷新失败句）：它只说装配，不再自称「已保存」。
      if (rejectRefresh) throw new Error('运行时配装更新失败：模块 tui-rules 装配失败')
    })
  const session = { id: 'tui-session' }, peer = { id: 'peer-session' }
  const call = (rawInput, agent = session) => handler({ rawInput, agent })
  const initial = readFileSync(file, 'utf8')

  // ④ `module` 无参显示声明状态；此时两个会话都还没声明。
  assert.match((await call('module')).text, /未声明模块目标/)
  assert.match((await call('module', peer)).text, /未声明模块目标/)
  // ② 既没带主语、会话也没声明过 → 拒绝，一个字节都不动。
  for (const rawInput of ['config second on', 'toggle instructionHint']) {
    const noSubject = await call(rawInput)
    assert.equal(noSubject.kind, 'error', rawInput)
    assert.match(noSubject.text, /没有声明模块目标/)
  }
  assert.equal(readFileSync(file, 'utf8'), initial, '无主语零写入')
  assert.equal(refreshes, 0)
  assert.deepEqual(savedParams, [])
  // 声明不成立就不记：错 id 不能把会话主语悄悄换掉。
  const noSuchModule = await call('module no-such-module')
  assert.equal(noSuchModule.kind, 'error')
  assert.match(noSuchModule.text, /no-such-module/)
  assert.match((await call('module')).text, /未声明模块目标/)

  // ① 声明 A 后，不带前缀的命令都作用在 A 上（落盘产物断言）。
  const declared = await call('module tui-rules')
  assert.equal(declared.kind, 'success', declared.text)
  assert.equal((await call('module')).text, '本次会话主语：tui-rules')
  const missingRule = await call('config missing on')
  assert.equal(missingRule.kind, 'error')
  assert.match(missingRule.text, /未找到规则 missing/)
  assert.equal(readFileSync(file, 'utf8'), initial, '未知身份零写入')
  assert.equal(refreshes, 0)
  const activated = await call('config second on')
  assert.equal(activated.kind, 'success', activated.text)
  const saved = parse(readFileSync(file, 'utf8'))
  assert.deepEqual(saved.rules.map(rule => [rule.id, rule.enabled]), [['first', false], ['second', true]], '启用序号在后的卡也关闭同组前卡')
  assert.deepEqual(saved.configOrder, { first: 0, second: 100 }, '启用互斥不重排')
  assert.deepEqual(saved.rules[1].then, body('second').then, '不覆盖动作数组')
  assert.equal(refreshes, 1)
  const status = await call('status')
  assert.match(status.text, /config second.*开/)
  assert.match(status.text, /inject-text/)
  assert.match(status.text, /^module\s+tui-rules$/m, '状态回显当前会话主语')
  assert.match(status.text, /^enabledModules\s+tui-rules、tui-other$/m, '状态回显装配集合')
  // 参数写入路径同样吃会话主语；包内默认模块不是任何写盘目标。
  const paramSwitch = await call('toggle instructionHint')
  assert.equal(paramSwitch.kind, 'success', paramSwitch.text)
  assert.deepEqual(savedParams, [['tui-rules', 'instructionHint', true]])
  assert.equal(existsSync(join(moduleRoot, DEFAULT_MODULE_ID)), false)
  // 声明不跨会话共享：另一个 Agent 没声明过，照样拒绝。
  const peerWrite = await call('config second off', peer)
  assert.equal(peerWrite.kind, 'error')
  assert.match(peerWrite.text, /没有声明模块目标/)
  assert.match((await call('module', peer)).text, /未声明模块目标/)
  assert.equal(refreshes, 1)
  rejectRefresh = true
  const failed = await call('config second off')
  assert.equal(failed.kind, 'error')
  // 真值源：用户看到的那一整句——「已保存」由 TUI 说一次，下游只说装配失败。
  assert.equal(failed.text, '规则已保存，但重新装配失败：运行时配装更新失败：模块 tui-rules 装配失败')
  assert.equal(parse(readFileSync(file, 'utf8')).rules[1].enabled, false)

  // ③ 单条命令前的前缀覆盖会话主语：`module B <cmd>` 落在 B，并成为新的会话主语。
  const overridden = await call('module tui-other toggle instructionHint')
  assert.equal(overridden.kind, 'success', overridden.text)
  assert.deepEqual(savedParams[1], ['tui-other', 'instructionHint', true])
  assert.equal((await call('module')).text, '本次会话主语：tui-other')
  assert.equal(parse(readFileSync(file, 'utf8')).rules[1].enabled, false, '覆盖只换了主语，没再动 A')

  // 子命令校验先于记主语：非法子命令只报用法，不把会话主语换掉。
  await call('module tui-rules')
  const bogus = await call('module tui-other bogus-subcommand')
  assert.equal(bogus.kind, 'error')
  assert.match(bogus.text, /用法/)
  assert.equal((await call('module')).text, '本次会话主语：tui-rules', '非法子命令不改会话主语')
})

test('TUI 非法模块 id 不解引用到存储根之外：拒绝、零写盘，且不记作会话主语', async () => {
  // 存储根同级放一个模块目录：`module ../evil …` 不得借它读写存储根之外的定义。
  const evilFile = join(moduleRoot, '..', 'evil', 'module.yml')
  mkdirSync(join(moduleRoot, '..', 'evil'), { recursive: true })
  writeFileSync(evilFile, JSON.stringify({ id: 'evil', modules: [], rules: [{ id: 'second', name: 'second', enabled: false, then: [{ id: 'body', kind: 'inject-text', config: { text: 'OUTSIDE' } }] }] }))
  let handler
  const savedParams = []
  let refreshes = 0
  const ctx = { inject: (_deps, callback) => callback({ commands: { register: command => { handler = command.handler } } }) }
  registerTuiCommand(ctx, 'prompt-tool', () => ({ modulesEnabled: true, skillCatalog: [], activeSkillsDirs: [], enabledModules: ['tui-rules'] }),
    () => ({ available: true, providers: [] }), async () => ({}),
    moduleId => resolveRequestedModuleDir(moduleRoot, moduleId),
    async (moduleId, key, value) => { savedParams.push([moduleId, key, value]) }, undefined, async () => { refreshes++ })
  const call = rawInput => handler({ rawInput, agent: { id: 'evil-session' } })
  const bytes = readFileSync(evilFile, 'utf8')
  for (const rawInput of ['module ../evil config second on', 'module ../evil toggle instructionHint', 'module ..', 'module ../evil']) {
    const rejected = await call(rawInput)
    assert.equal(rejected.kind, 'error', rawInput)
    assert.match(rejected.text, /未找到模块|没有声明模块目标/)
  }
  assert.equal(readFileSync(evilFile, 'utf8'), bytes, '存储根之外零写盘')
  assert.deepEqual(savedParams, [])
  assert.equal(refreshes, 0)
  assert.match((await call('module')).text, /未声明模块目标/, '非法声明不记作会话主语')
})

test('TUI直接官方settings事务切换总闸', async () => {
  for (const old of [true, false]) {
    const value = { modulesEnabled: old }
    const calls = []
    let handler
    const ctx = { inject: (_deps, callback) => callback({
      commands: { register: command => { handler = command.handler } },
      settings: { mutate: async (ns, ops) => {
        assert.equal(ns, 'prompt-tool')
        calls.push(ops)
        for (const op of ops) {
          if (op.op === 'unset') delete value[op.path[0]]
          else value[op.path[0]] = op.value
        }
      } },
    }) }
    registerTuiCommand(ctx, 'prompt-tool', () => ({ modulesEnabled: readModulesEnabled(value), skillCatalog: [], activeSkillsDirs: [] }),
      () => ({ available: true, providers: [] }), async () => ({}))
    const result = await handler({ rawInput: 'toggle modulesEnabled' })
    assert.equal(result.kind, 'success', result.text)
    assert.deepEqual(calls, [[{ op: 'set', path: ['modulesEnabled'], value: !old }]])
    assert.deepEqual(value, { modulesEnabled: !old })
  }
})
