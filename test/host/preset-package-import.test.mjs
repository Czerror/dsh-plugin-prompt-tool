import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

// DSH_HOME 必须先于 lib 加载设置（paths.ts 模块级常量在 import 时求值），
// 因此本文件用动态 import 加载 lib，避免污染真实用户预设目录。
const home = mkdtempSync(join(tmpdir(), 'pt-package-import-'))
process.env.DSH_HOME = home
const { MAX_BRIDGE_BODY_BYTES } = await import('../../src/shared/bridge-contract.ts')
const { registerSettingsBridge } = await import('../../src/runtime/settings-bridge.ts')
const { stPresetId, convertStToModuleWithReport } = await import('../../src/host/sillytavern.ts')
const { ruleInjections } = await import('../../src/host/rule-content.ts')
const contentEntries = spec => ruleInjections(spec.rules).map(({ rule, config }) => ({ ...config, enabled: rule.enabled !== false }))
const bridgeDisposers = []

const PREFIX = '/api/prompt-tool/settings'
const PRESETS = join(home, '.prompt-tool', 'modules')

function makeHarness() {
  const handlers = new Map()
  const sctx = {
    settings: {
      describe: () => [{ ns: 'prompt-tool', value: {}, base: {} }],
      mutate: async () => {},
    },
    webServer: {
      register: ({ path, handler }) => { handlers.set(path, handler); return () => {} },
    },
    effect: (fn) => { const dispose = fn(); if (dispose) bridgeDisposers.push(dispose) },
  }
  const ctx = { inject: (deps, cb) => { if (deps.includes('settings')) cb(sctx) } }
  return { ctx, handlers }
}

function register() {
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(
    ctx,
    'prompt-tool',
    () => ({ available: true, providers: [] }),
    () => ({ activeSkillsDirs: [], skillCatalog: [] }),
    () => '',
  )
  return handlers
}

function fakeReq(body) {
  const payload = Buffer.from(JSON.stringify(body))
  return {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost' },
    [Symbol.asyncIterator]: async function* () {
      yield payload
    },
  }
}

function fakeRes() {
  let status = 0
  let body = ''
  return {
    writeHead(code) { status = code },
    end(payload) { body = payload },
    get status() { return status },
    get body() { return body },
  }
}

async function importPackage(body) {
  const handler = register().get(`${PREFIX}/import-module-package`)
  assert.ok(handler, '/import-module-package 端点应注册')
  const res = fakeRes()
  // 本文件覆盖转换与资源回归；覆盖场景显式授权，并经实际预览取得本次提交凭据。
  const request = { ...body, overwrite: true }
  await handler(fakeReq({ ...request, preview: true }), res)
  if (res.status === 200 && JSON.parse(res.body).value?.state === 'ready') {
    const { sourceDigest, previewRevision } = JSON.parse(res.body).value
    await handler(fakeReq({ ...request, expectedSourceDigest: sourceDigest, expectedPreviewRevision: previewRevision }), res)
  }
  return { status: res.status, payload: JSON.parse(res.body) }
}

/** 合法预设包：id + 数组组合（agent.cordis.yml 回退）。 */
function presetPackage(overrides = {}) {
  return {
    files: [
      { path: 'demo/module.yml', content: overrides.presetYml ?? 'id: demo\nname: Demo 预设\n' },
      { path: 'demo/agent.cordis.yml', content: '- id: demo-row\n  name: "@deepseek-ai/dsh-demo"\n' },
      ...(overrides.files ?? []),
    ],
  }
}

