/**
 * B2 T2/T3 迁移对拍：engine/run-code-env.mjs 与 engine/tool-git-bash.mjs。
 *
 * B2 的硬约束是「除 `enabled` 的 fail loud 外，逐字段的校验结果与错误消息必须与迁移前
 * 逐字一致」。因此本文件把**迁移前的实现**（HEAD ebb0d1e 的 apply 前置校验链，逐字复制为
 * 下面的 legacy* 函数）与模块现在的字段声明放在同一组输入下对拍：
 *   (a) 抛/不抛一致，(b) 抛错消息逐字一致，(c) 归一化对象逐字段相等，(d) 未知键行为一致。
 * 装配层另有一组断言，证明声明确实被 apply 消费（不是与运行路径脱节的死声明）。
 *
 * 已声明的唯一行为变更（PLAN T3）：`tool-git-bash` 新增 `enabled` 键——迁移前写 `enabled`
 * 会命中「未知配置键」，现在它是能力开关且非布尔值 fail loud。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { booleanOption, requiredInt, validateConfig } from '../../engine/shared.mjs'
import {
  apply as applyRunCodeEnv,
  configContract as runCodeEnvContract,
  normalizeEnvKeys,
} from '../../engine/run-code-env.mjs'
import { apply as applyGitBash, configContract as gitBashContract } from '../../engine/tool-git-bash.mjs'
import { compositionConfig } from '../fixtures/composition-defaults.mjs'

// —— 迁移前的实现（HEAD ebb0d1e 逐字复制，作为对拍基准，不参与运行路径） ——

const LEGACY_ENV_ALLOWED = new Set(['enabled', 'envKeys'])
const LEGACY_GIT_BASH_ALLOWED = new Set(['bashPath', 'timeoutMs', 'maxOutputBytes'])

const LEGACY_ENV_KEYS_MESSAGES = {
  missing: 'run-code-env: envKeys must be a non-empty array of env var names — 白名单归模板/预设，请在本预设或组合源提供',
  empty: 'run-code-env: envKeys must contain at least one non-empty env var name',
}

/** 迁移前的 normalizeEnvKeys：空数组/非数组抛「缺失」，trim 后为空抛「无有效项」。 */
function legacyNormalizeEnvKeys(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(LEGACY_ENV_KEYS_MESSAGES.missing)
  }
  const keys = value.map((key) => (typeof key === 'string' ? key.trim() : ''))
    .filter((key) => key.length > 0)
  if (keys.length === 0) {
    throw new TypeError(LEGACY_ENV_KEYS_MESSAGES.empty)
  }
  return [...new Set(keys)]
}

/** 迁移前 run-code-env 的 apply 前置校验链（校验顺序与原实现一致）。 */
function legacyRunCodeEnvGate(config) {
  const source = validateConfig('run-code-env', config, LEGACY_ENV_ALLOWED)
  const enabled = booleanOption('run-code-env', source.enabled, 'enabled', false)
  return { enabled, envKeys: legacyNormalizeEnvKeys(source.envKeys) }
}

/** 迁移后同一个闸门：字段声明直接给出同一个对象。 */
function migratedRunCodeEnvGate(config) {
  const { enabled, envKeys } = runCodeEnvContract.parse(config, 'run-code-env')
  return { enabled, envKeys }
}

/** 迁移前 tool-git-bash 的 apply 前置校验链（无 enabled 键）。 */
function legacyGitBashGate(config) {
  const source = validateConfig('tool-git-bash', config, LEGACY_GIT_BASH_ALLOWED)
  const bashPath = typeof source.bashPath === 'string' && source.bashPath.length > 0 ? source.bashPath : undefined
  return {
    bashPath,
    timeoutMs: requiredInt('tool-git-bash', source.timeoutMs, 'timeoutMs', 1),
    maxOutputBytes: requiredInt('tool-git-bash', source.maxOutputBytes, 'maxOutputBytes', 1),
  }
}

