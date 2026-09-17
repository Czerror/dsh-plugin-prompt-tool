import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 文件即真相：探测到的 AGENTS.md 才生成 pre-step 文件卡；bridge 只按「本次工作区
// 重新解析的白名单 + 字节版本」写盘。本文件覆盖 F1（读取失败/空文件区分）、
// F3（dirty 单文件 + 乐观版本校验）与 T01–T03、T06、T13–T14 的 host 侧断言。
const home = mkdtempSync(join(tmpdir(), 'pt-ac-home-'))
process.env.DSH_HOME = home
const {
  MAX_INSTRUCTION_FILE_BYTES,
  agentsFileCardSpecs,
  agentsFileId,
  detectAgentsFileSnapshots,
  detectAgentsFiles,
  mergeInstructionCards,
  readAgentsFileSnapshot,
  registerSettingsBridge,
  writeAgentsFile,
  writeAgentsFileChecked,
} = await import('../../lib/index.mjs')
const { BRIDGE_ENDPOINTS, SETTINGS_BRIDGE_PREFIX } = await import('../../lib/index.mjs')

const repo = mkdtempSync(join(tmpdir(), 'pt-ac-repo-'))
const nested = join(repo, 'packages', 'app')
mkdirSync(join(repo, '.git'), { recursive: true })
mkdirSync(nested, { recursive: true })
writeFileSync(join(home, 'AGENTS.md'), 'GLOBAL RULES\n', 'utf8')
writeFileSync(join(repo, 'AGENTS.md'), 'PROJECT RULES\n', 'utf8')
writeFileSync(join(nested, 'CLAUDE.md'), 'NESTED RULES\n', 'utf8')

after(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

function fakeReq(body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost' },
    [Symbol.asyncIterator]() {
      if (payload.length === 0) return { next: async () => ({ done: true, value: undefined }) }
      return (function* () { yield Buffer.from(payload) })()
    },
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

/** bridge harness：agents 服务提供 sessionId → 会话 cwd 的解析（cwd 来自会话头，不是进程 cwd）。 */
function makeHarness(sessionCwd) {
  const handlers = new Map()
  let rebuilds = 0
  const sctx = {
    settings: {
      describe: () => [{ ns: 'prompt-tool', value: {}, base: {}, revision: 7 }],
      get: () => undefined,
      mutate: async () => {},
    },
    webServer: { register: ({ path, handler }) => { handlers.set(path, handler); return () => {} } },
    get: (name) => name === 'agents'
      ? { get: (id) => (id === 'session-1' ? { session: { header: { cwd: sessionCwd } } } : undefined) }
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
    }),
    () => '',
    undefined,
    () => '',
    () => { rebuilds += 1 },
  )
  const call = async (endpoint, body) => {
    const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + endpoint)
    assert.ok(handler, `${endpoint} 未注册`)
    const res = fakeRes()
    await handler(fakeReq(body), res)
    return { status: res.status, body: JSON.parse(res.body) }
  }
  return { call, rebuilds: () => rebuilds }
}

test('detectAgentsFiles：只返回普通文件（用户级 + 项目根→cwd 链），可只取全局范围', () => {
  const files = detectAgentsFiles({ cwd: nested, home })
  assert.deepEqual(files.map((file) => [file.scope, file.displayPath]), [
    ['global', '~/.dsh/AGENTS.md'],
    ['project', 'AGENTS.md'],
    ['project', 'packages/app/CLAUDE.md'],
  ])
  assert.deepEqual(files.map((file) => file.path), [
    join(home, 'AGENTS.md'),
    join(repo, 'AGENTS.md'),
    join(nested, 'CLAUDE.md'),
  ])
  assert.equal(files[0].fileId, agentsFileId(join(home, 'AGENTS.md')), 'fileId 由规范化真实路径稳定派生')
  assert.match(files[0].fileId, /^[0-9a-f]{16}$/)
  // projects:false = 项目范围不可用：只用可确认的全局文件，不拿部署 cwd 冒充工作区。
  const globalOnly = detectAgentsFiles({ cwd: nested, home, projects: false })
  assert.deepEqual(globalOnly.map((file) => file.scope), ['global'])
  assert.equal(detectAgentsFiles({ cwd: repo, home: join(home, 'empty'), projects: false }).length, 0)
})