test('importPresetPackage：文件夹导入保留子目录（服务端为唯一剥离点）', async () => {
  const { status, payload } = await importPackage(presetPackage({
    files: [{ path: 'demo/engine/foo.mjs', content: 'export const x = 1\n' }],
  }))
  assert.equal(status, 200)
  assert.equal(payload.value?.id, 'demo')
  const engineFile = join(PRESETS, 'demo', 'engine', 'foo.mjs')
  assert.ok(existsSync(engineFile), '子目录文件应保留为 engine/foo.mjs')
  assert.equal(readFileSync(engineFile, 'utf8'), 'export const x = 1\n')
  assert.equal(existsSync(join(PRESETS, 'demo', 'agent.cordis.yml')), false, '旧组合不再落独立产物')
  assert.match(parseYaml(readFileSync(join(PRESETS, 'demo', 'module.yml'), 'utf8')).composition, /demo-row/, '旧包组合完整收进定义')
})

test('importPresetPackage：超过 32MB 上限返回 413 明确错误', async () => {
  const { status, payload } = await importPackage({
    files: [{ path: 'big/module.yml', content: 'id: big\n' + 'x'.repeat(MAX_BRIDGE_BODY_BYTES) }],
  })
  assert.equal(status, 413)
  assert.equal(payload.code, 'bridge-body-too-large')
  assert.ok(!existsSync(join(PRESETS, 'big')), '超限包不得写入')
})

test('准备期被改动即拒写：预览后源内容变化，旧凭据提交不得落盘', async () => {
  const handler = register().get(`${PREFIX}/import-module-package`)
  assert.ok(handler, '/import-module-package 端点应注册')
  const target = join(PRESETS, 'demo')

  // 1) 用原始包预览并取得本次提交凭据（sourceDigest + previewRevision）。
  const previewRes = fakeRes()
  await handler(fakeReq({ ...presetPackage({}), overwrite: true, preview: true }), previewRes)
  assert.equal(previewRes.status, 200, previewRes.body)
  const preview = JSON.parse(previewRes.body).value
  assert.equal(preview.state, 'ready')
  assert.ok(typeof preview.previewRevision === 'string' && preview.previewRevision.length > 0)

  // 2) 提交时源已变（多带一个文件），却仍用上一步的凭据 —— 必须被拒。
  const staleRes = fakeRes()
  await handler(fakeReq({
    ...presetPackage({ files: [{ path: 'demo/added-after-preview.txt', content: 'changed\n' }] }),
    overwrite: true,
    expectedSourceDigest: preview.sourceDigest,
    expectedPreviewRevision: preview.previewRevision,
  }), staleRes)

  assert.notEqual(staleRes.status, 200, `准备期已变仍应拒绝，实际 ${staleRes.body}`)
  const definition = join(target, 'module.yml')
  if (existsSync(definition)) {
    assert.doesNotMatch(readFileSync(definition, 'utf8'), /changed/, '被拒的提交不得改动目标定义')
  }
  assert.ok(!existsSync(join(target, 'added-after-preview.txt')), '被拒的提交不得写入新增文件')
})

test('importPresetPackage：路径穿越条目被明确拒绝，不落盘', async () => {
  for (const files of [
    [{ path: 'demo/../evil.yml', content: 'x' }],
    [{ path: 'C:/evil2.yml', content: 'y' }],
    [{ path: '/abs-evil.yml', content: 'z' }],
    [{ path: '\\abs-evil.yml', content: 'z' }],
  ]) {
    const { status, payload } = await importPackage(presetPackage({ files }))
    assert.equal(status, 400, `非法路径必须 fail closed：${files[0].path}`)
    assert.equal(payload.code, 'module-package-invalid')
    assert.match(payload.message, /非法|路径/)
  }
  assert.ok(!existsSync(join(PRESETS, 'evil.yml')), '穿越条目不得写到预设目录之外')
  assert.ok(!existsSync(join(PRESETS, 'demo', 'evil.yml')), '穿越条目不得写入预设目录')
  assert.ok(!existsSync(join(PRESETS, 'demo', 'evil2.yml')))
  assert.ok(!existsSync(join(PRESETS, 'demo', 'abs-evil.yml')))
})

