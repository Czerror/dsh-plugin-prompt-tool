import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 文件即真相：探测到的 AGENTS.md 才生成 pre-step 文件卡；bridge 写盘按 fileId 白名单校验。
const home = mkdtempSync(join(tmpdir(), 'pt-ac-home-'))
process.env.DSH_HOME = home
const {
  agentsFileCardSpecs,
  agentsFileId,
  detectAgentsFiles,
  registerSettingsBridge,
  writeAgentsFile,
} = await import('../../lib/index.mjs')
const { BRIDGE_ENDPOINTS, SETTINGS_BRIDGE_PREFIX } = await import('../../lib/index.mjs')

const repo = mkdtempSync(join(tmpdir(), 'pt-ac-repo-'))
const nested = join(repo, 'packages', 'app')
mkdirSync(join(repo, '.git'), { recursive: true })
mkdirSync(nested, { recursive: true })
writeFileSync(join(home, 'AGENTS.md'), 'GLOBAL RULES\n', 'utf8')
writeFileSync(join(repo, 'AGENTS.md'), 'PROJECT RULES\n', 'utf8')
writeFileSync(join(nested, 'CLAUDE.md'), 'NESTED RULES\n', 'utf8')

test.after(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

test('detectAgentsFiles：只返回已存在文件（用户级 + 项目根→cwd 链），并给出显示路径', () => {
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
  assert.equal(files[0].fileId, agentsFileId(join(home, 'AGENTS.md')), 'fileId 由绝对路径稳定派生')
  assert.equal(detectAgentsFiles({ cwd: repo, home: join(home, 'empty') }).length, 1, '未探测到的 home 不生成卡，只留项目根文件')
})

test('agentsFileCardSpecs：一文件一卡，pre-step/after-user，params 只带来源与路径、无正文', () => {
  const specs = agentsFileCardSpecs(detectAgentsFiles({ cwd: nested, home }))
  assert.equal(specs.length, 3)
  for (const spec of specs) {
    assert.equal(spec.layer, 'pre-step')
    assert.equal(spec.position, 'after-user')
    assert.equal(spec.fill, 'instruction-hint')
    assert.equal(spec.params.scope === 'global' || spec.params.scope === 'project', true)
    assert.equal(spec.params.text, undefined, '卡片不承载文件正文')
    assert.equal(typeof spec.params.file, 'string')
    assert.match(spec.id, /^agents-file-[0-9a-f]{8}$/)
  }
  assert.deepEqual(specs.map((spec) => spec.order), [30, 31, 32])
})

test('writeAgentsFile：原子写回探测到的文件，编辑框内容即文件内容', () => {
  const target = join(repo, 'AGENTS.md')
  writeAgentsFile(target, 'EDITED RULES\n')
  assert.equal(readFileSync(target, 'utf8'), 'EDITED RULES\n')
})

test('bridge /agents-file：命中探测白名单才写盘，未知 fileId 与非法载荷一律拒绝', async () => {
  const handlers = new Map()
  const sctx = {
    settings: { describe: () => [], mutate: async () => {} },
    webServer: { register: ({ path, handler }) => { handlers.set(path, handler); return () => {} } },
    get: () => undefined,
    effect: (fn) => fn(),
  }
  const ctx = { inject: (_deps, cb) => cb(sctx) }
  registerSettingsBridge(
    ctx,
    'prompt-tool',
    () => ({ available: true, providers: [] }),
    () => ({ activeSkillsDirs: [], skillCatalog: [] }),
    () => '',
  )
  const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.agentsFile)
  assert.ok(handler, '/agents-file 未注册')
  const call = async (body) => {
    const req = {
      method: 'POST',
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: 'localhost' },
      body: JSON.stringify(body),
    }
    req[Symbol.asyncIterator] = function* () { yield Buffer.from(req.body) }
    let status = 0
    let payload = ''
    await handler(req, { writeHead(code) { status = code }, end(value) { payload = value } })
    return { status, body: JSON.parse(payload) }
  }

  const globalFile = join(home, 'AGENTS.md')
  const ok = await call({ files: [{ fileId: agentsFileId(globalFile), content: 'BRIDGE RULES\n' }] })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.value.files[0].path, globalFile)
  assert.equal(readFileSync(globalFile, 'utf8'), 'BRIDGE RULES\n')

  const unknown = await call({ files: [{ fileId: 'deadbeef', content: 'x' }] })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.ok, false)
  assert.equal(readFileSync(globalFile, 'utf8'), 'BRIDGE RULES\n', '未命中白名单不得改动任何文件')

  const bad = await call({ files: [{ fileId: agentsFileId(globalFile), content: 42 }] })
  assert.equal(bad.status, 400)
  assert.equal(readFileSync(globalFile, 'utf8'), 'BRIDGE RULES\n')
})