/** 迁移后同一个闸门（enabled 另测，故这里只取三个迁移前就存在的字段）。 */
function migratedGitBashGate(config) {
  const { bashPath, timeoutMs, maxOutputBytes } = gitBashContract.parse(config, 'tool-git-bash')
  return { bashPath, timeoutMs, maxOutputBytes }
}

// —— 对拍工具 ——

function caught(fn) {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    return { ok: false, error }
  }
}

function labelOf(input) {
  if (input === undefined) return 'undefined'
  try {
    return JSON.stringify(input) ?? String(input)
  } catch {
    return String(input)
  }
}

/** 同一输入下：抛/不抛、错误消息、归一化对象三者必须与迁移前一致。 */
function expectSameGate(legacyGate, migratedGate, inputs) {
  for (const input of inputs) {
    const label = labelOf(input)
    const before = caught(() => legacyGate(input))
    const after = caught(() => migratedGate(input))
    assert.equal(
      after.ok,
      before.ok,
      `${label}: 抛/不抛必须一致（迁移前 ${before.ok ? '通过' : before.error.message}）`,
    )
    if (before.ok) {
      assert.deepEqual(after.value, before.value, `${label}: 归一化对象逐字段相等`)
    } else {
      assert.equal(after.error.message, before.error.message, `${label}: 错误消息逐字一致`)
    }
  }
}

// —— 装配桩 ——

/** tool-git-bash 装配桩：记录注册的工具、可执行文件解析与 spawn 规格。 */
function gitBashHarness(config) {
  const calls = { tools: [], resolved: [], spawns: [] }
  const ctx = {
    subprocess: {
      resolveExecutable: async (path) => {
        calls.resolved.push(path)
        return `resolved:${path}`
      },
      spawn: (spec) => {
        calls.spawns.push(spec)
        // 永不自行退出：超时/中止由被测代码的 AbortController 驱动。
        const done = new Promise((resolve) => {
          spec.signal?.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }), { once: true })
        })
        return {
          done,
          collected: {
            stdout: { readFrom: () => ({ text: '' }) },
            stderr: { readFrom: () => ({ text: '' }) },
          },
        }
      },
    },
    tools: { register: (tool) => calls.tools.push(tool) },
  }
  applyGitBash(ctx, config)
  return calls
}

/** run-code-env 装配桩：记录提示段注册与 run_code 补丁。 */
function runCodeEnvHarness(config) {
  const listeners = new Map()
  let section
  const runTool = { name: 'run_code', execute: async (args) => ({ code: args.code }) }
  const ctx = {
    on: (event, handler) => listeners.set(event, handler),
    get: () => undefined,
    tools: {
      get: (name) => (name === 'run_code' ? runTool : undefined),
      schemas: () => [{ name: 'run_code' }],
    },
    systemPrompt: { section: (definition) => { section = definition } },
  }
  applyRunCodeEnv(ctx, config)
  /** 触发 system-prompt/assemble 通道，让 enabled 时的补丁路径真的跑到。 */
  const assemble = async (scope = {}) => {
    const handler = listeners.get('system-prompt/assemble')
    assert.ok(handler, '应注册 system-prompt/assemble 监听')
    return handler({}, { scope }, async () => ({}))
  }
  return { runTool, getSection: () => section, listeners, assemble }
}

// —— run-code-env 对拍 ——