test('importPresetPackage：组合无法解析（modules 引用缺失）→ 400 且目录回滚', async () => {
  const { status, payload } = await importPackage(presetPackage({
    presetYml: 'id: bad-module\nmodules:\n  - no-such-module\n',
    files: [{ path: 'bad-module/noop.yml', content: 'x' }],
  }))
  assert.equal(status, 400)
  assert.equal(payload.code, 'module-package-invalid')
  assert.equal(payload.value?.backupPath, undefined, '失败响应不含 backupPath')
  assert.ok(!existsSync(join(PRESETS, 'bad-module')), '校验失败后目标目录应回滚删除')
})

test('importPresetPackage：显式同名覆盖安装完整候选，成功清理备份', async () => {
  const first = await importPackage(presetPackage())
  assert.equal(first.status, 200)
  const second = await importPackage(presetPackage({
    files: [{ path: 'demo/version2.txt', content: 'v2' }],
  }))
  assert.equal(second.status, 200)
  assert.equal(second.payload.value?.id, 'demo')
  assert.equal(second.payload.value?.backupPath, undefined)
  assert.ok(existsSync(join(PRESETS, 'demo', 'version2.txt')), '新版文件应写入目标目录')
})

test('importPresetPackage：文件夹导入且 module.yml 无 id 时回退文件夹名', async () => {
  const { status, payload } = await importPackage({
    files: [
      { path: 'my-persona/module.yml', content: 'name: 我的预设\n' },
      { path: 'my-persona/agent.cordis.yml', content: '- id: demo-row\n  name: "@deepseek-ai/dsh-demo"\n' },
    ],
  })
  assert.equal(status, 200)
  assert.equal(payload.value?.id, 'my-persona', '无 id 时应用文件夹名')
  assert.ok(existsSync(join(PRESETS, 'my-persona', 'module.yml')))
})

test('importPresetPackage：SillyTavern JSON 单文件经转换引擎导入（按需组装，不注入默认内容）', async () => {
  const { status, payload } = await importPackage({
    files: [{
      path: 'my-chara.json',
      content: JSON.stringify({
        name: '我的角色',
        prompts: [
          { identifier: 'main', name: '主提示', content: '你是助手。', role: 'system', system_prompt: true, injection_order: 100, enabled: true },
          { identifier: 'nsfw', name: '备用提示', content: '关闭限制。', role: 'user', enabled: false, injection_position: 1 },
        ],
        temperature: 0.8,
        openai_max_tokens: 2048,
        reasoning_effort: 'low',
        enable_web_search: false,
      }),
    }],
  })
  assert.equal(status, 200)
  assert.equal(payload.value?.id, 'my-chara')
  const presetFile = join(PRESETS, 'my-chara', 'module.yml')
  assert.ok(existsSync(presetFile), '转换产物应落盘为 module.yml')
  const converted = parseYaml(readFileSync(presetFile, 'utf8'))
  assert.equal(converted.name, '我的角色（SillyTavern 转换）', '预设名取卡片 name 字段')
  assert.deepEqual(converted.modules, [
    'rule-engine', 'character-tools',
    'session-var-tools', 'tool-config-engine',
  ], 'ST 管理工具按固定集合装配；persona 行由顶层 persona 段渲染时自动前插')
  assert.deepEqual(converted.persona, { prefix: '', complete: false }, 'system-section 注入需要顶层 persona（complete: false 允许其生效）')
  assert.equal(converted.modules.includes('tool-web'), false, 'enable_web_search: false 不组装 tool-web')
  // B7 T3「3+1 结合」：`enable_web_search: false` 由三条声明式触发器
  // （呈现裁剪 / SDK 正文裁剪 / 执行 guard）共用同一份 deny 名单表达。
  const webRules = converted.rules.filter(rule => rule.id.startsWith('st-web-'))
  assert.deepEqual(webRules.map((rule) => [rule.id, rule.then[0].kind]), [
    ['st-web-assembly', 'assembly'],
    ['st-web-sdk-strip', 'sdk-strip'],
    ['st-web-guard', 'guard'],
  ])
  assert.deepEqual(webRules.map(rule => rule.then[0].id), ['st-web-assembly', 'st-web-sdk-strip', 'st-web-guard'],
    '动作自带稳定 id：不再经旧声明路径被补成占位符 action-N')
  for (const rule of webRules) {
    assert.equal(rule.then.length, 1)
    const mask = rule.then[0].target?.tools ?? rule.then[0].mask
    assert.deepEqual(mask, { deny: ['web_search', 'web_fetch'] }, '三条声明共用同一份 deny 名单')
  }
  const configs = contentEntries(converted)
  assert.equal(configs.length, 2)
  assert.equal(converted.rules.length, 5, '只生成两条内容规则和三条 Web 防护规则')
  const main = converted.rules.find((rule) => rule.id === 'main')
  assert.deepEqual(main, {
    // RELATIVE 注入顺序 = prompt_order / 数组顺序（ST 忽略 injection_order）。
    id: 'main', name: '主提示', enabled: true, layer: 'system-section',
    then: [{ id: 'inject', kind: 'inject-text', config: {
      id: 'main', strategy: 'static', order: 0,
      text: '你是助手。', layer: 'system-section', mergeMode: 'merged',
    // system_prompt 只是 ST 的管理位（不改变发送角色）：保留为来源事实，层归属仍按 role。
    params: {
      stSource: { position: 0, depth: 4, order: 100, role: 'system', systemPrompt: true },
      stMacros: true,
    },
    } }],
  })
  const nsfw = configs.find((config) => config.id === 'nsfw')
  assert.equal(nsfw.enabled, false, 'ST OFF 备用提示词保留 enabled: false')
  assert.equal(nsfw.layer, 'pre-step')
  assert.equal(nsfw.role, 'user')
  assert.equal(nsfw.position, 'after-user')
  assert.equal(nsfw.order, 10, 'in-chat 注入同样按数组顺序排（本项目无深度注入）')
  // 采样参数剥离：模型参数由「模型设置」UI 管理，ST 卡固化值不写入转换产物
  //（避免覆盖用户在模型设置里的设置）。
  for (const key of ['modelTemperature', 'modelMaxTokens', 'modelReasoningEffort']) {
    assert.equal(converted.params?.[key], undefined, `采样参数剥离：params.${key} 不得出现`)
  }
})

