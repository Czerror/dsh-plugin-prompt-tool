/**
 * 模块管理四件套的**拒绝路径**回归（PLAN T7 的缺口）。
 *
 * 现有 `settings-bridge.test.mjs:341-381` 已覆盖新建/复制/删除的主路径与磁盘产物；
 * 本文件只补 PLAN 点名的拒绝面：使用中禁删、打开目录路径越界、新建同名、复制源不存在，
 * 外加导出对不存在模块的拒绝。
 *
 * 真值源是 PLAN 的安全项与端点载荷的错误码，不是实现自己算出的值。
 * 不测 `moduleOpen` 的成功路径：它会真的拉起系统文件管理器，越界拒绝在 spawn 之前发生。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { parse } from 'yaml'
import { fakeReq, fakeRes, isolatedHome } from '../fixtures/host-harness.mjs'

// 隔离 HOME 必须在动态 import 之前（仓库约定，见 host-harness 注释）。
const { home, moduleRoot } = isolatedHome('pt-module-mgmt-')
process.env.DSH_AGENTS_HOME = join(home, 'agents')

const { registerSettingsBridge, BRIDGE_ENDPOINTS } = await import('../../src/index.ts')

const PREFIX = '/api/prompt-tool/settings'

/** 最小宿主桩：编辑目标由请求目录解析器提供，不再存入 settings。 */
function makeHarness() {
  const handlers = new Map()
  const sctx = {
    get: () => undefined,
    settings: {
      describe: () => [{ ns: 'prompt-tool', value: {}, base: {} }],
      mutate: async () => {},
    },
    webServer: { register: ({ path, handler }) => { handlers.set(path, handler) } },
    effect: (fn) => fn(),
  }
  return { ctx: { inject: (_deps, cb) => cb(sctx) }, handlers }
}

function register(ctx, activeTemplate, afterOverridesChange) {
  registerSettingsBridge(
    ctx,
    'prompt-tool',
    () => ({ available: true, providers: [] }),
    () => ({
      skillsRoot: join(home, 'skills'),
      folders: [],
      listSkills: () => [],
      setSkillPolicy: () => ({ ok: true, changed: false }),
      patchSkillFolders: () => ({ ok: true, state: { version: 4, folders: [] }, exists: true }),
    }),
    () => '',
    undefined,
    (requested) => {
      const id = requested ?? activeTemplate
      return id === undefined ? '' : join(moduleRoot, id)
    },
    undefined,
    afterOverridesChange,
    undefined,
    undefined,
    () => {},
  )
}

/** 调端点；不假定成功，原样返回状态与错误载荷。 */
async function call(handlers, endpoint, payload = {}) {
  const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS[endpoint])
  assert.ok(handler !== undefined, `${endpoint} 端点应注册`)
  const res = fakeRes()
  // 本文件用的是 host-harness 的 fakeReq：它只解构 { body, raw, method, remoteAddress, headers }，
  // 因此只认 `body` 形态。注意 settings-bridge.test.mjs 里另有一个**同名但不同实现**的本地
  // fakeReq（`(overrides = {})`，`...overrides` 展开在最后），那边传 Symbol.asyncIterator 才是对的。
  // 两者别互抄：抄错就会得到空请求流，端点以「缺少 id」拒绝，拒绝路径用例随即假通过。
  await handler(fakeReq({ body: payload }), res)
  const body = JSON.parse(res.body)
  // 判别性保护：若 payload 没送达，端点会以「id 未定义」拒绝，而多个端点用的错误码与
  // 「真实业务拒绝」是同一个（例如缺 id 与同名都用 preset-clone-rejected），断言就会假通过。
  // 这里把「id 未解析」这种退化情形直接判为测试自身失败。
  if (payload.id !== undefined && typeof body.message === 'string' && body.message.includes('undefined')) {
    throw new Error(`${endpoint} 未收到 payload.id（发出 ${JSON.stringify(payload)}）：${body.message}`)
  }
  return { status: res.status, ok: body.ok, code: body.code, message: body.message, value: body.value }
}

function writeModule(id, content = `id: ${id}\nname: ${id}\nmodules: []\n`) {
  const dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), content, 'utf8')
  return dir
}

