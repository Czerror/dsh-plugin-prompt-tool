import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// DSH_HOME 必须先于 lib 加载设置（paths.ts 模块级常量在 import 时求值），
// 因此本文件用动态 import 加载 lib，避免污染真实用户预设目录。
const home = mkdtempSync(join(tmpdir(), 'pt-package-import-'))
process.env.DSH_HOME = home
const { registerSettingsBridge } = await import('../../lib/index.mjs')

const PREFIX = '/api/prompt-tool/settings'
const PRESETS = join(home, 'presets')

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
    'prompt-tool',
    () => true,
    () => ({ available: true, providers: [] }),
    () => ({ activeSkillsDir: '', skillCatalog: [] }),
    () => ({ presetText: '', agentsText: '' }),
    () => '',
    () => true,
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

test('importPresetPackage：超过 8MB 上限返回 413 明确错误', async () => {
  const { status, payload } = await importPackage({
    files: [{ path: 'big/preset.yml', content: 'id: big\n' + 'x'.repeat(9 * 1024 * 1024) }],
  })
  assert.equal(status, 413)
  assert.equal(payload.code, 'preset-package-too-large')
  assert.ok(!existsSync(join(PRESETS, 'big')), '超限包不得写入')
})

test('importPresetPackage：64KB~8MB 之间的大包（如含 .mjs 模块的官方预设）正常导入', async () => {
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

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})
