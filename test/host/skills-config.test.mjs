// 技能插件状态文件（v3 注册层屏蔽模型）：只记录 `blocked` 屏蔽表与 `folders` 引用目录。
// 随注册层屏蔽模型移除：旧 v2 受管实体库 schema（dirs / order / rankBase / skills 记录）不再是状态形状，
//  旧版本文件被统一当作「不支持的状态版本」拒绝，且不得被覆盖。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseYaml, stringify as toYaml } from 'yaml'

const home = mkdtempSync(join(tmpdir(), 'pt-skills-config-home-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

const { SKILL_NAME_PATTERN, defaultSkillsState, readSkillsState, skillsStatePath, validateSkillsState, writeSkillsState } =
  await import('../../src/host/skills-config.ts')
const { SKILLS_STATE_VERSION } = await import('../../src/shared/skills.ts')

const AT = '2026-09-17T00:00:00.000Z'
const referenced = resolve(home, 'referenced-skills')

function configFile(name) {
  const dir = join(home, name)
  mkdirSync(dir)
  return join(dir, 'skills.yml')
}

test('状态文件缺失时回退默认 v3 状态，路径固定在用户技能根的点目录', () => {
  const file = skillsStatePath()
  assert.equal(file, join(home, 'skills', '.system', 'prompt-tool', 'skills.yml'))
  assert.equal(existsSync(file), false)
  const read = readSkillsState(file)
  assert.equal(read.ok, true)
  assert.equal(read.exists, false)
  assert.deepEqual(read.state, { version: SKILLS_STATE_VERSION, blocked: [], folders: [] })
  assert.equal(SKILLS_STATE_VERSION, 3)
  assert.deepEqual(defaultSkillsState(), { version: 3, blocked: [], folders: [] })
  // 技能实体留在官方各自技能根里：状态文件不含任何实体库/链接/排序字段。
  assert.deepEqual(Object.keys(defaultSkillsState()).sort(), ['blocked', 'folders', 'version'])
})

test('写入/读回往返：屏蔽记录与引用目录，并保留手写注释与未知字段', () => {
  const file = configFile('roundtrip')
  const written = writeSkillsState({ blocked: [{ name: 'demo-skill', at: AT }], folders: [referenced] }, file)
  assert.equal(written.ok, true, written.message)
  assert.deepEqual(written.state.blocked, [{ name: 'demo-skill', at: AT }])
  assert.deepEqual(written.state.folders, [referenced])
  assert.equal(existsSync(file), true)
  assert.deepEqual(readSkillsState(file).state, written.state)

  // 手工注释与未知字段必须保留（yaml Document API 写回）。
  writeFileSync(file, `${readFileSync(file, 'utf8')}# 手工注释：保留我\nunknown: retained\n`, 'utf8')
  const updated = writeSkillsState({ blocked: [{ name: 'demo-skill', at: AT, note: '暂时停用' }] }, file)
  assert.equal(updated.ok, true, updated.message)
  const text = readFileSync(file, 'utf8')
  assert.match(text, /# 手工注释：保留我/)
  assert.match(text, /unknown: retained/)
  assert.match(text, /note: 暂时停用/)
  const parsed = parseYaml(text)
  assert.deepEqual(parsed.folders, [referenced], '只改屏蔽表时引用目录不受影响')
  assert.equal(parsed.version, 3)
})

test('空屏蔽表与空引用目录删除对应键，文件保持精简', () => {
  const file = configFile('defaults')
  writeSkillsState({ blocked: [{ name: 'alpha', at: AT }], folders: [referenced] }, file)
  writeSkillsState({ blocked: [] }, file)
  let text = readFileSync(file, 'utf8')
  assert.equal(/^blocked:/m.test(text), false)
  assert.match(text, /^folders:/m)
  writeSkillsState({ folders: [] }, file)
  text = readFileSync(file, 'utf8')
  assert.equal(/^folders:/m.test(text), false)
  assert.equal(/^version:/m.test(text), true)
  assert.deepEqual(readSkillsState(file).state, { version: 3, blocked: [], folders: [] })
})

test('YAML 损坏时拒绝覆盖并报错（不丢用户手写内容）', () => {
  const file = configFile('broken')
  writeFileSync(file, 'blocked: [unclosed\n', 'utf8')
  const broken = readSkillsState(file)
  assert.equal(broken.ok, false)
  assert.match(broken.message, /读取技能状态失败/)
  const written = writeSkillsState({ folders: [referenced] }, file)
  assert.equal(written.ok, false)
  assert.equal(readFileSync(file, 'utf8'), 'blocked: [unclosed\n', '损坏文件不得被覆盖')
})

test('非映射、别名、非法类型、旧 schema 与非法路径统一拒绝且保留原文件', () => {
  const file = configFile('validation')
  const cases = [
    ['非映射根', 'null\n'],
    ['序列根', '- item\n'],
    ['未定义别名', 'blocked: *missing\n'],
    ['别名复用', 'blocked: &b []\nunknown: *b\n'],
    ['旧 v2 受管库 schema', toYaml({ version: 2, dirs: [referenced], order: ['alpha'], rankBase: 300, skills: {} })],
    ['blocked 不是数组', toYaml({ version: 3, blocked: 'demo' })],
    ['folders 不是数组', toYaml({ version: 3, folders: 'D:/skills' })],
    ['引用目录不是绝对路径', toYaml({ version: 3, folders: ['relative/skills'] })],
    ['引用目录重复', toYaml({ version: 3, folders: [referenced, referenced] })],
    ['屏蔽记录不是映射', toYaml({ version: 3, blocked: ['demo'] })],
    ['屏蔽名字不是 kebab-case', toYaml({ version: 3, blocked: [{ name: 'Bad_Name', at: AT }] })],
    ['屏蔽名字是 __proto__', toYaml({ version: 3, blocked: [{ name: '__proto__', at: AT }] })],
    ['屏蔽记录缺少时间', toYaml({ version: 3, blocked: [{ name: 'demo' }] })],
    ['屏蔽记录重复', toYaml({ version: 3, blocked: [{ name: 'demo', at: AT }, { name: 'demo', at: AT }] })],
    ['屏蔽备注超长', toYaml({ version: 3, blocked: [{ name: 'demo', at: AT, note: 'x'.repeat(513) }] })],
  ]
  for (const [label, raw] of cases) {
    writeFileSync(file, raw)
    assert.equal(readSkillsState(file).ok, false, label)
    const written = writeSkillsState({ blocked: [{ name: 'demo', at: AT }] }, file)
    assert.equal(written.ok, false, label)
    assert.equal(readFileSync(file, 'utf8'), raw, `${label}：原文件不得被改写`)
  }
  // 超限：引用目录数量上限之外一律拒绝（不写出半份状态）。
  writeFileSync(file, toYaml({ version: 3, folders: Array.from({ length: 201 }, (_, index) => resolve(home, `bulk-${index}`)) }))
  const bulk = readFileSync(file, 'utf8')
  assert.equal(readSkillsState(file).ok, false)
  assert.equal(writeSkillsState({ folders: [referenced] }, file).ok, false)
  assert.equal(readFileSync(file, 'utf8'), bulk)
})

test('调用者携带的内容版本不匹配时拒绝写入', () => {
  const file = configFile('version')
  writeSkillsState({ blocked: [{ name: 'demo', at: AT }] }, file)
  const before = readFileSync(file, 'utf8')
  assert.equal(writeSkillsState({ blocked: [] }, file, 'stale').ok, false)
  assert.equal(readFileSync(file, 'utf8'), before)
  // 版本一致时允许写入（同一份内容快照可以继续改）。
  assert.equal(writeSkillsState({ folders: [referenced] }, file, before).ok, true)
})

test('重复写入同样内容不落盘（幂等）', async () => {
  const file = configFile('idempotent')
  const first = writeSkillsState({ blocked: [{ name: 'demo', at: AT }], folders: [referenced] }, file)
  assert.equal(first.ok, true, first.message)
  const before = readFileSync(file, 'utf8')
  const stamp = statSync(file).mtimeMs
  await new Promise((done) => setTimeout(done, 20))
  const second = writeSkillsState({ blocked: [{ name: 'demo', at: AT }], folders: [referenced] }, file)
  assert.equal(second.ok, true, second.message)
  assert.deepEqual(second.state, first.state)
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.equal(statSync(file).mtimeMs, stamp, '内容无变化时不得重写文件')
})

test('Object.prototype 上的名字是合法技能身份，__proto__ 仍被拒绝', () => {
  const file = configFile('proto-names')
  // 真实技能库存在名为 prototype / constructor 的技能：身份校验不能把它当成保留名拒绝。
  const written = writeSkillsState({
    blocked: [{ name: 'prototype', at: AT }, { name: 'constructor', at: AT }],
  }, file)
  assert.equal(written.ok, true, written.message)
  const read = readSkillsState(file)
  assert.equal(read.ok, true, read.message)
  assert.deepEqual(read.state.blocked.map((item) => item.name).sort(), ['constructor', 'prototype'])
  // 屏蔽表是数组：继承属性不会被误读成「存在的屏蔽记录」。
  assert.equal(Object.getPrototypeOf(read.state.blocked), Array.prototype)
  assert.equal(Object.hasOwn(read.state.blocked, 'tostring'), false)
  assert.equal(Object.hasOwn(read.state.blocked, 'valueOf'), false)
  // __proto__ 既不是合法技能名，也不能借记录载体的原型改写绕过校验。
  const malicious = JSON.parse(`[{"__proto__": {"name": "evil", "at": "${AT}"}}]`)
  assert.equal(Object.hasOwn(malicious[0], '__proto__'), true)
  assert.equal(SKILL_NAME_PATTERN.test('__proto__'), false)
  assert.equal(SKILL_NAME_PATTERN.test('prototype'), true)
  assert.equal(writeSkillsState({ blocked: [{ name: '__proto__', at: AT }] }, file).ok, false)
  assert.equal(writeSkillsState({ blocked: malicious }, file).ok, false)
  assert.deepEqual(readSkillsState(file).state.blocked.map((item) => item.name).sort(), ['constructor', 'prototype'])
  // 校验函数本身也拒绝非映射与非 kebab-case 名字。
  assert.throws(() => validateSkillsState('nope'), /技能状态必须是映射/)
  assert.throws(() => validateSkillsState({ version: 3, blocked: [{ name: 'Nope', at: AT }] }), /技能名不合法/)
  assert.deepEqual(validateSkillsState({ blocked: [], folders: [referenced] }).folders, [referenced])
})
