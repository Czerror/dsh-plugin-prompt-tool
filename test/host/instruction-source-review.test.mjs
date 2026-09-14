import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'
import { Document } from 'yaml'

const sandbox = mkdtempSync(join(tmpdir(), 'pt-instruction-source-'))
const home = join(sandbox, 'home')
mkdirSync(home)
process.env.DSH_HOME = home

// 直接执行本轮源码，不重建共享 lib；沿用客户端测试的内存 TS 转译方式。
// bridge 的动态引擎 URL 按构建后的 lib/ 布局书写，测试只重定向到真实 engine/。
const sourceRoot = new URL('../../src/', import.meta.url).href
const sourceEngine = new URL('../../src/engine/', import.meta.url).href
const engineRoot = new URL('../../engine/', import.meta.url)
const loader = registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier.startsWith(sourceEngine)
      ? new URL(specifier.slice(sourceEngine.length), engineRoot).href
      : specifier, context)
  },
  load(url, context, nextLoad) {
    if (!url.startsWith(sourceRoot) || !url.endsWith('.ts')) return nextLoad(url, context)
    return {
      format: 'module',
      shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 },
      }).outputText,
    }
  },
})

after(() => {
  loader.deregister()
  assert.equal(dirname(sandbox), resolve(tmpdir()), '只清理本次隔离临时目录')
  rmSync(sandbox, { recursive: true, force: true })
})

const { agentsFileCardSpecs, agentsFileId, detectAgentsFiles, readAgentsFileSnapshot, writeAgentsFileChecked } =
  await import('../../src/host/agents-cards.ts')
const { mergeInstructionCards, registerSettingsBridge } = await import('../../src/runtime/settings-bridge.ts')
const { validatePromptConfigs } = await import('../../src/runtime/configs-validate.ts')
const { loadPresetSpec, userPresetsDir } = await import('../../src/host/manifest.ts')
const { loadPromptConfigFiles } = await import('../../src/host/prompt-configs.ts')
const { BRIDGE_ENDPOINTS, SETTINGS_BRIDGE_PREFIX } = await import('../../src/shared/bridge-contract.ts')

const ordinaryCards = [
  { id: 'project-extra', layer: 'pre-step', strategy: 'placeholder', fill: 'instruction-hint', params: { file: 'D:/example/rules/EXTRA.md' } },
  { id: 'ordinary', layer: 'pre-step', strategy: 'static', text: 'KEEP' },
]

function makeHarness(dir = '', cwd) {
  const handlers = new Map()
  const sctx = {
    settings: {
      describe: () => [{ ns: 'prompt-tool', value: {}, base: {}, revision: 1 }],
      get: () => undefined,
    },
    webServer: { register: ({ path, handler }) => { handlers.set(path, handler); return () => {} } },
    get: (name) => name === 'agents'
      ? { get: (id) => id === 'session-1' ? { session: { header: { cwd } } } : undefined }
      : undefined,
    effect: (fn) => fn(),
  }
  registerSettingsBridge(
    { inject: (_deps, callback) => callback(sctx) },
    'prompt-tool',
    () => ({ available: true, providers: [] }),
    () => ({ activeSkillsDirs: [], skillCatalog: [] }),
    () => '',
    undefined,
    () => dir,
  )
  return async (endpoint, body = {}) => {
    let status
    let response
    const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + endpoint)
    assert.ok(handler, `${endpoint} 已注册`)
    await handler({
      method: 'POST',
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: 'localhost' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
    }, {
      writeHead(code) { status = code },
      end(value) { response = JSON.parse(value) },
    })
    return { status, body: response }
  }
}

function linkedRoots() {
  const dir = mkdtempSync(join(sandbox, 'links-'))
  const realHome = join(dir, 'home')
  const realProject = join(dir, 'project')
  const linkedHome = join(dir, 'home-link')
  const linkedProject = join(dir, 'project-link')
  mkdirSync(realHome)
  mkdirSync(join(realProject, '.git'), { recursive: true })
  mkdirSync(join(realProject, 'nested'))
  writeFileSync(join(realHome, 'AGENTS.md'), 'GLOBAL\n')
  writeFileSync(join(realProject, 'AGENTS.md'), 'PROJECT\n')
  writeFileSync(join(realProject, 'nested', 'CLAUDE.md'), 'NESTED\n')
  symlinkSync(realHome, linkedHome, 'junction')
  symlinkSync(realProject, linkedProject, 'junction')
  return { dir, realHome, realProject, linkedHome, linkedProject }
}

