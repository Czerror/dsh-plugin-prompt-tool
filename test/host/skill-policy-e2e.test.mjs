/** 技能调用策略的端到端回归：**写完文件，重新 list() 得到的候选必须随之变化**。
 *
 *  为什么必须用真实 `SkillRegistry`：整套机制成立与否取决于注册表怎么合并候选、怎么把
 *  `invocation` 一路透传到摘要。自造一份合并逻辑等于自证，测不出「停用是否真的生效」。
 *
 *  使用锁定的已发布 filesystem provider；它独立解析磁盘，不复用插件解析器做替身。
 *
 *  同时断言候选**直接来自文件内容**：同一次发现里同名技能只出现一次，不存在第二个候选去覆盖它，
 *  这正是影子候选方案失败的地方（注册层「最近层胜出」会无视 rank 覆盖影子候选）。 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry, isModelInvocable, isUserInvocable } from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { parseFrontmatter } from '../../src/runtime/skills-parse.ts'
import { readSkillInvocation, setSkillInvocation } from '../../src/host/skills-policy.ts'
import { SKILL_MARKER } from '../../src/shared/skills.ts'

const sandbox = mkdtempSync(join(tmpdir(), 'pt-skill-policy-e2e-'))
after(() => { rmSync(sandbox, { recursive: true, force: true }) })

const MODEL_KEY = 'disable-model-invocation'
const USER_KEY = 'user-invocable'

mkdirSync(sandbox, { recursive: true })
// 项目根要能被官方提供方按 cwd 解析到。
mkdirSync(join(sandbox, '.git'), { recursive: true })
const skillsRoot = join(sandbox, '.dsh', 'skills')
const skillDir = join(skillsRoot, 'demo-skill')
const marker = join(skillDir, SKILL_MARKER)
mkdirSync(skillDir, { recursive: true })
// 正文里刻意放一个 `---`，锁住「frontmatter 边界只认头部那一处」。
writeFileSync(marker, [
  '---',
  '# 官方文件提供方的技能：保留我',
  'name: demo-skill',
  'description: 端到端演示技能',
  'unknown-field: 保留我',
  '---',
  '',
  '# demo-skill 正文',
  '',
  '正文段落。',
  '--- 正文里的三个横线不是 frontmatter 边界',
  '',
].join('\n'), 'utf8')

function createFilesystemProvider(control) {
  const provider = new FileSystemSkillProvider({ get() {}, logger: { warn() {} } }, control, {
    providerName: 'dsh-skill-filesystem', includeDefaultRoots: false, customSkillDirs: [skillsRoot],
    dshHome: sandbox, agentsHome: sandbox, watch: false,
  })
  after(() => provider.dispose())
  return provider
}

/** 真实注册表与官方 provider 使用相同查找上下文。 */
function listSkills(registry) {
  return registry.list({ cwd: sandbox })
}

const winnerOf = async (registry, name) => {
  const skills = await listSkills(registry)
  const matches = skills.filter((skill) => skill.name === name)
  assert.equal(matches.length, 1, `同名技能必须只有一个候选（真实注册表按层内 rank 合并）：${matches.map((s) => s.provider).join(',')}`)
  return matches[0]
}

test('真实 filesystem provider：旧策略键写入后可被官方发现并正确限制调用', async () => {
  const root = join(sandbox, 'official-provider')
  const file = join(root, 'legacy', SKILL_MARKER)
  mkdirSync(join(root, 'legacy'), { recursive: true })
  writeFileSync(file, '---\nname: legacy\ndescription: legacy\ndisableModelInvocation: false\nuserInvocable: true\nmodelInvocable: true\n---\nlegacy body\n')
  const warnings = []
  const provider = new FileSystemSkillProvider({ get() {}, logger: { warn: (message) => warnings.push(message) } }, {
    signal: new AbortController().signal, invalidate() {},
  }, { includeDefaultRoots: false, customSkillDirs: [root], watch: false, dshHome: sandbox, agentsHome: sandbox })
  try {
    assert.deepEqual(await provider.list({ cwd: sandbox }), [], '官方 provider 先拒绝旧策略键')
    assert.ok(warnings.some((message) => message.includes('unsupported')))
    assert.equal(setSkillInvocation(file, 'model').ok, true)
    const candidates = await provider.list({ cwd: sandbox })
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0].name, 'legacy')
    assert.deepEqual(candidates[0].invocation, { modelInvocable: false, userInvocable: true })
    const loaded = await provider.get(candidates[0], {})
    assert.equal(loaded.content, 'legacy body', '官方 provider 会 trim 正文')
    assert.ok(readFileSync(file, 'utf8').endsWith('legacy body\n'), '磁盘正文换行保持原样')
  } finally { await provider.dispose() }
})