test('detectAgentsFiles：同一实际文件（符号链接）不重复成两卡', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-ac-link-'))
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), 'LINKED RULES\n', 'utf8')
  try {
    symlinkSync(join(dir, 'CLAUDE.md'), join(dir, 'AGENTS.md'), 'file')
  } catch {
    t.diagnostic('当前环境无符号链接权限，跳过该断言')
    rmSync(dir, { recursive: true, force: true })
    return
  }
  const files = detectAgentsFiles({ cwd: dir, home })
  assert.equal(files.filter((file) => file.scope === 'project').length, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('readAgentsFileSnapshot：ready 区分空文件、保留 BOM；失败状态不是空正文', () => {
  const dir = mkdtempSync(join(repo, 'snap-'))
  const target = join(dir, 'AGENTS.md')
  writeFileSync(target, '', 'utf8')
  const card = detectAgentsFiles({ cwd: dir, home }).find((file) => file.path === target)
  const emptySnapshot = readAgentsFileSnapshot(card)
  assert.equal(emptySnapshot.status, 'ready', '可读空文件仍是 ready')
  assert.equal(emptySnapshot.text, '')
  assert.equal(emptySnapshot.revision, sha256(Buffer.from('', 'utf8')))

  writeFileSync(target, '\uFEFFBOM RULES\n', 'utf8')
  const bomSnapshot = readAgentsFileSnapshot(card)
  assert.equal(bomSnapshot.status, 'ready')
  assert.equal(bomSnapshot.text.charCodeAt(0), 0xfeff, 'BOM 作为正文字符保留，未编辑不改字节')
  assert.equal(bomSnapshot.revision, sha256(Buffer.from('\uFEFFBOM RULES\n', 'utf8')))

  writeFileSync(target, Buffer.from([0xff, 0xfe, 0x41]))
  assert.equal(readAgentsFileSnapshot(card).status, 'unreadable', '非法 UTF-8 不冒充空正文')

  writeFileSync(target, 'x'.repeat(MAX_INSTRUCTION_FILE_BYTES + 1), 'utf8')
  assert.equal(readAgentsFileSnapshot(card).status, 'too-large')

  rmSync(target, { force: true })
  assert.equal(readAgentsFileSnapshot(card).status, 'missing', '消失的文件不是空文件')
  assert.equal(
    detectAgentsFileSnapshots({ cwd: dir, home }).some((file) => file.path === target),
    false,
    '消失的文件不再出现在探测结果里',
  )
  assert.equal(detectAgentsFileSnapshots({ cwd: dir, home, projects: false }).length, 1, '全局文件仍在')
  rmSync(dir, { recursive: true, force: true })
})

test('writeAgentsFileChecked：版本一致才写、冲突/缺失/超限都不改原文件', async () => {
  const dir = mkdtempSync(join(repo, 'write-'))
  const target = join(dir, 'AGENTS.md')
  writeFileSync(target, 'V1\n', 'utf8')
  const card = detectAgentsFiles({ cwd: dir, home }).find((file) => file.path === target)
  const v1 = readAgentsFileSnapshot(card)

  const conflict = await writeAgentsFileChecked({ file: card, content: 'OLD DRAFT\n', expectedRevision: 'deadbeef' })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.status, 409)
  assert.equal(readFileSync(target, 'utf8'), 'V1\n', '版本不符不动外部新版本')

  const written = await writeAgentsFileChecked({ file: card, content: 'V2\n', expectedRevision: v1.revision })
  assert.equal(written.ok, true)
  assert.equal(written.revision, sha256(Buffer.from('V2\n', 'utf8')))
  assert.equal(readFileSync(target, 'utf8'), 'V2\n')
  assert.deepEqual(readdirSync(dir), ['AGENTS.md'], '不留临时文件')

  const tooLarge = await writeAgentsFileChecked({
    file: card,
    content: 'y'.repeat(MAX_INSTRUCTION_FILE_BYTES + 1),
    expectedRevision: written.revision,
  })
  assert.equal(tooLarge.ok, false)
  assert.equal(tooLarge.status, 413)
  assert.equal(readFileSync(target, 'utf8'), 'V2\n', '超限不截断保存')

  const v2 = readAgentsFileSnapshot(card)
  unlinkSync(target)
  const missing = await writeAgentsFileChecked({ file: card, content: 'REVIVE\n', expectedRevision: v2.revision })
  assert.equal(missing.ok, false)
  assert.equal(missing.status, 404)
  assert.equal(detectAgentsFiles({ cwd: dir, home }).some((file) => file.path === target), false, '不自动重建消失的文件')
  rmSync(dir, { recursive: true, force: true })
})

