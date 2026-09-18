// 技能清单扫描与来源分组（文件层调用策略模型）。
// 技能实体留在官方各自技能根里；调用策略的唯一真相是各技能文件自己的 frontmatter：
//  - catalogFromScan 只接收扫描结果一个参数（没有屏蔽表）；
//  - 清单条目携带 modelInvocable / userInvocable 与写入目标 path，没有 blocked* 字段；
//  - 「停用」是改技能文件，不改任何插件状态，也不产生第二个候选。
// 本文件覆盖：六类官方技能根的优先级与顺序、一层发现规则、按会话 cwd 解析项目来源、同名遮蔽与调用策略投影。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'pt-skills-catalog-'))
const dshHome = join(sandbox, 'home')
const agentsHome = join(sandbox, 'agents')
const bundledDir = join(sandbox, 'bundled')
const project = join(sandbox, 'project')
const cwd = join(project, 'packages', 'app')
const referenced = join(sandbox, 'referenced')
const skillsRoot = join(dshHome, 'skills')
const previous = {
  DSH_HOME: process.env.DSH_HOME,
  DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME,
  DSH_BUNDLED_SKILL_DIR: process.env.DSH_BUNDLED_SKILL_DIR,
}
process.env.DSH_HOME = dshHome
process.env.DSH_AGENTS_HOME = agentsHome
process.env.DSH_BUNDLED_SKILL_DIR = bundledDir

const { catalogFromScan, resolveProjectRoot, scanRoot, scanRoots, skillRoots } = await import('../../src/host/skills-scan.ts')
const { SKILLS_STATE_VERSION, SKILL_SOURCES } = await import('../../src/shared/skills.ts')
const { groupBySource } = await import('../../src/client/features/skills/skill-status.ts')
const { BRIDGE_ENDPOINTS, SETTINGS_BRIDGE_PREFIX } = await import('../../src/shared/bridge-contract.ts')
const { registerSettingsBridge } = await import('../../src/runtime/settings-bridge.ts')

after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(sandbox, { recursive: true, force: true })
})

