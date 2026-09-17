import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// W2 收尾：指令文件来源的范围与防护回归（T11–T13 中 host 侧尚未覆盖的部分）。
// 只断言行为：端点防护、目录/越界符号链接不进入白名单、两个会话/工作区互不串。
const home = mkdtempSync(join(tmpdir(), 'pt-guard-home-'))
process.env.DSH_HOME = home
const { BRIDGE_ENDPOINTS, SETTINGS_BRIDGE_PREFIX, registerSettingsBridge } = await import('../../lib/index.mjs')

const rootA = mkdtempSync(join(tmpdir(), 'pt-guard-a-'))
const rootB = mkdtempSync(join(tmpdir(), 'pt-guard-b-'))
const outside = mkdtempSync(join(tmpdir(), 'pt-guard-outside-'))
mkdirSync(join(rootA, '.git'), { recursive: true })
mkdirSync(join(rootB, '.git'), { recursive: true })
writeFileSync(join(home, 'AGENTS.md'), 'GLOBAL RULES\n', 'utf8')
writeFileSync(join(rootA, 'AGENTS.md'), 'WORKSPACE A\n', 'utf8')
writeFileSync(join(rootB, 'CLAUDE.md'), 'WORKSPACE B\n', 'utf8')
writeFileSync(join(outside, 'SECRET.md'), 'OUTSIDE SECRET\n', 'utf8')

after(() => {
  for (const dir of [home, rootA, rootB, outside]) rmSync(dir, { recursive: true, force: true })
})

function fakeReq(body, overrides = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost' },
    [Symbol.asyncIterator]() {
      if (payload.length === 0) return { next: async () => ({ done: true, value: undefined }) }
      return (function* () { yield Buffer.from(payload) })()
    },
    ...overrides,
  }
}

function fakeRes() {
  let status = 0
  let body = ''
  return {
    writeHead(code) { status = code },
    end(value) { body = value },
    get status() { return status },
    get body() { return body },
  }
}

function makeHarness(cwdBySession) {
  const handlers = new Map()
  const sctx = {
    settings: {
      describe: () => [{ ns: 'prompt-tool', value: {}, base: {}, revision: 3 }],
      get: () => undefined,
      mutate: async () => {},
    },
    webServer: { register: ({ path, handler }) => { handlers.set(path, handler); return () => {} } },
    get: (name) => name === 'agents'
      ? { get: (id) => (cwdBySession[id] === undefined ? undefined : { session: { header: { cwd: cwdBySession[id] } } }) }
      : undefined,
    effect: (fn) => fn(),
  }
  const ctx = { inject: (_deps, cb) => cb(sctx) }
  registerSettingsBridge(
    ctx,
    'prompt-tool',
    () => ({ available: true, providers: [] }),
    // 注册层屏蔽模型的技能状态：技能实体留在官方技能根，插件只提供屏蔽表、引用目录与清单。
    () => ({
      skillsRoot: join(home, 'skills'),
      blocked: [],
      folders: [],
      listSkills: () => [],
      setSkillBlocked: () => ({ ok: true, state: { version: 3, blocked: [], folders: [] }, exists: true }),
      patchSkillFolders: () => ({ ok: true, state: { version: 3, blocked: [], folders: [] }, exists: true }),
      invalidateCatalog: () => {},
    }),
    () => '',
  )
  const call = async (endpoint, body, overrides) => {
    const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + endpoint)
    assert.ok(handler, `${endpoint} 未注册`)
    const res = fakeRes()
    await handler(fakeReq(body, overrides), res)
    return { status: res.status, body: JSON.parse(res.body) }
  }
  return { call }
}

test('指令文件端点与非预设写端点同防护：非 loopback 403、非 POST 405（T13）', async () => {
  const { call } = makeHarness({ 'session-a': rootA })
  for (const endpoint of [BRIDGE_ENDPOINTS.agentsFile, BRIDGE_ENDPOINTS.instructionsPolicy]) {
    const remote = await call(endpoint, { fileId: 'x' }, { socket: { remoteAddress: '10.0.0.9' } })
    assert.equal(remote.status, 403, `${endpoint} 拒绝非 loopback`)
    const method = await call(endpoint, undefined, { method: 'GET' })
    assert.equal(method.status, 405, `${endpoint} 拒绝非 POST`)
  }
})