test('bridge 读取：/bootstrap 与 /prompt-configs 对同一文件返回一致正文、身份与版本（T01）', async () => {
  const { call } = makeHarness(nested)
  const boot = await call(BRIDGE_ENDPOINTS.bootstrap, { sessionId: 'session-1' })
  assert.equal(boot.status, 200)
  assert.equal(boot.body.instructions.context.source, 'session')
  assert.equal(boot.body.instructions.context.cwd, nested)
  assert.equal(typeof boot.body.instructions.context.contextId, 'string')
  const bootFiles = boot.body.instructions.files
  assert.deepEqual(bootFiles.map((file) => file.scope), ['global', 'project', 'project'])
  assert.equal(bootFiles[1].text, 'PROJECT RULES\n')
  assert.equal(bootFiles[1].status, 'ready')
  assert.equal(bootFiles[1].revision, sha256(Buffer.from('PROJECT RULES\n', 'utf8')))
  // 文件卡正文来自同一快照，不再「只有 /prompt-configs 才补正文」。
  const projectCard = boot.body.promptConfigs.promptConfigs.find((card) => card.params?.displayPath === 'AGENTS.md')
  assert.equal(projectCard.params.text, 'PROJECT RULES\n')
  assert.equal(projectCard.params.readStatus, 'ready')
  assert.equal(projectCard.params.revision, bootFiles[1].revision)

  const single = await call(BRIDGE_ENDPOINTS.promptConfigs, { sessionId: 'session-1' })
  assert.equal(single.status, 200)
  const singleFiles = single.body.value.instructions.files
  assert.deepEqual(
    singleFiles.map((file) => [file.fileId, file.status, file.text, file.revision]),
    bootFiles.map((file) => [file.fileId, file.status, file.text, file.revision]),
  )
  assert.equal(single.body.value.instructions.context.contextId, boot.body.instructions.context.contextId)
})

test('bridge 读取：无本地会话时只返回全局文件（不拿进程 cwd 兜底，T11/T12）', async () => {
  const { call } = makeHarness(nested)
  const global = await call(BRIDGE_ENDPOINTS.bootstrap, undefined)
  assert.equal(global.status, 200)
  assert.equal(global.body.instructions.context.source, 'global-only')
  assert.equal(global.body.instructions.context.cwd, null)
  assert.deepEqual(global.body.instructions.files.map((file) => file.scope), ['global'])
  const unknown = await call(BRIDGE_ENDPOINTS.bootstrap, { sessionId: 'session-9' })
  assert.deepEqual(unknown.body.instructions.files.map((file) => file.scope), ['global'])
  const badType = await call(BRIDGE_ENDPOINTS.bootstrap, { sessionId: 42 })
  assert.equal(badType.status, 400, '非法 sessionId 不静默按无会话处理')
})

test('bridge /agents-file：单文件写按 contextId + expectedRevision 校验，且不触发重建（T05/T06/T14）', async () => {
  const dir = mkdtempSync(join(repo, 'bridge-write-'))
  const target = join(dir, 'AGENTS.md')
  writeFileSync(target, 'BRIDGE V1\n', 'utf8')
  const harness = makeHarness(dir)
  const boot = await harness.call(BRIDGE_ENDPOINTS.bootstrap, { sessionId: 'session-1' })
  const contextId = boot.body.instructions.context.contextId
  const file = boot.body.instructions.files.find((entry) => entry.path === target)
  assert.equal(file.text, 'BRIDGE V1\n')

  const ok = await harness.call(BRIDGE_ENDPOINTS.agentsFile, {
    sessionId: 'session-1',
    contextId,
    fileId: file.fileId,
    expectedRevision: file.revision,
    content: 'BRIDGE V2\n',
  })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.value.fileId, file.fileId)
  assert.equal(ok.body.value.revision, sha256(Buffer.from('BRIDGE V2\n', 'utf8')))
  assert.equal(readFileSync(target, 'utf8'), 'BRIDGE V2\n')
  assert.deepEqual(readdirSync(dir), ['AGENTS.md'], '临时文件已清理')
  assert.equal(harness.rebuilds(), 0, '正文写入不触发预设重建')

  // 外部编辑 → 旧草稿 409，外部版本字节不变
  writeFileSync(target, 'EXTERNAL V3\n', 'utf8')
  const conflict = await harness.call(BRIDGE_ENDPOINTS.agentsFile, {
    sessionId: 'session-1',
    contextId,
    fileId: file.fileId,
    expectedRevision: ok.body.value.revision,
    content: 'STALE DRAFT\n',
  })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.code, 'agents-file-conflict')
  assert.equal(readFileSync(target, 'utf8'), 'EXTERNAL V3\n')

  const stale = await harness.call(BRIDGE_ENDPOINTS.agentsFile, {
    sessionId: 'session-1',
    contextId: 'ffffffffffffffff',
    fileId: file.fileId,
    expectedRevision: null,
    content: 'WRONG CONTEXT\n',
  })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'agents-file-context-stale')

  const unknown = await harness.call(BRIDGE_ENDPOINTS.agentsFile, {
    sessionId: 'session-1',
    contextId,
    fileId: 'ffffffffffffffff',
    expectedRevision: null,
    content: 'X\n',
  })
  assert.equal(unknown.status, 400)

  const badShape = await harness.call(BRIDGE_ENDPOINTS.agentsFile, {
    sessionId: 'session-1',
    contextId,
    fileId: file.fileId,
    content: 'X\n',
  })
  assert.equal(badShape.status, 400, '缺 expectedRevision 的形状被拒')

  const tooLarge = await harness.call(BRIDGE_ENDPOINTS.agentsFile, {
    sessionId: 'session-1',
    contextId,
    fileId: file.fileId,
    expectedRevision: null,
    content: 'z'.repeat(MAX_INSTRUCTION_FILE_BYTES + 1),
  })
  assert.equal(tooLarge.status, 413)
  assert.equal(readFileSync(target, 'utf8'), 'EXTERNAL V3\n')

  // 全局文件在无会话（global-only）时仍可写：contextId 由服务端本次解析。
  const globalOnly = await harness.call(BRIDGE_ENDPOINTS.bootstrap, undefined)
  const globalFile = globalOnly.body.instructions.files[0]
  const globalWrite = await harness.call(BRIDGE_ENDPOINTS.agentsFile, {
    contextId: globalOnly.body.instructions.context.contextId,
    fileId: globalFile.fileId,
    expectedRevision: globalFile.revision,
    content: 'GLOBAL V2\n',
  })
  assert.equal(globalWrite.status, 200)
  assert.equal(readFileSync(join(home, 'AGENTS.md'), 'utf8'), 'GLOBAL V2\n')
  writeFileSync(join(home, 'AGENTS.md'), 'GLOBAL RULES\n', 'utf8')
  rmSync(dir, { recursive: true, force: true })
})