test('使用中禁删：激活模块的删除被拒，目录与定义保持原样', async () => {
  const id = 'in-use-module'
  const dir = writeModule(id)
  const before = readFileSync(join(dir, 'module.yml'), 'utf8')
  const { ctx, handlers } = makeHarness(id)
  register(ctx, id)

  const result = await call(handlers, 'moduleDelete', { id })
  assert.equal(result.status, 400, result.message)
  assert.equal(result.code, 'module-in-use')
  assert.equal(existsSync(dir), true, '被拒的删除不得移除目录')
  assert.equal(readFileSync(join(dir, 'module.yml'), 'utf8'), before, '被拒的删除不得改动定义')
})

test('打开目录：越界与非法 id 一律被拒，不进入打开动作', async () => {
  const { ctx, handlers } = makeHarness(undefined)
  register(ctx, undefined)
  // 白名单允许的是裸 id 与 `/.characters/<id>` 形式；下列都不属于任何一种。
  for (const bad of ['../outside', '/absolute/path', 'a/b', '.hidden', '']) {
    const result = await call(handlers, 'moduleOpen', { id: bad })
    assert.equal(result.status, 400, `${JSON.stringify(bad)} 应被拒：${result.message}`)
    assert.equal(result.code, 'module-open-rejected', `${JSON.stringify(bad)} 的错误码`)
  }
})

test('新建：同名且未要求递增时被拒，既有模块不被覆盖', async () => {
  const id = 'pt-custom'
  const dir = writeModule(id, `id: ${id}\nname: 已存在的模块\nmodules: []\n`)
  const before = readFileSync(join(dir, 'module.yml'), 'utf8')
  const { ctx, handlers } = makeHarness(undefined)
  register(ctx, undefined)

  const result = await call(handlers, 'moduleClone', { id })
  assert.equal(result.status, 400, result.message)
  assert.equal(result.code, 'module-clone-rejected')
  assert.equal(readFileSync(join(dir, 'module.yml'), 'utf8'), before, '被拒的克隆不得覆盖既有定义')
})

test('复制：源不存在时被拒，模块根不留残留目录', async () => {
  const { ctx, handlers } = makeHarness(undefined)
  register(ctx, undefined)
  const before = readdirSync(moduleRoot).sort()

  const result = await call(handlers, 'moduleDuplicate', { id: 'no-such-module' })
  assert.equal(result.status, 400, result.message)
  assert.equal(result.code, 'module-duplicate-rejected')
  assert.deepEqual(readdirSync(moduleRoot).sort(), before, '被拒的复制不得留下候选目录')
})

test('导出：不存在的模块被拒，不回传任何定义内容', async () => {
  const { ctx, handlers } = makeHarness(undefined)
  register(ctx, undefined)

  const result = await call(handlers, 'exportModule', { id: 'no-such-module', mode: 'definition' })
  assert.equal(result.status, 400, result.message)
  assert.equal(result.ok, false)
  assert.equal(result.value, undefined, '失败载荷不得携带定义内容')
})