/** 写一个标准技能：`<根>/<目录名>/SKILL.md`（一层发现，与官方规则一致）。 */
function writeSkill(root, folder, frontmatter) {
  mkdirSync(join(root, folder), { recursive: true })
  const body = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`).join('\n')
  writeFileSync(join(root, folder, 'SKILL.md'), `---\n${body}\n---\nbody\n`, 'utf8')
}

mkdirSync(join(project, '.git'), { recursive: true })
mkdirSync(cwd, { recursive: true })
writeSkill(join(project, '.dsh', 'skills'), 'project-skill', { name: 'project-skill', description: '项目技能' })
writeSkill(join(project, '.dsh', 'skills'), 'shared', { name: 'shared-name', description: '项目同名技能' })
// 项目 agents 技能：文件里声明「模型端不可调用」，清单必须直接投影这个事实。
writeSkill(join(project, '.agents', 'skills'), 'agents-skill',
  { name: 'agents-skill', description: '项目 agents 技能', 'disable-model-invocation': true, 'user-invocable': false })
writeSkill(referenced, 'ref-skill', { name: 'ref-skill', description: '引用目录技能' })
writeSkill(skillsRoot, 'user-skill', { name: 'user-skill', description: '用户技能' })
writeSkill(skillsRoot, 'shared', { name: 'shared-name', description: '用户同名技能' })
writeSkill(join(agentsHome, 'skills'), 'user-agents-skill', { name: 'user-agents-skill', description: '用户 agents 技能' })
writeSkill(bundledDir, 'bundled-skill', { name: 'bundled-skill', description: '内置技能' })
// 坏技能：frontmatter 缺 name，只能展示原因，不能注册。
mkdirSync(join(skillsRoot, 'broken-skill'), { recursive: true })
writeFileSync(join(skillsRoot, 'broken-skill', 'SKILL.md'), '---\ndescription: 缺 name\n---\nbody\n', 'utf8')
// 插件状态文件的点目录由官方一层扫描天然跳过，不得出现在清单里。
mkdirSync(join(skillsRoot, '.system', 'prompt-tool'), { recursive: true })

const FOLDERS = [referenced]
const roots = skillRoots({ cwd, dshHome, folders: FOLDERS })
const catalog = catalogFromScan(scanRoots(roots))

const listSkills = (sessionCwd) => catalogFromScan(scanRoots(skillRoots({ cwd: sessionCwd, dshHome, folders: FOLDERS })))

// 分工：逐条扫描规则（一层发现、有效性、调用声明、根指纹）由 test/host/skills-scan.test.mjs 覆盖，
// 这里验证六类技能根同时存在时的整体投影与清单事实——两者互补，不是重复。

test('skillRoots：六类技能根按官方优先级排列，无 cwd 时不解析项目来源', () => {
  assert.deepEqual(roots.map((root) => [root.kind, root.path]), [
    ['project-dsh', join(project, '.dsh', 'skills')],
    ['project-agents', join(project, '.agents', 'skills')],
    ['custom', referenced],
    ['user-dsh', skillsRoot],
    ['user-agents', join(agentsHome, 'skills')],
    ['bundled', bundledDir],
  ])
  assert.deepEqual(roots.map((root) => SKILL_SOURCES[root.kind].rank), [100, 200, 300, 400, 500, 600])
  assert.deepEqual(skillRoots({ dshHome, folders: [] }).map((root) => root.kind), ['user-dsh', 'user-agents', 'bundled'])
  // 项目根 = 从工作目录向上第一个含 .git 的目录；找不到时用工作目录本身。
  assert.equal(resolveProjectRoot(cwd), project)
  assert.equal(resolveProjectRoot(sandbox), sandbox)
})

test('catalogFromScan：一层发现、来源优先级、调用策略投影与同名遮蔽', () => {
  const byName = (name, source) => catalog.find((entry) => entry.name === name && (source === undefined || entry.source === source))
  const projectEntry = byName('project-skill')
  assert.equal(projectEntry.source, 'project-dsh')
  assert.equal(projectEntry.rank, 100)
  assert.equal(projectEntry.valid, true)
  // 调用策略字段是唯一事实：缺省两端都可调用；写入目标 path 就是技能文件本身。
  assert.equal(projectEntry.modelInvocable, true)
  assert.equal(projectEntry.userInvocable, true)
  assert.equal(projectEntry.path, join(project, '.dsh', 'skills', 'project-skill', 'SKILL.md'))
  assert.equal(projectEntry.winnerId, undefined)
  // 屏蔽相关的旧字段彻底消失（它们在注册层模型里存在过）。
  for (const gone of ['blocked', 'blockedModel', 'blockedUser']) {
    assert.equal(gone in projectEntry, false, `${gone} 不再是清单字段`)
  }
  assert.deepEqual(Object.keys(projectEntry).sort(), [
    'availability', 'canDelete', 'canSetPolicy', 'description', 'dir', 'folder', 'id', 'modelInvocable', 'name', 'path', 'rank', 'source', 'userInvocable', 'valid',
  ])

  // 引用目录按自定义来源注册（只读引用，实体留在原处）。
  assert.equal(byName('ref-skill').source, 'custom')
  assert.equal(byName('ref-skill').rank, 300)
  assert.equal(byName('bundled-skill').rank, 600)

  // 「停用」写在技能文件里：清单如实投影两个端，不改技能文件本身。
  const declaredOff = byName('agents-skill')
  assert.equal(declaredOff.source, 'project-agents')
  assert.equal(declaredOff.modelInvocable, false, 'frontmatter 声明模型端不可调用')
  assert.equal(declaredOff.userInvocable, false, 'frontmatter 声明用户端不可调用')
  assert.equal(declaredOff.path, join(project, '.agents', 'skills', 'agents-skill', 'SKILL.md'))
  const raw = readFileSync(declaredOff.path, 'utf8')
  assert.match(raw, /^disable-model-invocation: true$/m)
  assert.match(raw, /^user-invocable: false$/m)
  assert.match(raw, /^body$/m, '扫描不改技能文件正文')
  // 只声明一端时另一端仍是可调用。
  const userSkill = byName('user-skill')
  assert.equal(userSkill.modelInvocable, true)
  assert.equal(userSkill.userInvocable, true)

  // 扫描没有注册表作用域，不能仅凭来源 rank 标注遮蔽。
  const shared = catalog.filter((entry) => entry.name === 'shared-name')
  assert.equal(shared.length, 2)
  const winner = shared.find((entry) => entry.source === 'project-dsh')
  const shadowed = shared.find((entry) => entry.source === 'user-dsh')
  assert.equal(winner.winnerId, undefined)
  assert.equal(shadowed.winnerId, undefined)

  // 坏技能只展示原因，不参与同名裁决。
  const broken = byName('broken-skill')
  assert.equal(broken.valid, false)
  assert.equal(broken.issue, 'frontmatter 缺少 name')
  assert.equal(broken.name, 'broken-skill')
  assert.equal(broken.winnerId, undefined)
  assert.equal(broken.modelInvocable, true, '无效技能的策略字段仍如实读出（判据是 valid）')

  // 点目录不参与发现。
  assert.equal(catalog.some((entry) => entry.folder === '.system'), false)
  assert.equal(scanRoot({ kind: 'user-dsh', path: skillsRoot }).some((entry) => entry.folder === '.system'), false)
})

test('groupBySource：分组顺序与来源优先级一致，空分组不返回', () => {
  const groups = groupBySource(catalog)
  assert.deepEqual(groups.map((group) => group.source), ['project-dsh', 'project-agents', 'custom', 'user-dsh', 'user-agents', 'bundled'])
  assert.deepEqual(groups.map((group) => group.rank), [100, 200, 300, 400, 500, 600])
  // 分组只回传来源类型与优先级：标题由界面按 `skills.source.<kind>` 取字典。
  // 共享常量里的中文标签不再流到 UI，否则英文界面会显示中文分组名。
  assert.deepEqual(Object.keys(groups[0]).sort(), ['rank', 'skills', 'source'])
  assert.equal(groups.every((group) => !('label' in group)), true, '分组不携带文案')
  assert.deepEqual(groups.find((group) => group.source === 'project-dsh').skills.map((skill) => skill.name), ['project-skill', 'shared-name'])
  assert.equal(groups.every((group) => group.skills.length > 0), true)
  const only = groupBySource(catalog.filter((entry) => entry.source === 'bundled'))
  assert.deepEqual(only.map((group) => group.source), ['bundled'])
})

test('调用策略写入后清单随之变化：catalogFromScan 读的就是文件事实', async () => {
  const { setSkillInvocation } = await import('../../src/host/skills-policy.ts')
  const file = join(referenced, 'ref-skill', 'SKILL.md')
  const before = readFileSync(file, 'utf8')
  try {
    const entry = (sessionCwd) => listSkills(sessionCwd).find((item) => item.name === 'ref-skill')
    assert.deepEqual([entry(cwd).modelInvocable, entry(cwd).userInvocable], [true, true], '起始两端可调用')
    assert.equal(setSkillInvocation(file, 'model').ok, true)
    assert.deepEqual([entry(cwd).modelInvocable, entry(cwd).userInvocable], [false, true], '只改模型端')
    assert.equal(setSkillInvocation(file, 'all').ok, true)
    assert.deepEqual([entry(cwd).modelInvocable, entry(cwd).userInvocable], [false, false], '两端都停用')
    assert.equal(setSkillInvocation(file, 'none').ok, true)
    assert.deepEqual([entry(cwd).modelInvocable, entry(cwd).userInvocable], [true, true], '恢复两端')
    // 同一次发现里同名条目始终只有一个：不存在影子/覆盖候选。
    assert.equal(listSkills(cwd).filter((item) => item.name === 'ref-skill').length, 1)
  } finally {
    writeFileSync(file, before, 'utf8')
  }
})

test('/skills-list 端点：按会话 cwd 解析项目来源，无存活会话时只列用户与内置来源', async () => {
  const handlers = new Map()
  const state = {
    skillsRoot,
    folders: [...FOLDERS],
    listSkills,
    setSkillPolicy: () => ({ ok: true, changed: true, invocation: { modelInvocable: false, userInvocable: false } }),
    patchSkillFolders: () => ({ ok: true, state: { version: SKILLS_STATE_VERSION, folders: FOLDERS }, exists: true }),
  }
  const sctx = {
    settings: { describe: () => [], get: () => undefined, mutate: async () => {} },
    webServer: { register: ({ path, handler }) => { handlers.set(path, handler); return () => {} } },
    get: (name) => name === 'agents'
      ? { get: (id) => (id === 'session-1' ? { session: { header: { cwd } } } : undefined) }
      : undefined,
    effect: (fn) => fn(),
  }
  registerSettingsBridge({ inject: (_deps, callback) => callback(sctx) }, 'prompt-tool',
    () => ({ available: true, providers: [] }), () => state, () => '')
  const call = async (endpoint, body = {}) => {
    const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + endpoint)
    assert.ok(handler, `${endpoint} 未注册`)
    let status
    let response
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

  const scoped = await call(BRIDGE_ENDPOINTS.skillsList, { sessionId: 'session-1' })
  assert.equal(scoped.status, 200, JSON.stringify(scoped.body))
  const value = scoped.body.value
  assert.deepEqual(groupBySource(value.skills).map((group) => group.source),
    ['project-dsh', 'project-agents', 'custom', 'user-dsh', 'user-agents', 'bundled'])
  assert.equal(value.skills.some((skill) => skill.name === 'project-skill'), true)
  assert.deepEqual(value.roots, [skillsRoot])
  assert.deepEqual(value.folders, [referenced])
  assert.equal('blocked' in value, false, '响应里不再有屏蔽表（避免第二个真相）')
  // 按端事实随清单下发：声明停用的技能如实带 modelInvocable/userInvocable。
  const agentsEntry = value.skills.find((skill) => skill.name === 'agents-skill')
  assert.deepEqual([agentsEntry.modelInvocable, agentsEntry.userInvocable], [false, false])
  for (const skill of value.skills) {
    assert.equal(typeof skill.modelInvocable, 'boolean', '每条清单都必须带按端调用策略')
    assert.equal(typeof skill.userInvocable, 'boolean')
  }

  // 无存活会话（未给 sessionId / sessionId 未知）：不拿进程 cwd 兜底，项目来源整组缺席。
  for (const body of [{}, { sessionId: 'gone' }]) {
    const global = await call(BRIDGE_ENDPOINTS.skillsList, body)
    assert.equal(global.status, 200, JSON.stringify(global.body))
    const sources = groupBySource(global.body.value.skills).map((group) => group.source)
    assert.deepEqual(sources, ['custom', 'user-dsh', 'user-agents', 'bundled'])
    assert.equal(global.body.value.skills.some((skill) => skill.name === 'project-skill'), false)
    assert.equal(global.body.value.skills.some((skill) => skill.name === 'ref-skill'), true, '引用目录与会话无关')
  }

  // 非法 sessionId 类型先于扫描拒绝。
  const rejected = await call(BRIDGE_ENDPOINTS.skillsList, { sessionId: 42 })
  assert.equal(rejected.status, 400)
  assert.equal(rejected.body.code, 'skills-list-rejected')
})