test('run-code-env：迁移前后配置闸门逐字对拍（含两条 envKeys 消息与未知键）', () => {
  expectSameGate(legacyRunCodeEnvGate, migratedRunCodeEnvGate, [
    undefined,
    null,
    [],
    'not-a-config',
    {},
    { enabled: true, envKeys: ['PATH'] },
    { enabled: false, envKeys: ['PATH'] },
    { enabled: 'yes', envKeys: ['PATH'] },
    { enabled: 1, envKeys: ['PATH'] },
    { enabled: null, envKeys: ['PATH'] },
    { envKeys: ['PATH', ' PATH ', 'HOME', 'PATH'] },
    { envKeys: ['  '] },
    { envKeys: [] },
    { envKeys: 'PATH' },
    { envKeys: null },
    { envKeys: {} },
    { envKeys: [['nested']] },
    // 迁移前对**非字符串项**是宽容的：映射成空串后丢弃，[1, 'PATH'] 通过并返回 ['PATH']。
    { envKeys: [1, 'PATH'] },
    { envKeys: [1] },
    { nope: 1 },
    { enabled: true, envKeys: ['PATH'], extra: 1 },
  ])
})

test('run-code-env：两条 envKeys 消息与 enabled 的 fail loud 逐字固定', () => {
  assert.throws(
    () => runCodeEnvContract.parse({}, 'run-code-env'),
    { name: 'TypeError', message: LEGACY_ENV_KEYS_MESSAGES.missing },
  )
  assert.throws(
    () => runCodeEnvContract.parse({ envKeys: [] }, 'run-code-env'),
    { name: 'TypeError', message: LEGACY_ENV_KEYS_MESSAGES.missing },
  )
  assert.throws(
    () => runCodeEnvContract.parse({ envKeys: ['  '] }, 'run-code-env'),
    { name: 'TypeError', message: LEGACY_ENV_KEYS_MESSAGES.empty },
  )
  assert.throws(
    () => runCodeEnvContract.parse({ enabled: 'yes', envKeys: ['PATH'] }, 'run-code-env'),
    { name: 'TypeError', message: 'run-code-env: enabled must be a boolean' },
  )
  assert.throws(
    () => runCodeEnvContract.parse({ nope: 1 }, 'run-code-env'),
    { name: 'TypeError', message: 'run-code-env: unknown config key(s) nope — allowed keys: enabled, envKeys' },
  )
  // 导出的 normalizeEnvKeys 与声明同源（保留导出供既有测试直接调用）。
  assert.deepEqual(normalizeEnvKeys(['FOO', 'FOO', 'BAR']), ['FOO', 'BAR'])
  assert.deepEqual(normalizeEnvKeys([' A ', 'B', 'A']), ['A', 'B'])
  assert.deepEqual(
    runCodeEnvContract.parse({ enabled: true, envKeys: [' A ', 'B', 'A'] }, 'run-code-env'),
    { enabled: true, envKeys: ['A', 'B'] },
  )
})

test('run-code-env：allowEmpty=false 是显式取值——空数组抛消息 A，trim 后为空抛消息 B', () => {
  // 迁移前 `!Array.isArray(value) || value.length === 0` 抛消息 A，空数组不得通过；
  // 两条消息必须可分别表达，故 stringList 声明显式写 allowEmpty: false + emptyMessage。
  assert.throws(() => normalizeEnvKeys([]), { message: LEGACY_ENV_KEYS_MESSAGES.missing })
  assert.throws(() => normalizeEnvKeys(['', '  ']), { message: LEGACY_ENV_KEYS_MESSAGES.empty })
})

// —— tool-git-bash 对拍 ——

test('tool-git-bash：迁移前后配置闸门逐字对拍（含 bashPath 的宽容语义）', () => {
  expectSameGate(legacyGitBashGate, migratedGitBashGate, [
    undefined,
    null,
    [],
    'not-a-config',
    {},
    { timeoutMs: 120000, maxOutputBytes: 64000 },
    { bashPath: 'C:/git/bin/bash.exe', timeoutMs: 1, maxOutputBytes: 1 },
    { bashPath: '', timeoutMs: 120000, maxOutputBytes: 64000 },
    // 迁移前对非字符串 bashPath 是静默忽略（不报错）——直通字段保留该判定。
    { bashPath: 123, timeoutMs: 120000, maxOutputBytes: 64000 },
    { bashPath: null, timeoutMs: 120000, maxOutputBytes: 64000 },
    { bashPath: [], timeoutMs: 120000, maxOutputBytes: 64000 },
    { timeoutMs: 120000 },
    { maxOutputBytes: 64000 },
    { timeoutMs: 0, maxOutputBytes: 64000 },
    { timeoutMs: -1, maxOutputBytes: 64000 },
    { timeoutMs: 1.5, maxOutputBytes: 64000 },
    { timeoutMs: '120000', maxOutputBytes: 64000 },
    { timeoutMs: 120000, maxOutputBytes: '64000' },
  ])
})