test('并入的源模块优先：同名模块与角色卡并存时取模块定义', async () => {
  const characters = await import('../../src/host/characters.ts')
  const { convertLegacyModuleRules } = await import('../../src/host/rules-migration.ts')
  const { promptConfigToRule } = await import('../../src/host/rule-builder.ts')
  const id = 'dual-source'
  // 模块源：modules/<id>/module.yml
  mkdirSync(join(moduleRoot, id), { recursive: true })
  const legacySource = {
    id, name: '模块源', modules: [],
    layerSettings: { 'pre-step': { firstTurnAnchor: true, firstTurnCustom: true, firstTurnText: 'LEGACY ANCHOR' } },
    promptConfigs: [
      { id: 'intro', strategy: 'static', layer: 'system-section', text: 'FROM-MODULE' },
      { id: 'near-anchor', strategy: 'first-turn-anchor', enabled: false },
      { id: 'prompt-injector', strategy: 'custom-fallback' },
    ],
  }
  writeFileSync(join(moduleRoot, id, 'preset.md'), 'LEGACY BODY', 'utf8')
  const converted = convertLegacyModuleRules(legacySource, { directory: join(moduleRoot, id) })
  writeFileSync(join(moduleRoot, id, 'module.yml'), JSON.stringify({ id, name: '模块源', modules: [], rules: converted.rules, configOrder: converted.configOrder }), 'utf8')
  // 同名角色卡源：存储根下的 .characters/<id>/converted.yml（与模块根同级）
  const legacyDir = join(dirname(moduleRoot), '.characters', id)
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(join(legacyDir, 'converted.yml'), JSON.stringify({
    id, name: '卡片源',
    rules: [promptConfigToRule({ id: 'intro', strategy: 'static', layer: 'system-section', text: 'FROM-CARD' })],
  }), 'utf8')
  // 目标模块
  mkdirSync(join(moduleRoot, 'target'), { recursive: true })
  writeFileSync(join(moduleRoot, 'target', 'module.yml'), 'id: target\nname: Target\nmodules: []\n', 'utf8')

  const applied = characters.mergeModuleIntoModule(moduleRoot, 'target', id)
  assert.equal(applied.ok, true, applied.message)
  const written = readFileSync(join(moduleRoot, 'target', 'module.yml'), 'utf8')
  assert.match(written, /FROM-MODULE/, '并入必须取模块定义（模块优先）')
  assert.doesNotMatch(written, /FROM-CARD/, '不得取同名的角色卡定义')
  assert.match(written, new RegExp(`module-${id}-intro`), '条目 id 用统一前缀')
  const configs = parse(written).rules
  const anchor = configs.find(config => config.id === `module-${id}-near-anchor`)
  assert.equal(anchor.enabled, true, '并入前先把旧开关交给规则实例')
  assert.equal(anchor.then[0].config.params.text, 'LEGACY ANCHOR')
  assert.equal(configs.find(config => config.id === `module-${id}-prompt-injector`).then[0].config.params.text, 'LEGACY BODY')
})

test('普通模块之间的并入是往返且幂等的：重复并入不翻倍，移除后自有内容原样保留', async () => {
  const characters = await import('../../src/host/characters.ts')
  const rule = (id, text) => ({ id, layer: 'system-section', then: [{ id: 'inject', kind: 'inject-text', config: { id, layer: 'system-section', text } }] })
  const src = 'roundtrip-src'
  mkdirSync(join(moduleRoot, src), { recursive: true })
  writeFileSync(join(moduleRoot, src, 'module.yml'), JSON.stringify({ id: src, name: '源', modules: [], rules: [rule('a', 'A'), rule('b', 'B')] }), 'utf8')
  const target = 'roundtrip-target'
  mkdirSync(join(moduleRoot, target), { recursive: true })
  const targetFile = join(moduleRoot, target, 'module.yml')
  writeFileSync(targetFile, JSON.stringify({ id: target, name: '目标', modules: [], rules: [rule('own', 'OWN')] }), 'utf8')

  // 幂等判据用「条目 id 出现的次数」，不做字节级对齐：并入会按需补 variables 等字段，
  // 字节相等不是这层语义的契约；PLAN 要的是不翻倍、撤得干净、自有内容不动。
  const count = (text, token) => parse(text).rules.filter(rule => rule.id === token).length

  assert.equal(characters.mergeModuleIntoModule(moduleRoot, target, src).ok, true)
  const afterApply = readFileSync(targetFile, 'utf8')
  assert.equal(count(afterApply, `module-${src}-a`), 1)
  assert.equal(count(afterApply, `module-${src}-b`), 1)

  assert.equal(characters.mergeModuleIntoModule(moduleRoot, target, src).ok, true, '重复并入应成功')
  const afterTwice = readFileSync(targetFile, 'utf8')
  assert.equal(count(afterTwice, `module-${src}-a`), 1, '重复并入不得产生重复条目')
  assert.equal(count(afterTwice, `module-${src}-b`), 1)

  assert.equal(characters.removeMergedModule(moduleRoot, target, src).ok, true)
  const afterRemove = readFileSync(targetFile, 'utf8')
  assert.equal(count(afterRemove, `module-${src}-a`), 0, '移除必须按前缀撤销干净')
  assert.equal(count(afterRemove, `module-${src}-b`), 0)
  assert.match(afterRemove, /id: own/, '目标模块自带内容必须保留')
  assert.match(afterRemove, /text: OWN/, '自带内容不得被移除波及')
})