test('importPresetPackage：SillyTavern UUID identifier 的 prompt_order 禁用与排序生效（P1 回归）', async () => {
  const uuidA = 'f3f0a1b2-1111-4a2b-9c3d-000000000001'
  const uuidB = 'f3f0a1b2-1111-4a2b-9c3d-000000000002'
  const { status } = await importPackage({
    files: [{
      path: 'uuid-card.json',
      content: JSON.stringify({
        name: 'UUID 卡',
        prompts: [
          { identifier: uuidA, name: '系统提示', content: '你是助手。', role: 'system', enabled: true },
          { identifier: uuidB, name: '禁用提示', content: '不要理用户。', role: 'user', enabled: true },
        ],
        // ST 官方导出：identifier 为 UUID，禁用/重排只体现在 prompt_order。
        prompt_order: [
          { identifier: uuidB, enabled: false },
          { identifier: uuidA, enabled: true },
        ],
      }),
    }],
  })
  assert.equal(status, 200)
  const converted = parseYaml(readFileSync(join(PRESETS, 'uuid-card', 'module.yml'), 'utf8'))
  const configs = contentEntries(converted)
  const system = configs.find((config) => config.id === 'st-prompt-1')
  const disabled = configs.find((config) => config.id === 'st-prompt-2')
  // UUID identifier 回退 st-prompt-N 作 id，但禁用/排序必须按原始 identifier 查 prompt_order。
  assert.equal(system.enabled, true, 'prompt_order 未禁用的条目保持启用')
  assert.equal(disabled.enabled, false, 'prompt_order 禁用的 UUID 条目必须禁用（P1：此前回退 prompts.enabled 误启用）')
  assert.equal(system.order, 10, 'prompt_order 中排第 2 → order 10')
  assert.equal(disabled.order, 0, 'prompt_order 中排第 1 → order 0（P1：此前回退数组序）')
})

