import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

// DSH_HOME 必须先于 lib 加载设置（paths.ts 模块级常量在 import 时求值），
// 因此本文件用动态 import 加载 lib，避免污染真实用户预设目录。
const home = mkdtempSync(join(tmpdir(), 'pt-package-import-'))
process.env.DSH_HOME = home
const { MAX_BRIDGE_BODY_BYTES, registerSettingsBridge, stPresetId } = await import('../../lib/index.mjs')

const PREFIX = '/api/prompt-tool/settings'
const PRESETS = join(home, '.agent-presets')

function makeHarness() {
  const handlers = new Map()
  const sctx = {
    settings: {
      describe: () => [{ ns: 'prompt-tool', value: {}, base: {} }],
      mutate: async () => {},
    },
    webServer: {
      register: ({ path, handler }) => { handlers.set(path, handler) },
    },
    effect: (fn) => fn(),
  }
  const ctx = { inject: (_deps, cb) => cb(sctx) }
  return { ctx, handlers }
}

function register() {
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(
    ctx,
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
  const handler = register().get(`${PREFIX}/import-preset-package`)
  assert.ok(handler, '/import-preset-package 端点应注册')
  const res = fakeRes()
  await handler(fakeReq(body), res)
  return { status: res.status, payload: JSON.parse(res.body) }
}

/** 合法预设包：id + 数组组合（agent.cordis.yml 回退）。 */
function presetPackage(overrides = {}) {
  return {
    files: [
      { path: 'demo/preset.yml', content: overrides.presetYml ?? 'id: demo\nname: Demo 预设\n' },
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
  assert.ok(existsSync(join(PRESETS, 'demo', 'agent.cordis.yml')), '顶层组合文件应落在预设根目录')
})

test('importPresetPackage：超过 32MB 上限返回 413 明确错误', async () => {
  const { status, payload } = await importPackage({
    files: [{ path: 'big/preset.yml', content: 'id: big\n' + 'x'.repeat(MAX_BRIDGE_BODY_BYTES) }],
  })
  assert.equal(status, 413)
  assert.equal(payload.code, 'bridge-body-too-large')
  assert.ok(!existsSync(join(PRESETS, 'big')), '超限包不得写入')
})

test('importPresetPackage：32MB 以内的大包（如含 .mjs 模块的官方预设）正常导入', async () => {
  const { status, payload } = await importPackage({
    files: [
      { path: 'large/preset.yml', content: 'id: large\nname: 大包预设\n' },
      { path: 'large/agent.cordis.yml', content: '- id: demo-row\n  name: "@deepseek-ai/dsh-demo"\n' },
      { path: 'large/big-data.txt', content: 'x'.repeat(200 * 1024) },
    ],
  })
  assert.equal(status, 200)
  assert.equal(payload.value?.id, 'large')
  assert.ok(existsSync(join(PRESETS, 'large', 'big-data.txt')), '大文本文件应落盘')
})

test('importPresetPackage：路径穿越条目被过滤，不落盘', async () => {
  const { status, payload } = await importPackage(presetPackage({
    files: [
      { path: 'demo/../evil.yml', content: 'x' },
      { path: 'C:/evil2.yml', content: 'y' },
      { path: '/abs-evil.yml', content: 'z' },
    ],
  }))
  assert.equal(status, 200)
  assert.equal(payload.value?.id, 'demo')
  assert.ok(!existsSync(join(PRESETS, 'evil.yml')), '穿越条目不得写到预设目录之外')
  assert.ok(!existsSync(join(PRESETS, 'demo', 'evil.yml')), '穿越条目不得写入预设目录')
  assert.ok(!existsSync(join(PRESETS, 'demo', 'evil2.yml')))
  assert.ok(!existsSync(join(PRESETS, 'demo', 'abs-evil.yml')))
})

test('importPresetPackage：缺少 preset.yml → 400', async () => {
  const { status, payload } = await importPackage({
    files: [{ path: 'nopreset/agent.cordis.yml', content: '- id: a\n' }],
  })
  assert.equal(status, 400)
  assert.equal(payload.code, 'preset-package-invalid')
})

test('importPresetPackage：preset.yml 非 YAML 映射 → 400 且不落盘', async () => {
  const { status, payload } = await importPackage({
    files: [{ path: 'badyaml/preset.yml', content: '- a\n- b\n' }],
  })
  assert.equal(status, 400)
  assert.equal(payload.code, 'preset-package-invalid')
  assert.ok(!existsSync(join(PRESETS, 'badyaml')), '非法包不得写入')
})

test('importPresetPackage：组合无法解析（modules 引用缺失）→ 400 且目录回滚', async () => {
  const { status, payload } = await importPackage(presetPackage({
    presetYml: 'id: bad-module\nmodules:\n  - no-such-module\n',
    files: [{ path: 'bad-module/noop.yml', content: 'x' }],
  }))
  assert.equal(status, 400)
  assert.equal(payload.code, 'preset-package-invalid')
  assert.match(payload.value?.backupPath ?? '', /$^/, '失败响应不含 backupPath')
  assert.ok(!existsSync(join(PRESETS, 'bad-module')), '校验失败后目标目录应回滚删除')
})

test('importPresetPackage：同名覆盖先备份且返回 backupPath', async () => {
  const first = await importPackage(presetPackage())
  assert.equal(first.status, 200)
  const second = await importPackage(presetPackage({
    files: [{ path: 'demo/version2.txt', content: 'v2' }],
  }))
  assert.equal(second.status, 200)
  assert.equal(second.payload.value?.id, 'demo')
  const backupPath = second.payload.value?.backupPath
  assert.ok(typeof backupPath === 'string' && backupPath.length > 0, '覆盖导入应返回 backupPath')
  assert.ok(existsSync(backupPath), `备份目录应存在: ${backupPath}`)
  assert.ok(existsSync(join(backupPath, 'agent.cordis.yml')), '备份目录应含旧版组合文件')
  assert.ok(existsSync(join(PRESETS, 'demo', 'version2.txt')), '新版文件应写入目标目录')
  // 清理备份目录，避免残留。
  rmSync(backupPath, { recursive: true, force: true })
})

test('importPresetPackage：单文件 preset.yml 导入 id 回退 imported-preset', async () => {
  const { status, payload } = await importPackage({
    files: [{
      path: 'preset.yml',
      content: [
        'name: 无 id 预设',
        'composition: |-',
        '  - id: demo-row',
        '    name: "@deepseek-ai/dsh-demo"',
        '',
      ].join('\n'),
    }],
  })
  assert.equal(status, 200)
  assert.equal(payload.value?.id, 'imported-preset')
  assert.ok(existsSync(join(PRESETS, 'imported-preset', 'preset.yml')))
})

test('importPresetPackage：文件夹导入且 preset.yml 无 id 时回退文件夹名', async () => {
  const { status, payload } = await importPackage({
    files: [
      { path: 'my-persona/preset.yml', content: 'name: 我的预设\n' },
      { path: 'my-persona/agent.cordis.yml', content: '- id: demo-row\n  name: "@deepseek-ai/dsh-demo"\n' },
    ],
  })
  assert.equal(status, 200)
  assert.equal(payload.value?.id, 'my-persona', '无 id 时应用文件夹名')
  assert.ok(existsSync(join(PRESETS, 'my-persona', 'preset.yml')))
})

test('importPresetPackage：文件夹导入支持自定义定义文件名（落盘统一为 preset.yml）', async () => {
  const { status, payload } = await importPackage({
    files: [
      { path: 'custom-name/config.yaml', content: 'id: custom-name\nname: 自定义文件名预设\n' },
      { path: 'custom-name/agent.cordis.yml', content: '- id: demo-row\n  name: "@deepseek-ai/dsh-demo"\n' },
    ],
  })
  assert.equal(status, 200)
  assert.equal(payload.value?.id, 'custom-name')
  assert.ok(existsSync(join(PRESETS, 'custom-name', 'preset.yml')), '定义文件应归一为 preset.yml')
  assert.ok(!existsSync(join(PRESETS, 'custom-name', 'config.yaml')), '原文件名不应残留')
  assert.ok(existsSync(join(PRESETS, 'custom-name', 'agent.cordis.yml')), '组合文件保留原名')
})

test('importPresetPackage：顶层多个 yml 时仅被选中的定义文件改名，其余保留', async () => {
  const { status, payload } = await importPackage({
    files: [
      { path: 'multi/my-definition.yml', content: 'id: multi\nname: 多 yml 预设\n' },
      { path: 'multi/notes.yaml', content: 'note: 这是说明文件\n' },
      { path: 'multi/agent.cordis.yml', content: '- id: demo-row\n  name: "@deepseek-ai/dsh-demo"\n' },
    ],
  })
  assert.equal(status, 200)
  assert.equal(payload.value?.id, 'multi')
  assert.ok(existsSync(join(PRESETS, 'multi', 'preset.yml')), '被选中的定义文件应改名为 preset.yml')
  assert.ok(existsSync(join(PRESETS, 'multi', 'notes.yaml')), '其余 yml 保留原名')
  assert.equal(
    readFileSync(join(PRESETS, 'multi', 'preset.yml'), 'utf8'),
    'id: multi\nname: 多 yml 预设\n',
    'preset.yml 内容应来自被选中的定义文件',
  )
})

test('importPresetPackage：写入后目录内容完整（顶层 + 子目录文件计数）', async () => {
  const { status } = await importPackage(presetPackage({
    files: [
      { path: 'demo/engine/a.mjs', content: 'a' },
      { path: 'demo/engine/sub/b.mjs', content: 'b' },
      { path: 'demo/data.json', content: '{}' },
    ],
  }))
  assert.equal(status, 200)
  const walk = (dir) => {
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name)
      return entry.isDirectory() ? walk(full) : [full.slice(PRESETS.length + 1).replaceAll('\\', '/')]
    })
  }
  const files = walk(join(PRESETS, 'demo'))
  for (const expected of ['demo/preset.yml', 'demo/agent.cordis.yml', 'demo/engine/a.mjs', 'demo/engine/sub/b.mjs', 'demo/data.json']) {
    assert.ok(files.includes(expected), `应包含 ${expected}，实际: ${files.join(', ')}`)
  }
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
  const presetFile = join(PRESETS, 'my-chara', 'preset.yml')
  assert.ok(existsSync(presetFile), '转换产物应落盘为 preset.yml')
  const converted = parseYaml(readFileSync(presetFile, 'utf8'))
  assert.equal(converted.name, '我的角色（SillyTavern 转换）', '预设名取卡片 name 字段')
  assert.deepEqual(converted.modules, [
    'persona', 'prompt-config-engine', 'character-tools',
    'session-var-tools', 'tool-config-engine', 'tool-filter',
  ], 'system-section 注入需要 persona；ST 管理工具按固定集合装配')
  assert.equal(converted.moduleConfigs.persona.complete, false, 'complete: false 允许 system-section 生效')
  assert.equal(converted.modules.includes('tool-web'), false, 'enable_web_search: false 不组装 tool-web')
  assert.deepEqual(converted.moduleConfigs['tool-filter'], { includeSubagents: false, deny: ['web_search', 'web_fetch'] }, 'false 时 tool-filter deny web 工具')
  const configs = converted.promptConfigs
  assert.equal(configs.length, 2)
  const main = configs.find((config) => config.id === 'main')
  assert.deepEqual(main, {
    // RELATIVE 注入顺序 = prompt_order / 数组顺序（ST 忽略 injection_order）。
    id: 'main', name: '主提示', enabled: true, strategy: 'static', order: 0,
    text: '你是助手。', layer: 'system-section', mergeMode: 'merged',
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
  assert.equal(configs.find((config) => config.id === 'st-sampling'), undefined, '不再生成 st-sampling agent-request 配置')
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
  const converted = parseYaml(readFileSync(join(PRESETS, 'uuid-card', 'preset.yml'), 'utf8'))
  const configs = converted.promptConfigs
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
  assert.equal(payload.code, 'preset-package-invalid')
  assert.match(payload.message, /SillyTavern JSON 转换失败/)
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
  const presetFile = join(PRESETS, presetId, 'preset.yml')
  const content = readFileSync(presetFile, 'utf8')
  assert.ok(!content.includes('opencc') && !content.includes('tavern_helper') && !content.includes('regex_scripts'),
    '扩展注入物（TavernHelper 脚本/正则）不进转换产物')
})

test('importPresetPackage：未定义自定义宏自动登记为预设 variables 空值占位', async () => {
  const { status } = await importPackage({
    files: [{ path: 'custom-macro.json', content: JSON.stringify({
      name: '宏测试卡',
      prompts: [
        { identifier: 'main', name: '主提示', content: '今天{{日期}}，心情{{心情Emoji}}，学生{{student_name}}', role: 'user', enabled: true },
      ],
    }) }],
  })
  assert.equal(status, 200)
  const converted = parseYaml(readFileSync(join(PRESETS, 'custom-macro', 'preset.yml'), 'utf8'))
  assert.equal(converted.variables?.['日期'], '', '未定义宏登记空值（不留字面）')
  assert.equal(converted.variables?.['心情Emoji'], '')
  assert.equal(converted.variables?.['student_name'], '')
  assert.equal(converted.variables?.['lastusermessage'], undefined, '运行时宏不登记')
  assert.equal(converted.variables?.['DSH_HOME'], undefined, '内置变量不登记')
})

test('importPresetPackage：SillyTavern enable_web_search=true 时组装 tool-web 并启用 fetch', async () => {
  const { status } = await importPackage({
    files: [{ path: 'web.json', content: JSON.stringify({
      name: 'web 角色',
      prompts: [{ identifier: 'main', name: '主提示', content: '你是助手。', role: 'user', system_prompt: false, enabled: true }],
      enable_web_search: true,
    }) }],
  })
  assert.equal(status, 200)
  const presetFile = join(PRESETS, 'web', 'preset.yml')
  const converted = parseYaml(readFileSync(presetFile, 'utf8'))
  assert.equal(converted.name, 'web 角色（SillyTavern 转换）', '预设名取卡片 name 字段')
  assert.ok(converted.modules.includes('tool-web'), 'enable_web_search: true 应组装 tool-web')
  assert.deepEqual(converted.moduleConfigs['tool-web'], { fetch: true }, 'true 时启用 fetch')
})

test('importPresetPackage：SillyTavern 卡片无 name 时预设名回退文件名', async () => {
  const { status } = await importPackage({
    files: [{ path: 'unnamed-chara.json', content: JSON.stringify({
      prompts: [{ identifier: 'main', content: '你是助手。', role: 'user', enabled: true }],
    }) }],
  })
  assert.equal(status, 200)
  const presetFile = join(PRESETS, 'unnamed-chara', 'preset.yml')
  const converted = parseYaml(readFileSync(presetFile, 'utf8'))
  assert.equal(converted.name, 'unnamed-chara（SillyTavern 转换）', '卡片 name 缺失时回退文件名（去 .json）')
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
  const converted = parseYaml(readFileSync(join(PRESETS, 'ccv3-card', 'preset.yml'), 'utf8'))
  const configs = converted.promptConfigs.filter((config) => config.strategy === 'world-book')
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
  const converted = parseYaml(readFileSync(join(PRESETS, 'editor-format', 'preset.yml'), 'utf8'))
  const configs = converted.promptConfigs.filter((config) => config.strategy === 'world-book')
  assert.equal(configs.length, 3)
  const bar = configs.find((config) => config.id === 'lore-10')
  assert.deepEqual(bar.params.keys, ['酒吧'], 'key 单数应收敛为 keys')
  assert.deepEqual(bar.params.secondaryKeys, ['酒保'], 'keysecondary 应收敛为 secondaryKeys')
  assert.equal(bar.params.constant, false, '关键词条目不常驻')
  assert.equal(bar.enabled, true, 'disable: false → 启用')
  assert.equal(bar.order, -50, 'order 取反（ST 大优先 → 引擎升序；编辑器格式无 insertion_order 时用 order）')
  const banned = configs.find((config) => config.id === 'lore-11')
  assert.equal(banned.enabled, false, 'disable: true → 禁用')
  const castle = configs.find((config) => config.id === 'lore-12')
  assert.equal(castle.params.caseSensitive, true)
  assert.equal(castle.params.wholeWords, true)
  assert.deepEqual(castle.params.keys, ['/城堡\\d+/'], '正则形态键原样保留')
  assert.equal('useRegex' in castle.params, false, '不写幽灵字段 useRegex（正则键由 anchor-match 自动检测）')
})

test('importPresetPackage：世界书 entries 为对象（键为字符串序数）时形态兼容', async () => {
  const { status } = await importPackage({
    files: [{ path: 'obj-entries.json', content: JSON.stringify({
      spec: 'chara_card_v3', spec_version: '3.0', name: '对象条目',
      data: {
        name: '对象条目',
        character_book: {
          entries: {
            0: { uid: 1, key: ['森林'], content: '森林设定', add_always: false, enabled: true, insertion_order: 10 },
            1: { uid: 2, key: ['河流'], content: '河流设定', add_always: false, enabled: true, insertion_order: 20 },
          },
        },
      },
    }) }],
  })
  assert.equal(status, 200)
  const converted = parseYaml(readFileSync(join(PRESETS, 'obj-entries', 'preset.yml'), 'utf8'))
  const configs = converted.promptConfigs.filter((config) => config.strategy === 'world-book')
  assert.equal(configs.length, 2, '对象形态 entries 应全部转换')
  assert.deepEqual(configs.map((config) => config.id).sort(), ['lore-1', 'lore-2'], 'uid 应作为条目 id')
  assert.deepEqual(configs.find((config) => config.id === 'lore-2').params.keys, ['河流'])
})

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})
