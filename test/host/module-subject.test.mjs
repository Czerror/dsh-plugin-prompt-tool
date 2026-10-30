/**
 * 模块主语解析回归网：`resolveEditDir` 只按**声明**定位，接线函数把「未声明」译为无目标；
 * 「这次读写归哪个模块」由归属门一处判（策略表 + 身份一致 + 可写/形状）。
 *
 * 真值源：`docs/superpowers/specs/2026-10-12-module-subject-design.md` §六／§10.2、ADR-0011
 * ——显式 id 命中该模块（与是否在启用表里无关），不存在的 id 与未声明一律返回空串，
 * 不再回退启用表首项；非法 `x-module-id` 在事务边界显式 400，不降级成「未声明」；
 * `required` 无目标 400 `module-dir-unavailable`，载荷主语 ≠ 头声明 400 `module-subject-conflict`。
 * 断言落在公共接口（`resolveEditDir` / `resolveRequestedModuleDir` / 端点载荷）上。
 * 声明面（读 400 `module-not-declared` / 写路径建立声明）的行为面归 settings-bridge.test.mjs，
 * 这里只留它不覆盖的那一条：解析失败不降级成「没声明」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { isolatedHome, fakeReq, fakeRes, handlerTable, readBridge } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-module-subject-')
const { resolveEditDir, resolveRequestedModuleDir, setModuleEnabled } =
  await import('../../src/host/config-store.ts')
const { registerSettingsBridge } = await import('../../src/runtime/settings-bridge.ts')
const { BRIDGE_ENDPOINTS, MODULE_IDENTITY_INVALID, MODULE_NOT_DECLARED, MODULE_SUBJECT_CONFLICT } =
  await import('../../src/shared/bridge-contract.ts')

function makeModule(id, body = 'modules: []\n') {
  const dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), `id: ${id}\n${body}`, 'utf8')
  return dir
}

/** 存储根里的普通目录，没有 module.yml：不得被当成编辑目标。 */
function makePlainDir(id) {
  const dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 归属门端到端夹具：真实 `resolveRequestedModuleDir` 接线 + 记录型 webServer。 */
function bridgeHarness(deps = {}) {
  const table = handlerTable()
  const ctx = {
    inject: (_deps, cb) => cb({
      get: () => undefined,
      settings: { describe: () => [{ ns: 'prompt-tool', value: {}, base: {} }], mutate: async () => {} },
      webServer: { register: table.register },
      effect: (fn) => fn(),
    }),
  }
  registerSettingsBridge(ctx, {
    ns: 'prompt-tool',
    models: () => ({ available: true, providers: [] }),
    skills: () => ({ skillsRoot: moduleRoot, folders: [], listSkills: () => [], setSkillPolicy: () => ({ ok: true, changed: false }) }),
    moduleDirectory: (subject) => resolveRequestedModuleDir(moduleRoot, subject),
    ...deps,
  })
  const call = async (endpoint, header, request = {}) => {
    const handler = table.handler('/api/prompt-tool/settings' + BRIDGE_ENDPOINTS[endpoint])
    assert.equal(typeof handler, 'function', `${endpoint} 端点已注册`)
    const res = fakeRes()
    await handler(fakeReq({
      body: {},
      headers: header === undefined ? {} : { 'x-module-id': header },
      ...request,
    }), res)
    return { ...readBridge(res), raw: res.body }
  }
  return { call }
}

test('resolveEditDir 按声明定位：命中启用与否无关，缺定义与未声明一律无目标', () => {
  const declared = makeModule('declared-one')
  const undeclared = makeModule('undeclared-two')
  setModuleEnabled(moduleRoot, basename(declared), true)

  assert.equal(resolveEditDir(moduleRoot, basename(declared)), declared, '显式 id 命中该模块目录（绝对路径）')
  assert.equal(resolveEditDir(moduleRoot, basename(undeclared)), undeclared, 'ADR-0011：未启用模块也可作为编辑目标')
  assert.equal(resolveEditDir(moduleRoot, 'no-such-module'), '', '不存在的 id 返回空串，不回退启用表首项')
  assert.equal(resolveEditDir(moduleRoot, 'plain-dir'), '', '没有 module.yml 的目录不是编辑目标')
})

test('未声明主语不选目标：接线函数返回空串，绝不落到启用表首项', () => {
  const declared = makeModule('declared-wire')
  setModuleEnabled(moduleRoot, basename(declared), true)
  makePlainDir('plain-wire')

  assert.equal(resolveRequestedModuleDir(moduleRoot, undefined), '', '未声明 = 无目标')
  assert.equal(resolveRequestedModuleDir(moduleRoot, basename(declared)), declared, '声明了才解析目录')
  assert.equal(resolveRequestedModuleDir(moduleRoot, 'no-such-wire'), '', '声明了但不存在也是无目标')
})

test('非法模块 id 不解引用到存储根之外：形状判据先于存在性', () => {
  // 存储根的**同级**放一个合法模块目录：`../evil` 这类 id 不得把它解成编辑目标。
  const outside = join(moduleRoot, '..', 'evil')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'module.yml'), 'id: evil\nmodules: []\n', 'utf8')

  for (const bad of ['../evil', '..', 'a/b', 'Bad_ID', '']) {
    assert.equal(resolveEditDir(moduleRoot, bad), '', `${JSON.stringify(bad)} 不是模块 id，不解析目录`)
    assert.equal(resolveRequestedModuleDir(moduleRoot, bad), '', `${JSON.stringify(bad)} 的主语解析同样拒绝`)
  }
  assert.equal(resolveEditDir(moduleRoot, 'evil'), '', '同级模块不在存储根内：不因「名字合法」而解出来')
})