test('S1：合法普通提示词配置的 params.file 不构成独立来源身份', async () => {
  const validation = await validatePromptConfigs(ordinaryCards)
  assert.equal(validation.valid, true, JSON.stringify(validation.errors))
  assert.deepEqual(mergeInstructionCards(ordinaryCards, []), ordinaryCards)
})

test('S1：普通卡即使命中文件路径、fileId 或消息 sourceKind，也不被替换或抢占文件卡', () => {
  const dir = mkdtempSync(join(sandbox, 'ordinary-'))
  writeFileSync(join(dir, 'AGENTS.md'), 'FILE BODY\n')
  const file = detectAgentsFiles({ home, cwd: dir }).map(readAgentsFileSnapshot)[0]
  const cards = ['project-extra', 'agents-file-custom', `agents-file-${file.fileId}-extra`].map((id) => ({
    ...ordinaryCards[0],
    id,
    sourceKind: 'instruction-file',
    params: { file: file.path, fileId: file.fileId, text: 'PRESET BODY' },
  }))
  const merged = mergeInstructionCards(cards, [file])
  assert.deepEqual(merged.slice(0, cards.length), cards, '普通卡不附加独立源快照、不改正文')
  assert.equal(merged.length, cards.length + 1, '普通卡不占用独立文件来源身份')
  assert.equal(merged.at(-1).params.text, file.text)
})

test('S1：明确的旧生成卡身份仍按当前白名单刷新，外来生成卡不混入普通卡', () => {
  const dir = mkdtempSync(join(sandbox, 'legacy-'))
  writeFileSync(join(dir, 'AGENTS.md'), 'CURRENT\n')
  const file = detectAgentsFiles({ home, cwd: dir }).map(readAgentsFileSnapshot)[0]
  const current = { ...agentsFileCardSpecs([file])[0], order: 99, enabled: false }
  const legacy = {
    id: `agents-file-${file.fileId.slice(0, 8)}`,
    layer: 'pre-step',
    order: 88,
    params: { file: file.path },
  }
  for (const card of [current, legacy]) {
    const merged = mergeInstructionCards([card], [file])
    assert.equal(merged.length, 1)
    assert.equal(merged[0].order, card.order)
    assert.equal(merged[0].params.text, file.text)
    assert.equal(merged[0].params.revision, file.revision)
    assert.deepEqual(mergeInstructionCards([card, ...ordinaryCards], []), ordinaryCards, '旧生成卡不因路径未知而成为普通卡')
  }
})

for (const endpoint of [BRIDGE_ENDPOINTS.bootstrap, BRIDGE_ENDPOINTS.promptConfigs]) {
  test(`S1：${endpoint} 读取后再保存，不丢合法普通文件填充卡`, async () => {
    mkdirSync(userPresetsDir(), { recursive: true })
    const dir = mkdtempSync(join(userPresetsDir(), 'preset-'))
    mkdirSync(join(dir, 'prompt-configs'))
    writeFileSync(join(dir, 'preset.yml'), new Document({ id: 'source-review', modules: [], promptConfigs: ordinaryCards }).toString())
    const validation = await validatePromptConfigs(ordinaryCards)
    assert.equal(validation.valid, true, JSON.stringify(validation.errors))
    for (const file of validation.files) writeFileSync(join(dir, 'prompt-configs', file.file), file.content)
    const expected = loadPromptConfigFiles(join(dir, 'prompt-configs'))
    const call = makeHarness(dir)
    const response = await call(endpoint)
    assert.equal(response.status, 200, JSON.stringify(response.body))
    const cards = endpoint === BRIDGE_ENDPOINTS.bootstrap
      ? response.body.promptConfigs.promptConfigs
      : response.body.value.promptConfigs
    const saved = await call(BRIDGE_ENDPOINTS.paramOverrides, { promptConfigs: cards, rebuild: false })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    assert.deepEqual(loadPresetSpec(dir).promptConfigs, expected, '读→保存后的 preset.yml 不得丢卡')
    assert.deepEqual(cards, expected, '两个读入口均保留普通卡')
  })
}