test('目录候选与越界符号链接都不进入白名单，也不能被写（T13）', async () => {
  const dirWorkspace = mkdtempSync(join(tmpdir(), 'pt-guard-dir-'))
  mkdirSync(join(dirWorkspace, '.git'), { recursive: true })
  // 名为 AGENTS.md 的目录：不是普通文件，必须跳过。
  mkdirSync(join(dirWorkspace, 'AGENTS.md'), { recursive: true })
  // 指向工作区外的符号链接：解析后越出获准范围，必须跳过（不得把写入带出工作区）。
  let linked = false
  try {
    symlinkSync(join(outside, 'SECRET.md'), join(dirWorkspace, 'CLAUDE.md'), 'file')
    linked = true
  } catch {
    linked = false
  }
  try {
    const { call } = makeHarness({ 'session-dir': dirWorkspace })
    const boot = await call(BRIDGE_ENDPOINTS.bootstrap, { sessionId: 'session-dir' })
    assert.equal(boot.status, 200)
    const files = boot.body.instructions.files
    assert.deepEqual(files.map((file) => file.scope), ['global'], '两个候选都不是可写普通文件')
    const projectCards = boot.body.promptConfigs.promptConfigs
      .filter((card) => card.sourceKind === 'instruction-file' && card.params?.scope === 'project')
    assert.deepEqual(projectCards, [], '目录与越界链接都不生成文件卡')

    const write = await call(BRIDGE_ENDPOINTS.agentsFile, {
      sessionId: 'session-dir',
      contextId: boot.body.instructions.context.contextId,
      fileId: 'ffffffffffffffff',
      expectedRevision: null,
      content: 'PWNED\n',
    })
    assert.equal(write.status, 400, '未知 fileId 一律拒绝')
    assert.equal(readFileSync(join(outside, 'SECRET.md'), 'utf8'), 'OUTSIDE SECRET\n', '工作区外文件字节不变')
    if (linked) {
      const linkText = readFileSync(join(dirWorkspace, 'CLAUDE.md'), 'utf8')
      assert.equal(linkText, 'OUTSIDE SECRET\n', '越界链接目标未被写过')
    }
  } finally {
    rmSync(dirWorkspace, { recursive: true, force: true })
  }
})

test('两个本地会话各自解析工作区：文件集与 contextId 不串，旧上下文写请求 409（T11/T12）', async () => {
  const { call } = makeHarness({ 'session-a': rootA, 'session-b': rootB })
  const a = await call(BRIDGE_ENDPOINTS.bootstrap, { sessionId: 'session-a' })
  const b = await call(BRIDGE_ENDPOINTS.bootstrap, { sessionId: 'session-b' })
  assert.equal(a.body.instructions.context.cwd, rootA)
  assert.equal(b.body.instructions.context.cwd, rootB)
  assert.notEqual(a.body.instructions.context.contextId, b.body.instructions.context.contextId)
  assert.deepEqual(
    a.body.instructions.files.map((file) => file.text),
    ['GLOBAL RULES\n', 'WORKSPACE A\n'],
    'A 会话只看到全局文件与自己的工作区文件',
  )
  assert.deepEqual(
    b.body.instructions.files.map((file) => file.text),
    ['GLOBAL RULES\n', 'WORKSPACE B\n'],
    'B 会话只看到全局文件与自己工作区的文件',
  )

  const aFile = a.body.instructions.files.find((file) => file.scope === 'project')
  // 用 A 的 contextId 但声称是 B 会话：工作区事实由服务端解析，必须拒绝。
  const crossWrite = await call(BRIDGE_ENDPOINTS.agentsFile, {
    sessionId: 'session-b',
    contextId: a.body.instructions.context.contextId,
    fileId: aFile.fileId,
    expectedRevision: aFile.revision,
    content: 'CROSS WRITE\n',
  })
  assert.equal(crossWrite.status, 409)
  assert.equal(crossWrite.body.code, 'agents-file-context-stale')
  assert.equal(readFileSync(join(rootB, 'CLAUDE.md'), 'utf8'), 'WORKSPACE B\n', 'B 的文件未被改动')
  assert.equal(readFileSync(join(rootA, 'AGENTS.md'), 'utf8'), 'WORKSPACE A\n', 'A 的文件未被改动')

  // 未存活的会话不借用别的会话工作区。
  const cold = await call(BRIDGE_ENDPOINTS.bootstrap, { sessionId: 'session-gone' })
  assert.equal(cold.body.instructions.context.source, 'global-only')
  assert.deepEqual(cold.body.instructions.files.map((file) => file.scope), ['global'])
})