test('importPresetPackage：SillyTavern JSON 非法内容返回 400 且不落盘', async () => {
  const { status, payload } = await importPackage({
    files: [{ path: 'broken.json', content: '{not-json' }],
  })
  assert.equal(status, 400)
  assert.equal(payload.code, 'module-package-invalid')
  assert.match(payload.message, /broken\.json/)
  assert.ok(!existsSync(join(PRESETS, 'broken')), '转换失败不得写入')
})

test('importPresetPackage：TavernHelper 扩展注入物剥离（JS 脚本不进入转换产物）', async () => {
  const { status } = await importPackage({
    files: [{ path: '带扩展角色.json', content: JSON.stringify({
      spec: 'chara_card_v3', spec_version: '3.0', name: '带扩展角色',
      first_mes: '你好',
      data: {
        name: '带扩展角色', first_mes: '你好',
        extensions: {
          tavern_helper: [['scripts', [{ type: 'script', name: 'ERA框架', content: 'import{Converter}from opencc-js' }]]],
          regex_scripts: [{ scriptName: 'test' }],
        },
      },
    }) }],
  })
  assert.equal(status, 200)
  // 纯中文文件名 → id 退化为 st-<hash>（官方 agent-presets 不接受中文目录名）。
  const presetId = stPresetId('带扩展角色')
  assert.match(presetId, /^st-[0-9a-f]{6}$/)
  const presetFile = join(PRESETS, presetId, 'module.yml')
  const content = readFileSync(presetFile, 'utf8')
  assert.ok(!content.includes('opencc') && !content.includes('tavern_helper') && !content.includes('regex_scripts'),
    '扩展注入物（TavernHelper 脚本/正则）不进转换产物')
})

test('importPresetPackage：角色卡世界书 add_always（CCv2/CCv3 常驻标记）→ constant: true', async () => {
  const { status, payload } = await importPackage({
    files: [{ path: 'ccv3-card.json', content: JSON.stringify({
      spec: 'chara_card_v3', spec_version: '3.0', name: 'CCv3 角色',
      first_mes: '你好',
      data: {
        name: 'CCv3 角色',
        description: '设定',
        character_book: {
          entries: [
            { id: 1, key: ['魔法'], keysecondary: [], content: '魔法设定', add_always: true, enabled: true, insertion_order: 100 },
            { id: 2, key: ['剑'], keysecondary: [], content: '剑设定', add_always: false, enabled: true, insertion_order: 200 },
            { id: 3, key: ['盾'], keysecondary: [], content: '盾设定', constant: true, enabled: true, insertion_order: 300 },
          ],
        },
      },
    }) }],
  })
  assert.equal(status, 200)
  assert.equal(payload.value?.id, 'ccv3-card')
  const converted = parseYaml(readFileSync(join(PRESETS, 'ccv3-card', 'module.yml'), 'utf8'))
  const configs = contentEntries(converted).filter((config) => config.strategy === 'world-book')
  assert.equal(configs.length, 3, '三条世界书条目全部转换')
  assert.equal(configs.find((config) => config.id === 'lore-1').params.constant, true, 'add_always: true 应常驻')
  assert.equal(configs.find((config) => config.id === 'lore-2').params.constant, false, 'add_always: false 不常驻')
  assert.equal(configs.find((config) => config.id === 'lore-3').params.constant, true, 'constant: true 仍常驻')
})