test('S2：DSH_HOME 与项目根为目录链接时，真实授权范围内的文件可读可写且身份稳定', async () => {
  const { realHome, realProject, linkedHome, linkedProject } = linkedRoots()
  const files = detectAgentsFiles({ home: linkedHome, cwd: join(linkedProject, 'nested') })
  assert.deepEqual(files.map((file) => [file.scope, file.displayPath]), [
    ['global', '~/.dsh/AGENTS.md'], ['project', 'AGENTS.md'], ['project', 'nested/CLAUDE.md'],
  ])
  const realFiles = detectAgentsFiles({ home: realHome, cwd: join(realProject, 'nested') })
  assert.deepEqual(files.map((file) => file.fileId), realFiles.map((file) => file.fileId))
  for (const file of files) {
    assert.equal(file.realPath, realpathSync.native(file.path))
    const snapshot = readAgentsFileSnapshot(file)
    assert.equal(snapshot.status, 'ready')
    const content = `${snapshot.text}EDITED\n`
    const written = await writeAgentsFileChecked({ file, content, expectedRevision: snapshot.revision })
    assert.equal(written.ok, true, JSON.stringify(written))
    assert.equal(readFileSync(file.realPath, 'utf8'), content)
  }
})

test('S2：链接项目根内的越界目录链接仍不进入白名单，bridge 拒绝写越界文件', async () => {
  const { dir, realProject, linkedProject } = linkedRoots()
  // 使用带相同路径前缀的同级目录，既检查 realpath，也检查目录边界而非字符串前缀。
  const outside = join(dir, 'project-outside')
  mkdirSync(outside)
  const target = join(outside, 'AGENTS.md')
  writeFileSync(target, 'OUTSIDE\n')
  symlinkSync(outside, join(realProject, 'escape'), 'junction')
  for (const root of [realProject, linkedProject]) {
    const cwd = join(root, 'escape')
    const files = detectAgentsFiles({ home, cwd })
    const fileId = agentsFileId(realpathSync.native(target))
    assert.equal(files.some((file) => file.fileId === fileId), false)
    const call = makeHarness('', cwd)
    const boot = await call(BRIDGE_ENDPOINTS.bootstrap, { sessionId: 'session-1' })
    assert.equal(boot.status, 200, JSON.stringify(boot.body))
    const result = await call(BRIDGE_ENDPOINTS.agentsFile, {
      sessionId: 'session-1', contextId: boot.body.instructions.context.contextId,
      fileId, content: 'DENIED\n', expectedRevision: null,
    })
    assert.equal(result.status, 400, JSON.stringify(result.body))
    assert.equal(readFileSync(target, 'utf8'), 'OUTSIDE\n')
  }
})

test('S2：授权根链接被重定向后，即使字节版本相同也拒绝旧身份写入', async () => {
  const { dir, realProject, linkedProject } = linkedRoots()
  const file = detectAgentsFiles({ home, cwd: linkedProject })[0]
  assert.ok(file, '合法链接根中的文件必须先进入白名单')
  const snapshot = readAgentsFileSnapshot(file)
  const replacement = join(dir, 'replacement')
  mkdirSync(replacement)
  writeFileSync(join(replacement, 'AGENTS.md'), snapshot.text)
  unlinkSync(linkedProject)
  symlinkSync(replacement, linkedProject, 'junction')
  const result = await writeAgentsFileChecked({ file, content: 'DENIED\n', expectedRevision: snapshot.revision })
  assert.equal(result.ok, false)
  assert.equal(result.status, 409)
  assert.equal(result.code, 'agents-file-identity-changed')
  assert.equal(readFileSync(join(realProject, 'AGENTS.md'), 'utf8'), snapshot.text)
  assert.equal(readFileSync(join(replacement, 'AGENTS.md'), 'utf8'), snapshot.text)
})
