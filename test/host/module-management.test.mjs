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
import { fakeReq, fakeRes, isolatedHome } from '../fixtures/host-harness.mjs'

// 隔离 HOME 必须在动态 import 之前（仓库约定，见 host-harness 注释）。
const { home, presetRoot } = isolatedHome('pt-module-mgmt-')
process.env.DSH_AGENTS_HOME = join(home, 'agents')

const { registerSettingsBridge, BRIDGE_ENDPOINTS } = await import('../../src/index.ts')

const PREFIX = '/api/prompt-tool/settings'

/** 最小宿主桩：`settings.describe()` 的 presetTemplate 就是「使用中禁删」的判据来源。 */
function makeHarness(activeTemplate) {
  const handlers = new Map()
  const sctx = {
    get: () => undefined,
    settings: {
      describe: () => [{ ns: 'prompt-tool', value: activeTemplate === undefined ? {} : { presetTemplate: activeTemplate }, base: {} }],
      mutate: async () => {},
    },
    webServer: { register: ({ path, handler }) => { handlers.set(path, handler) } },
    effect: (fn) => fn(),
  }
  return { ctx: { inject: (_deps, cb) => cb(sctx) }, handlers }
}

function register(ctx, activeTemplate) {
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
    () => undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => {},
  )
  void activeTemplate
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
  const dir = join(presetRoot, id)
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
  assert.equal(result.code, 'preset-in-use')
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
    assert.equal(result.code, 'preset-open-rejected', `${JSON.stringify(bad)} 的错误码`)
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
  assert.equal(result.code, 'preset-clone-rejected')
  assert.equal(readFileSync(join(dir, 'module.yml'), 'utf8'), before, '被拒的克隆不得覆盖既有定义')
})

test('复制：源不存在时被拒，模块根不留残留目录', async () => {
  const { ctx, handlers } = makeHarness(undefined)
  register(ctx, undefined)
  const before = readdirSync(presetRoot).sort()

  const result = await call(handlers, 'moduleDuplicate', { id: 'no-such-module' })
  assert.equal(result.status, 400, result.message)
  assert.equal(result.code, 'preset-duplicate-rejected')
  assert.deepEqual(readdirSync(presetRoot).sort(), before, '被拒的复制不得留下候选目录')
})

test('导出：不存在的模块被拒，不回传任何定义内容', async () => {
  const { ctx, handlers } = makeHarness(undefined)
  register(ctx, undefined)

  const result = await call(handlers, 'exportPreset', { id: 'no-such-module', mode: 'definition' })
  assert.equal(result.status, 400, result.message)
  assert.equal(result.ok, false)
  assert.equal(result.value, undefined, '失败载荷不得携带定义内容')
})

test('并入的源模块优先：同名模块与角色卡并存时取模块定义', async () => {
  const characters = await import('../../src/host/characters.ts')
  const id = 'dual-source'
  // 模块源：modules/<id>/module.yml
  mkdirSync(join(presetRoot, id), { recursive: true })
  writeFileSync(join(presetRoot, id, 'module.yml'), `id: ${id}\nname: 模块源\nmodules: []\npromptConfigs:\n  - id: intro\n    strategy: static\n    layer: system-section\n    text: FROM-MODULE\n`, 'utf8')
  // 同名角色卡源：存储根下的 .characters/<id>/converted.yml（与模块根同级）
  const legacyDir = join(dirname(presetRoot), '.characters', id)
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(join(legacyDir, 'converted.yml'), JSON.stringify({
    id, name: '卡片源',
    promptConfigs: [{ id: 'intro', strategy: 'static', layer: 'system-section', text: 'FROM-CARD' }],
  }), 'utf8')
  // 目标模块
  mkdirSync(join(presetRoot, 'target'), { recursive: true })
  writeFileSync(join(presetRoot, 'target', 'module.yml'), 'id: target\nname: Target\nmodules: []\n', 'utf8')

  const applied = characters.applyCharacterToPreset(presetRoot, 'target', id)
  assert.equal(applied.ok, true, applied.message)
  const written = readFileSync(join(presetRoot, 'target', 'module.yml'), 'utf8')
  assert.match(written, /FROM-MODULE/, '并入必须取模块定义（模块优先）')
  assert.doesNotMatch(written, /FROM-CARD/, '不得取同名的角色卡定义')
  assert.match(written, new RegExp(`module-${id}-intro`), '条目 id 用统一前缀')
})