test('tool-git-bash：未知键消息只多出新白名单项 enabled（新增开关的必然结果）', () => {
  const legacy = caught(() => legacyGitBashGate({ nope: 1 }))
  const migrated = caught(() => gitBashContract.parse({ nope: 1 }, 'tool-git-bash'))
  assert.equal(legacy.ok, false, '迁移前同样拒绝未知键')
  assert.equal(migrated.ok, false)
  assert.equal(
    migrated.error.message.replace('bashPath, enabled, maxOutputBytes', 'bashPath, maxOutputBytes'),
    legacy.error.message,
    '除新白名单项外逐字一致',
  )
  assert.equal(
    migrated.error.message,
    'tool-git-bash: unknown config key(s) nope — allowed keys: bashPath, enabled, maxOutputBytes, timeoutMs',
  )
})

test('tool-git-bash：必需整数与未知键消息逐字固定，enabled 是新增白名单键', () => {
  assert.throws(
    () => gitBashContract.parse({}, 'tool-git-bash'),
    { name: 'TypeError', message: 'tool-git-bash: timeoutMs must be an integer >= 1' },
  )
  assert.throws(
    () => gitBashContract.parse({ timeoutMs: 120000 }, 'tool-git-bash'),
    { name: 'TypeError', message: 'tool-git-bash: maxOutputBytes must be an integer >= 1' },
  )
  assert.throws(
    () => gitBashContract.parse({ nope: 1 }, 'tool-git-bash'),
    { name: 'TypeError', message: 'tool-git-bash: unknown config key(s) nope — allowed keys: bashPath, enabled, maxOutputBytes, timeoutMs' },
  )
  // 唯一的行为变更：迁移前 enabled 是未知键，现在它是能力开关。
  const legacyUnknown = caught(() => legacyGitBashGate({ enabled: true, timeoutMs: 1, maxOutputBytes: 1 }))
  assert.equal(legacyUnknown.ok, false)
  assert.match(legacyUnknown.error.message, /unknown config key\(s\) enabled/)
  assert.deepEqual(
    gitBashContract.parse({ enabled: true, timeoutMs: 1, maxOutputBytes: 1 }, 'tool-git-bash'),
    { enabled: true, bashPath: undefined, timeoutMs: 1, maxOutputBytes: 1 },
  )
})

// —— T3：enabled fail loud 与装配门控 ——

test('enabled: "yes" 在两个保留模块的挂载期抛 enabled must be a boolean', () => {
  assert.throws(
    () => applyRunCodeEnv(runCodeEnvHarnessCtx(), { enabled: 'yes', envKeys: ['PATH'] }),
    { name: 'TypeError', message: 'run-code-env: enabled must be a boolean' },
  )
  assert.throws(
    () => applyGitBash(gitBashHarnessCtx(), { enabled: 'yes', timeoutMs: 1, maxOutputBytes: 1 }),
    { name: 'TypeError', message: 'tool-git-bash: enabled must be a boolean' },
  )
  // 开关先于其余字段校验：enabled 非布尔时，即使 timeoutMs 也缺失/非法，仍报 enabled。
  assert.throws(
    () => applyGitBash(gitBashHarnessCtx(), { enabled: 'yes' }),
    { name: 'TypeError', message: 'tool-git-bash: enabled must be a boolean' },
  )
  assert.throws(
    () => applyRunCodeEnv(runCodeEnvHarnessCtx(), { enabled: 1 }),
    { name: 'TypeError', message: 'run-code-env: enabled must be a boolean' },
  )
})