test('非法 x-module-id 在事务边界显式 400，不进入端点 handler', async () => {
  makeModule('header-ok', 'modules: [rule-engine]\nrules: []\n')
  const { call } = bridgeHarness()

  for (const endpoint of ['rules', 'describe', 'meta']) {
    for (const bad of ['../x', 'a'.repeat(65), '   ', '', 'Bad_ID', 'a/b']) {
      const result = await call(endpoint, bad)
      assert.equal(result.status, 400, `${endpoint} + ${JSON.stringify(bad)} 应显式拒绝：${result.message}`)
      assert.equal(result.code, MODULE_IDENTITY_INVALID, `${endpoint} + ${JSON.stringify(bad)} 的错误码`)
    }
  }
  // 合法头仍照常解析到声明的模块；缺失头不是非法头：策略为 none 的端点不受影响。
  assert.equal((await call('describe', 'header-ok')).status, 200, '合法头不受影响')
  assert.equal((await call('meta', undefined)).status, 200, '「头完全没有」不是非法头')

  // 自守边界先于主语头判定：非法头不得把 403/405 顶掉。
  const foreignHost = await call('rules', '../x', { headers: { host: 'evil.example.com' } })
  assert.equal(foreignHost.status, 403, '非 loopback + 非法头仍是 403')
  assert.equal(foreignHost.code, 'settings-not-exposed', '403 载荷不受主语头影响')
  const nonLoopback = await call('rules', '../x', { remoteAddress: '10.0.0.7' })
  assert.equal(nonLoopback.status, 403, '非 loopback socket + 非法头仍是 403')
  const wrongMethod = await call('rules', '../x', { method: 'GET' })
  assert.equal(wrongMethod.status, 405, '非 POST + 非法头仍是 405')
})

test('归属门：required 无目标 400、载荷主语与头声明冲突 400、optional 空主语只回全局段', async () => {
  const dirA = makeModule('gate-a', 'modules: [rule-engine]\nrules: []\n')
  const dirB = makeModule('gate-b', 'modules: [rule-engine]\nrules: []\n')
  const idA = basename(dirA), idB = basename(dirB)
  const { call } = bridgeHarness()

  // required 无目标：报「没有目标」，不是「只读」。行为回归锁。
  const noSubject = await call('rules', undefined, { body: { expectedModuleId: idA } })
  assert.equal(noSubject.status, 400)
  assert.equal(noSubject.code, 'module-dir-unavailable')

  // 写端点同样先报 400：门内顺序固定为「无目标 → 可写」（required 写端点照旧）。
  const writeNoSubject = await call('rules', undefined, { body: { edits: [] } })
  assert.equal(writeNoSubject.status, 400, '写端点无目标报 400，不是 403')
  assert.equal(writeNoSubject.code, 'module-dir-unavailable')

  // paramOverrides 是 optional：空主语＝**全局层**（存储根 config.yml 的 layerSettings），
  // 不是「没有目标」——固定卡（指令卡）是全局段，它的设置区就写在这里。
  const globalWrite = await call('paramOverrides', undefined, { body: { overrides: { modelTemperature: '0.5' } } })
  assert.equal(globalWrite.status, 200, `空主语应写全局层：${globalWrite.message}`)

  // 两个主语：请求头声明 A、载荷声明 B。
  const conflict = await call('rules', idA, { body: { expectedModuleId: idB } })
  assert.equal(conflict.status, 400)
  assert.equal(conflict.code, MODULE_SUBJECT_CONFLICT)
  assert.match(conflict.message, new RegExp(idA))
  assert.match(conflict.message, new RegExp(idB))

  // 主语一致时照常读写 A。
  const consistent = await call('rules', idA, { body: { expectedModuleId: idA } })
  assert.equal(consistent.status, 200, consistent.message)

  // optional：空目标是合法状态，模块段整体缺席，只剩全局段。
  const bootstrap = await call('bootstrap', undefined)
  assert.equal(bootstrap.status, 200)
  const payload = JSON.parse(bootstrap.raw)
  assert.equal('moduleParams' in payload, false, '空主语时 moduleParams 整体缺席')
  assert.equal('moduleFacts' in payload, false, '空主语时 moduleFacts 整体缺席')
  assert.equal(payload.templatePreStepCount, 0, '空主语不拿包内默认模块算批层数')
  assert.ok(payload.instructions?.context?.cwd, '全局段照常下发指令文件上下文')
})

test('声明面：解析失败走既有错误码，不降级成 module-not-declared；顺序在身份判据之前', async () => {
  const noRules = makeModule('declares-no-rules', 'modules: [rule-engine]\n')
  const other = makeModule('declares-other', 'modules: [rule-engine]\nrules: []\n')
  const broken = makeModule('declares-broken-yaml', 'rules: [unclosed\n')
  const { call } = bridgeHarness()

  const unparsable = await call('customTools', basename(broken))
  assert.equal(unparsable.status, 400)
  assert.equal(unparsable.code, 'rules-invalid', '形状核先报既有错误，不得伪装成「没声明」')

  // 载荷主语 ≠ 头声明：声明面排在身份判据之前，先报「没声明」。
  const conflictFirst = await call('rules', basename(noRules), { body: { expectedModuleId: basename(other) } })
  assert.equal(conflictFirst.status, 400)
  assert.equal(conflictFirst.code, MODULE_NOT_DECLARED)
})