test('setSkillInvocation 之后重新 list()：模型端不可调用、用户端仍可调用', async () => {
  const registry = new SkillRegistry(new Context())
  let control
  registry.registerProvider((providerControl) => { control = providerControl; return createFilesystemProvider(providerControl) })

  // 初始：文件没有声明任何调用策略键。
  const initial = await winnerOf(registry, 'demo-skill')
  assert.equal(initial.provider, 'dsh-skill-filesystem')
  assert.equal(initial.path, marker, '候选直接绑定技能文件路径')
  assert.deepEqual([isModelInvocable(initial), isUserInvocable(initial)], [true, true], '缺省两端都可调用')
  const declared = readSkillInvocation(marker)
  assert.equal(declared.ok, true, declared.message)
  assert.deepEqual(declared.invocation, { modelInvocable: true, userInvocable: true })

  // 写盘：只关模型端。
  const written = setSkillInvocation(marker, 'model')
  assert.equal(written.ok, true, written.message)
  assert.equal(written.changed, true)
  const text = readFileSync(marker, 'utf8')
  assert.match(text, new RegExp(`^${MODEL_KEY}: true$`, 'm'), '官方连字符键必须落到文件里')
  assert.match(text, new RegExp(`^${USER_KEY}: true$`, 'm'), '用户端补成显式 true')
  assert.match(text, /^# 官方文件提供方的技能：保留我$/m, 'frontmatter 注释保留')
  assert.match(text, /^unknown-field: 保留我$/m, '未知字段保留')

  // 注册表缓存未失效时仍是旧快照——这正好说明「必须失效」是真需求，而不是断言在自证。
  const stale = await winnerOf(registry, 'demo-skill')
  assert.equal(stale.invocation.modelInvocable, true, '未失效的缓存仍是旧候选（失效的必要性）')
  control.invalidate()

  // 关键断言：重新 list() 拿到的候选直接反映文件事实。
  const list = await listSkills(registry)
  const after = await winnerOf(registry, 'demo-skill')
  assert.equal(after.invocation.modelInvocable, false, '模型端必须变为不可调用')
  assert.equal(after.invocation.userInvocable, true, '用户端必须保持可调用')
  assert.deepEqual([isModelInvocable(after), isUserInvocable(after)], [false, true])
  assert.equal(after.provider, 'dsh-skill-filesystem', '胜出候选仍是官方文件提供方的那个，没有被插件候选顶掉')
  assert.equal(after.path, marker)
  // 不存在影子/覆盖候选：同一次发现里 demo-skill 只出现一次，且描述未被任何替身文案顶掉。
  assert.equal(list.filter((skill) => skill.name === 'demo-skill').length, 1, '不存在同名影子候选')
  assert.equal(after.description, '端到端演示技能', '候选描述直接来自文件 frontmatter')
  assert.equal(list.some((skill) => skill.name.startsWith('blocked-')), false, '不存在任何屏蔽占位技能')

  // 正文仍可从文件加载（停用不损伤技能本体）。
  const loaded = await registry.get('demo-skill', { cwd: sandbox })
  assert.equal(loaded.content.includes('# demo-skill 正文'), true)
  assert.equal(loaded.content.includes('正文里的三个横线不是 frontmatter 边界'), true, '正文里的 --- 不被当作边界')
  assert.equal(loaded.content.startsWith('# 官方文件提供方的技能'), false, 'frontmatter 不下发到正文')
  assert.deepEqual(control === undefined, false, 'provider 控制面必须可拿到（供缓存失效）')

  // 只关用户端：模型端重新可用、用户端关闭（两端互不牵连）。
  const userOnly = setSkillInvocation(marker, 'user')
  assert.equal(userOnly.ok, true, userOnly.message)
  control.invalidate()
  const second = await winnerOf(registry, 'demo-skill')
  assert.deepEqual([isModelInvocable(second), isUserInvocable(second)], [true, false])
  assert.equal(readSkillInvocation(marker).invocation.userInvocable, false, '落盘事实与候选一致')

  // 两端关闭。
  const all = setSkillInvocation(marker, 'all')
  assert.equal(all.ok, true, all.message)
  control.invalidate()
  const both = await winnerOf(registry, 'demo-skill')
  assert.deepEqual([isModelInvocable(both), isUserInvocable(both)], [false, false])
  assert.equal((await listSkills(registry)).filter((skill) => skill.name === 'demo-skill').length, 1, '两端关闭也不产生第二个候选')

  // 恢复：写 'none' 后两端都回到可调用，且文件里是显式 true。
  const restored = setSkillInvocation(marker, 'none')
  assert.equal(restored.ok, true, restored.message)
  assert.equal(restored.changed, true)
  control.invalidate()
  const back = await winnerOf(registry, 'demo-skill')
  assert.deepEqual([isModelInvocable(back), isUserInvocable(back)], [true, true], '两端必须恢复可调用')
  const restoredText = readFileSync(marker, 'utf8')
  assert.match(restoredText, new RegExp(`^${MODEL_KEY}: false$`, 'm'), '恢复两端可调用必须写显式 false')
  assert.match(restoredText, new RegExp(`^${USER_KEY}: true$`, 'm'), '恢复两端可调用必须写显式 true')
  // 恢复后正文与未知字段仍逐字保留（整轮四次写入不损伤技能本体）。
  assert.match(restoredText, /^unknown-field: 保留我$/m)
  assert.match(restoredText, /^# 官方文件提供方的技能：保留我$/m)
  assert.ok(restoredText.endsWith('正文段落。\n--- 正文里的三个横线不是 frontmatter 边界\n'))
  // 整轮下来目录里只剩 SKILL.md：没有任何影子文件或状态文件。
  assert.deepEqual(readdirSync(skillDir), [SKILL_MARKER])
  assert.deepEqual(readdirSync(skillsRoot), ['demo-skill'])
})

test('候选直接来自文件内容：手工改文件与插件写文件走同一条读取路径', async () => {
  // 先把文件复位成「只关模型端」，不依赖上一个用例留下的状态。
  writeFileSync(marker, [
    '---',
    'name: demo-skill',
    'description: 端到端演示技能',
    `${MODEL_KEY}: true`,
    '---',
    '',
    '# demo-skill 正文',
    '',
  ].join('\n'), 'utf8')

  const registry = new SkillRegistry(new Context())
  let control
  registry.registerProvider((providerControl) => { control = providerControl; return createFilesystemProvider(providerControl) })
  const first = await winnerOf(registry, 'demo-skill')
  assert.equal(first.invocation.modelInvocable, false, '文件声明关模型端')

  // 绕过插件直接手改文件（模拟用户手工编辑 frontmatter）：失效后必须看到手工值。
  writeFileSync(marker, readFileSync(marker, 'utf8').replace(`${MODEL_KEY}: true`, `${MODEL_KEY}: false`), 'utf8')
  control.invalidate()
  const second = await winnerOf(registry, 'demo-skill')
  assert.equal(second.invocation.modelInvocable, true, '手工把键改回 false 后模型端必须重新可调用')

  // 文件与候选一致：候选就是文件事实，而不是某个内存记录的投影。
  const onDisk = readSkillInvocation(marker)
  assert.equal(onDisk.ok, true, onDisk.message)
  assert.equal(onDisk.invocation.modelInvocable, second.invocation.modelInvocable)
  assert.equal(onDisk.invocation.userInvocable, second.invocation.userInvocable)
  assert.equal(marker, resolve(marker), '技能文件路径是绝对路径（写入前置校验的同一不变量）')
})

test('插件解析器与已发布 provider 对照：官方布尔、旧键、非法值和 frontmatter 边界', async () => {
  const root = join(sandbox, 'parity')
  mkdirSync(join(root, 'demo'), { recursive: true })
  const file = join(root, 'demo', SKILL_MARKER)
  const provider = new FileSystemSkillProvider({ get() {}, logger: { warn() {} } }, {
    signal: new AbortController().signal, invalidate() {},
  }, { includeDefaultRoots: false, customSkillDirs: [root], watch: false, dshHome: sandbox, agentsHome: sandbox })
  try {
    const frontmatter = (line) => `---\nname: demo\ndescription: D\n${line}\n---\nbody\n`
    const cases = [
      ...['true', 'false', 'yes', 'no', 'ON', 'off', '1', '0', '"true"', '"false"'].map((value) => frontmatter(`disable-model-invocation: ${value}\nuser-invocable: ${value}`)),
      ...['disable-model-invocation: nope', 'disableModelInvocation: false', 'userInvocable: true', 'modelInvocable: true', 'user-invocable: []'].map(frontmatter),
      '---\nname: demo\ndescription: D\n---trailing\nbody',
      '\ufeff' + frontmatter(''),
    ]
    for (const source of cases) {
      writeFileSync(file, source)
      const ours = parseFrontmatter(source)
      const official = await provider.list({ cwd: sandbox })
      assert.equal(ours.issue === undefined, official.length === 1, source)
      if (official.length === 1) assert.deepEqual({ modelInvocable: ours.data.disableModelInvocation !== true, userInvocable: ours.data.userInvocable !== false }, official[0].invocation, source)
    }
  } finally { await provider.dispose() }
})