/** 只做抛错断言的桩 ctx（apply 在抛错前不会用到任何服务）。 */
function runCodeEnvHarnessCtx() {
  return { on: () => {}, get: () => undefined, tools: { get: () => undefined, schemas: () => [] }, systemPrompt: { section: () => {} } }
}
function gitBashHarnessCtx() {
  return { subprocess: { resolveExecutable: async () => 'bash', spawn: () => { throw new Error('unused') } }, tools: { register: () => {} } }
}

test('run-code-env：enabled 未声明 = 关闭（不注册提示段、不补丁 run_code），true 才启用', async () => {
  const off = runCodeEnvHarness({ envKeys: ['PATH'] })
  assert.equal(off.getSection(), undefined, '未声明 enabled 不得注册提示段')
  await off.assemble()
  assert.deepEqual(await off.runTool.execute({ code: 'return 1' }, {}), { code: 'return 1' }, '关闭时不得补丁 run_code')

  const on = runCodeEnvHarness({ enabled: true, envKeys: ['PATH'] })
  assert.ok(on.getSection(), 'enabled: true 才注册提示段')
  await on.assemble()
  const patched = await on.runTool.execute({ code: 'return 1' }, {})
  assert.match(patched.code, /^const env = Object\.freeze\(JSON\.parse\(/)

  // 校验与开关解耦：关闭也不放过缺失的白名单（迁移前同样无条件校验 envKeys）。
  assert.throws(() => runCodeEnvHarness({}), { message: LEGACY_ENV_KEYS_MESSAGES.missing })
})

test('tool-git-bash：enabled 未声明 = 不注册工具，true 注册且声明值真的被消费', async () => {
  const off = gitBashHarness({ timeoutMs: 1, maxOutputBytes: 1 })
  assert.deepEqual(off.tools, [], '未声明 enabled 不得注册 bash 工具')

  const calls = gitBashHarness({ enabled: true, bashPath: 'C:/git/bin/bash.exe', timeoutMs: 20, maxOutputBytes: 64000 })
  assert.equal(calls.tools.length, 1, 'enabled: true 注册 bash 工具')
  assert.equal(calls.tools[0].name, 'bash')

  // maxOutputBytes / bashPath 来自声明后的归一化对象（不是读原始 source）。
  await assert.rejects(() => calls.tools[0].execute({ command: 'sleep 100' }, {}), /bash timed out after 20ms/)
  assert.equal(calls.resolved[0], 'C:/git/bin/bash.exe', 'bashPath 生效')
  assert.equal(calls.spawns[0].stdio.stdout.maxBytes, 64000, 'maxOutputBytes 生效')
  assert.equal(calls.spawns[0].stdio.stderr.maxBytes, 64000, 'maxOutputBytes 生效（stderr 同值）')
})

// —— T3：组合源 enabled 与 disabled 的适用范围 ——

test('组合源：两个保留模块都显式写 enabled，且 tool-git-bash 的平台条件保持不变', () => {
  // run-code-env 原本就显式开启；tool-git-bash 原本「行在组合里即启用」，故补显式 true。
  assert.equal(compositionConfig('run-code-env').enabled, true)
  assert.equal(compositionConfig('tool-git-bash').enabled, true, '原「靠行存在即启用」→ 补 true')

  // disabled: 只用于平台条件/树内子项/命名禁用变体，不是能力开关：本行的平台条件必须原样保留。
  const source = readFileSync(new URL('../../engine/compositions/source/local/tool-git-bash.yml', import.meta.url), 'utf8')
  assert.match(source, /disabled: !!js process\.platform !== 'win32'/, '平台条件不是能力开关，T3 不得改动它')
  assert.match(source, /^\s*enabled: true$/m, '组合源显式声明能力开关')
})