test('module-enable：写启用表后等待装配，失败如实返回，非法载荷不落盘', async () => {
  // 真值源是「模块页唯一改变装配范围的动作」这一契约：启用即写启用表，停用即摘除。
  const { ctx, handlers } = makeHarness(undefined)
  const entered = Promise.withResolvers()
  const resume = Promise.withResolvers()
  const refreshed = []
  let hold = true
  let failRefresh = false
  register(ctx, undefined, async (moduleId) => {
    refreshed.push(moduleId)
    entered.resolve()
    if (hold) await resume.promise
    if (failRefresh) throw new Error('runtime refresh failed')
  })
  const configFile = join(dirname(moduleRoot), 'config.yml')
  const readEnabled = () => readFileSync(configFile, 'utf8')

  const id = 'enable-target'
  writeModule(id)

  // 主路径：启用 → 写进表；幂等重复启用不产生第二条。
  let responded = false
  const enabling = call(handlers, 'moduleEnable', { id, enabled: true }).then(result => {
    responded = true
    return result
  })
  try {
    assert.equal(await Promise.race([
      entered.promise.then(() => 'refresh'),
      enabling.then(() => 'response'),
    ]), 'refresh', '成功响应必须等到启用表对应的运行时装配完成')
    assert.match(readEnabled(), /- enable-target/, '先写盘，再等待装配')
    await new Promise(setImmediate)
    assert.equal(responded, false, '装配尚未完成时不能提前报告启用成功')
  } finally {
    hold = false
    resume.resolve()
  }
  const on = await enabling
  assert.equal(on.status, 200, on.message)
  assert.deepEqual(on.value, { enabled: [id] })
  assert.deepEqual(refreshed, [undefined], '启用表改变需刷新全部实例，不只重装已包含该模块的实例')
  assert.equal((readEnabled().match(new RegExp(`- ${id}$`, 'm')) ?? []).length, 1)
  const again = await call(handlers, 'moduleEnable', { id, enabled: true })
  assert.deepEqual(again.value, { enabled: [id] }, '重复启用幂等')

  // 停用：从表里摘除；幂等重复停用不报错。
  const off = await call(handlers, 'moduleEnable', { id, enabled: false })
  assert.deepEqual(off.value, { enabled: [] })
  assert.deepEqual((await call(handlers, 'moduleEnable', { id, enabled: false })).value, { enabled: [] }, '重复停用幂等')

  // 拒绝路径一：缺 id。
  const noId = await call(handlers, 'moduleEnable', { enabled: true })
  assert.equal(noId.status, 400)
  assert.equal(noId.code, 'module-enable-rejected')

  // 拒绝路径二：enabled 不是布尔值。
  const badFlag = await call(handlers, 'moduleEnable', { id, enabled: 'yes' })
  assert.equal(badFlag.status, 400)
  assert.equal(badFlag.code, 'module-enable-rejected')

  // 拒绝路径三：启用一个磁盘上不存在的模块——写进表会让装配静默少装一个。
  const before = readEnabled()
  const missing = await call(handlers, 'moduleEnable', { id: 'no-such-module', enabled: true })
  assert.equal(missing.status, 400)
  assert.equal(missing.code, 'module-enable-rejected')
  assert.equal(readEnabled(), before, '被拒的启用不得改动启用表')
  assert.deepEqual((await call(handlers, 'moduleEnable', { id, enabled: false })).value.enabled.includes('no-such-module'), false)
  assert.equal(refreshed.length, 5, '非法请求不得触发装配')

  failRefresh = true
  const failed = await call(handlers, 'moduleEnable', { id, enabled: true })
  assert.equal(failed.status, 500)
  assert.equal(failed.code, 'module-activation-failed')
  assert.match(failed.message, /更改已保存，但模块未生效/)
  assert.match(readEnabled(), /- enable-target/, '装配失败保留已保存的启用表，便于重试')
  failRefresh = false
  assert.deepEqual((await call(handlers, 'moduleEnable', { id, enabled: false })).value, { enabled: [] })
})