test('mergeInstructionCards：其他工作区的文件卡不再展示，本工作区文件按默认卡补齐', () => {
  const foreignCard = {
    id: 'agents-file-ffffffffffffffff',
    layer: 'pre-step',
    params: { file: join(repo, 'elsewhere', 'AGENTS.md'), fileId: 'ffffffffffffffff', text: 'FOREIGN' },
  }
  const presetCard = { id: 'router-guide', layer: 'per-request', text: 'KEEP' }
  const files = detectAgentsFileSnapshots({ cwd: nested, home })
  const merged = mergeInstructionCards([presetCard, foreignCard], files)
  assert.equal(merged.length, 1 + files.length, '外来工作区文件卡被丢弃，本工作区文件补默认卡')
  assert.equal(merged[0].id, 'router-guide')
  for (const card of merged.slice(1)) {
    assert.equal(card.params.readStatus, 'ready')
    assert.equal(card.params.text.length > 0, true)
    assert.equal(card.fill, 'instruction-hint')
    assert.equal(card.position, 'after-user')
  }
  // 生成卡上的策略字段保留：fileId 命中时只替换正文/版本/状态。
  const spec = agentsFileCardSpecs(files)[1]
  const kept = mergeInstructionCards([{ ...spec, order: 99, enabled: false }], [files[1]])
  assert.equal(kept[0].order, 99)
  assert.equal(kept[0].enabled, false)
  assert.equal(kept[0].params.text, files[1].text)
})

test('writeAgentsFile：原子写回探测到的文件，编辑框内容即文件内容', () => {
  const target = join(repo, 'AGENTS.md')
  writeAgentsFile(target, 'EDITED RULES\n')
  assert.equal(readFileSync(target, 'utf8'), 'EDITED RULES\n')
  writeFileSync(target, 'PROJECT RULES\n', 'utf8')
})

test('writeAgentsFile：不可写目录不留半截文件', () => {
  if (process.platform === 'win32') return
  const dir = mkdtempSync(join(repo, 'ro-'))
  const target = join(dir, 'AGENTS.md')
  writeFileSync(target, 'ORIGINAL\n', 'utf8')
  chmodSync(dir, 0o500)
  try {
    assert.throws(() => writeAgentsFile(target, 'NEW\n'))
  } finally {
    chmodSync(dir, 0o700)
  }
  assert.equal(readFileSync(target, 'utf8'), 'ORIGINAL\n')
  assert.deepEqual(readdirSync(dir), ['AGENTS.md'])
  rmSync(dir, { recursive: true, force: true })
})