test('importPresetPackage：世界书 ST 编辑器内部格式（key/keysecondary/order/disable/uid）别名收敛', async () => {
  const { status } = await importPackage({
    files: [{ path: 'editor-format.json', content: JSON.stringify({
      spec: 'chara_card_v3', spec_version: '3.0', name: '编辑器格式',
      data: {
        name: '编辑器格式',
        character_book: {
          entries: [
            // 关键词条目：key 单数 + add_always false → 必须保持关键词触发（不得常驻）。
            { uid: 10, key: ['酒吧'], keysecondary: ['酒保'], content: '酒吧设定', add_always: false, disable: false, order: 50 },
            // 禁用条目：disable: true → enabled: false。
            { uid: 11, key: ['禁词'], content: '禁用设定', add_always: false, disable: true, order: 60 },
            // 匹配开关 camelCase 形态 + 正则形态键（ST 无 useRegex 字段：正则键自动检测）。
            { uid: 12, key: ['/城堡\\d+/'], content: '城堡设定', add_always: false, disable: false, order: 70, caseSensitive: true, matchWholeWords: true },
          ],
        },
      },
    }) }],
  })
  assert.equal(status, 200)
  const converted = parseYaml(readFileSync(join(PRESETS, 'editor-format', 'module.yml'), 'utf8'))
  const configs = contentEntries(converted).filter((config) => config.strategy === 'world-book')
  assert.equal(configs.length, 3)
  const bar = configs.find((config) => config.id === 'lore-10')
  assert.deepEqual(bar.params.keys, ['酒吧'], 'key 单数应收敛为 keys')
  assert.deepEqual(bar.params.secondaryKeys, ['酒保'], 'keysecondary 应收敛为 secondaryKeys')
  assert.equal(bar.params.constant, false, '关键词条目不常驻')
  assert.equal(bar.enabled, true, 'disable: false → 启用')
  assert.equal(bar.order, 50, '最终正文按 ST unshift 结果升序；激活优先级另行处理')
  const banned = configs.find((config) => config.id === 'lore-11')
  assert.equal(banned.enabled, false, 'disable: true → 禁用')
  const castle = configs.find((config) => config.id === 'lore-12')
  assert.equal(castle.params.caseSensitive, true)
  assert.equal(castle.params.wholeWords, true)
  assert.deepEqual(castle.params.keys, ['/城堡\\d+/'], '正则形态键原样保留')
  assert.equal('useRegex' in castle.params, false, '不写幽灵字段 useRegex（正则键由 anchor-match 自动检测）')
})

test('convertStToModule：未定义宏登记为空占位；内建名与运行时宏名不登记也不诊断', () => {
  const { spec, report } = convertStToModuleWithReport({
    name: '宏卡',
    character_book: { entries: [
      // 无来源（含中文名）→ 登记空占位并产出可定位诊断，插值不留字面。
      { id: 1, key: ['{{未知宏}}', '{{时间}}', '{{dsh_home}}'], content: 'A', enabled: true, insertion_order: 100 },
      // 运行时宏名大小写不敏感；内建名大小写敏感（只有精确的 DSH_HOME 是保留名）。
      { id: 2, key: ['{{time}}', '{{TIME}}'], content: 'B', enabled: true, insertion_order: 200 },
      { id: 3, key: ['{{DSH_HOME}}'], content: 'C', enabled: true, insertion_order: 300 },
      // 卡名已声明 char：由 declaredKeys 一侧跳过，不得被当成未定义宏。
      { id: 4, key: ['{{char}}'], content: 'D', enabled: true, insertion_order: 400 },
    ] },
  }, 'macro-card')
  for (const key of ['未知宏', '时间', 'dsh_home']) assert.equal(spec.variables[key], '', `${key} 无来源 → 空占位`)
  for (const key of ['time', 'TIME', 'DSH_HOME']) assert.equal(Object.hasOwn(spec.variables, key), false, `${key} 已有来源，不得登记为空占位`)
  assert.equal(spec.variables.char, '宏卡', 'declaredKeys 只跳过登记，不改写声明值')
  const diagnosed = id => report.diagnostics.some(item => item.code === 'st-key-macro' && item.entryId === id)
  assert.equal(diagnosed('1'), true, '无来源的键宏必须留诊断')
  for (const id of ['2', '3', '4']) assert.equal(diagnosed(id), false, `已有来源的键宏不报告（entry ${id}）`)
})

test.after(() => {
  for (const dispose of bridgeDisposers) dispose()
  rmSync(home, { recursive: true, force: true })
})
