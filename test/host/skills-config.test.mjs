// 技能插件状态文件（v4 文件层调用策略模型）：只记录用户显式引用的技能文件夹。
// 调用策略（模型端 / 用户端是否可调用）写在技能文件自己的 frontmatter 里，不进状态文件：
//  v3 的 `blocked` 屏蔽表随注册层影子候选方案移除，读取时忽略其内容（不校验、不报错），
//  写入时删除该键并把版本抬到 v4 —— 留着一个不再生效的键只会误导。
// 旧 v2 受管实体库 schema（dirs / order / rankBase / skills 记录）不是状态形状，仍按「不支持的版本」拒绝。
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

const referenced = resolve(home, 'referenced-skills')

function configFile(name) {
  const dir = join(home, name)
  mkdirSync(dir)
  return join(dir, 'skills.yml')
}

/** 状态形状守卫：状态文件只允许 version + folders 两个键。 */
const stateKeys = (file) => {
  const raw = readFileSync(file, 'utf8')
  return { raw, parsed: parseYaml(raw), keys: [...raw.matchAll(/^([A-Za-z0-9_-]+):/gm)].map((match) => match[1]).sort() }
}

test('状态文件缺失时回退默认 v4 状态，路径固定在用户技能根的点目录', () => {
  const file = skillsStatePath()
  assert.equal(file, join(home, 'skills', '.system', 'prompt-tool', 'skills.yml'))
  assert.equal(existsSync(file), false)
  const read = readSkillsState(file)
  assert.equal(read.ok, true)
  assert.equal(read.exists, false)
  assert.deepEqual(read.state, { version: SKILLS_STATE_VERSION, folders: [] })
  assert.equal(SKILLS_STATE_VERSION, 4, '调用策略回到技能文件后状态版本抬到 v4')
  assert.deepEqual(defaultSkillsState(), { version: 4, folders: [] })
  // 技能实体留在官方各自技能根里：状态文件不含任何实体库/链接/排序字段，也不含屏蔽表。
  assert.deepEqual(Object.keys(defaultSkillsState()).sort(), ['folders', 'version'])
  assert.equal('blocked' in defaultSkillsState(), false, '屏蔽表不再是状态形状的一部分')
})

test('写入/读回往返：只记引用目录，并保留手写注释与未知字段', () => {
  const file = configFile('roundtrip')
  const written = writeSkillsState({ folders: [referenced] }, file)
  assert.equal(written.ok, true, written.message)
  assert.deepEqual(written.state.folders, [referenced])
  assert.deepEqual(written.state, { version: 4, folders: [referenced] })
  assert.equal(existsSync(file), true)
  assert.deepEqual(readSkillsState(file).state, written.state)
  assert.deepEqual(stateKeys(file).keys, ['folders', 'version'], '状态形状只有 version 与 folders')

  // 手工注释与未知字段必须保留（yaml Document API 写回）。
  writeFileSync(file, `${readFileSync(file, 'utf8')}# 手工注释：保留我\nunknown: retained\n`, 'utf8')
  const updated = writeSkillsState({ folders: [referenced] }, file)
  assert.equal(updated.ok, true, updated.message)
  const text = readFileSync(file, 'utf8')
  assert.match(text, /# 手工注释：保留我/)
  assert.match(text, /unknown: retained/)
  const parsed = parseYaml(text)
  assert.deepEqual(parsed.folders, [referenced])
  assert.equal(parsed.version, 4)
  assert.equal(parsed.blocked, undefined, '写入后文件里不得有 blocked 键')
})

test('v3 输入被接受并升级到 v4：blocked 内容被忽略且写入时删除该键', () => {
  const file = configFile('v3-upgrade')
  // v3 的 blocked 内容刻意写得「不可能通过旧校验」：读取必须忽略它，而不是报错或去校验它。
  const legacy = toYaml({
    version: 3,
    blocked: [{ name: 'Bad_Name', at: '不是时间', note: 'x'.repeat(1024), extra: { nested: true } }],
    folders: [referenced],
  })
  writeFileSync(file, legacy, 'utf8')
  const read = readSkillsState(file)
  assert.equal(read.ok, true, read.message)
  assert.equal(read.exists, true)
  assert.deepEqual(read.state, { version: 4, folders: [referenced] }, 'v3 被读成 v4，blocked 整段丢弃')
  assert.equal('blocked' in read.state, false)

  // 校验函数同样接受 v3 且不校验 blocked 内容。
  assert.deepEqual(validateSkillsState({ version: 3, blocked: 'demo', folders: [referenced] }),
    { version: 4, folders: [referenced] })
  assert.deepEqual(validateSkillsState({ version: 3, blocked: null, folders: [] }), { version: 4, folders: [] })
  assert.deepEqual(validateSkillsState({ version: 3, folders: [referenced] }), { version: 4, folders: [referenced] })

  // 写入后：版本抬到 4，blocked 键被删除，folders 不受影响。
  const written = writeSkillsState({ folders: [referenced] }, file)
  assert.equal(written.ok, true, written.message)
  const { raw, parsed, keys } = stateKeys(file)
  assert.equal(parsed.version, 4)
  assert.equal(/^blocked:/m.test(raw), false, '写入必须删除 v3 遗留的 blocked 键')
  assert.deepEqual(parsed.folders, [referenced])
  assert.deepEqual(keys, ['folders', 'version'])

  // 只抬版本、不动 folders 的写入同样清掉 blocked。
  writeFileSync(file, legacy, 'utf8')
  assert.equal(writeSkillsState({}, file).ok, true)
  assert.equal(/^blocked:/m.test(readFileSync(file, 'utf8')), false)
  assert.equal(parseYaml(readFileSync(file, 'utf8')).version, 4)
  assert.deepEqual(readSkillsState(file).state, { version: 4, folders: [referenced] }, 'folders 不受影响')
})

test('非法版本仍拒绝：v2 受管库 schema 与越界版本都不被当成合法状态', () => {
  const file = configFile('versions')
  const cases = [
    ['旧 v2 受管库 schema', toYaml({ version: 2, dirs: [referenced], order: ['alpha'], rankBase: 300, skills: {} })],
    ['v1', toYaml({ version: 1, folders: [referenced] })],
    ['v5（未来版本）', toYaml({ version: 5, folders: [referenced] })],
    ['版本不是数字', toYaml({ version: 'v4', folders: [referenced] })],
    ['版本为 null', toYaml({ version: null, folders: [referenced] })],
    ['版本是数组', toYaml({ version: [4], folders: [referenced] })],
  ]
  for (const [label, raw] of cases) {
    writeFileSync(file, raw, 'utf8')
    const read = readSkillsState(file)
    assert.equal(read.ok, false, `${label}：必须拒绝`)
    assert.match(read.message, /不支持的技能状态版本|读取技能状态失败/u, label)
    const written = writeSkillsState({ folders: [referenced] }, file)
    assert.equal(written.ok, false, `${label}：写入同样拒绝`)
    assert.equal(readFileSync(file, 'utf8'), raw, `${label}：原文件不得被覆盖`)
  }
  // 校验函数直接拒绝非法版本，不依赖文件读路径。
  assert.throws(() => validateSkillsState({ version: 2, folders: [] }), /不支持的技能状态版本/)
  assert.throws(() => validateSkillsState({ version: 5, folders: [] }), /不支持的技能状态版本/)
  // 缺失版本按当前版本处理（向前兼容字段可选）。
  assert.deepEqual(validateSkillsState({ folders: [referenced] }), { version: 4, folders: [referenced] })
})

test('空引用目录删除对应键，文件保持精简', () => {
  const file = configFile('defaults')
  writeSkillsState({ folders: [referenced] }, file)
  assert.match(readFileSync(file, 'utf8'), /^folders:/m)
  writeSkillsState({ folders: [] }, file)
  const text = readFileSync(file, 'utf8')
  assert.equal(/^folders:/m.test(text), false)
  assert.equal(/^version:/m.test(text), true)
  assert.equal(/^blocked:/m.test(text), false)
  assert.deepEqual(readSkillsState(file).state, { version: 4, folders: [] })
})

test('YAML 损坏时拒绝覆盖并报错（不丢用户手写内容）', () => {
  const file = configFile('broken')
  writeFileSync(file, 'folders: [unclosed\n', 'utf8')
  const broken = readSkillsState(file)
  assert.equal(broken.ok, false)
  assert.match(broken.message, /读取技能状态失败/)
  const written = writeSkillsState({ folders: [referenced] }, file)
  assert.equal(written.ok, false)
  assert.equal(readFileSync(file, 'utf8'), 'folders: [unclosed\n', '损坏文件不得被覆盖')
})

test('非映射、别名、非法类型与非法路径统一拒绝且保留原文件', () => {
  const file = configFile('validation')
  const cases = [
    ['非映射根', 'null\n'],
    ['序列根', '- item\n'],
    ['未定义别名', 'folders: *missing\n'],
    ['别名复用', 'folders: &b []\nunknown: *b\n'],
    ['folders 不是数组', toYaml({ version: 4, folders: 'D:/skills' })],
    ['引用目录不是绝对路径', toYaml({ version: 4, folders: ['relative/skills'] })],
    ['引用目录重复', toYaml({ version: 4, folders: [referenced, referenced] })],
    ['引用目录元素不是字符串', toYaml({ version: 4, folders: [42] })],
    ['引用目录元素是空串', toYaml({ version: 4, folders: [''] })],
    ['v3 里的 folders 同样非法', toYaml({ version: 3, folders: 'D:/skills' })],
  ]
  for (const [label, raw] of cases) {
    writeFileSync(file, raw)
    assert.equal(readSkillsState(file).ok, false, label)
    const written = writeSkillsState({ folders: [referenced] }, file)
    assert.equal(written.ok, false, label)
    assert.equal(readFileSync(file, 'utf8'), raw, `${label}：原文件不得被改写`)
  }
  // 超限：引用目录数量上限之外一律拒绝（不写出半份状态）。
  writeFileSync(file, toYaml({ version: 4, folders: Array.from({ length: 201 }, (_, index) => resolve(home, `bulk-${index}`)) }))
  const bulk = readFileSync(file, 'utf8')
  assert.equal(readSkillsState(file).ok, false)
  assert.equal(writeSkillsState({ folders: [referenced] }, file).ok, false)
  assert.equal(readFileSync(file, 'utf8'), bulk)
})

test('调用者携带的内容版本不匹配时拒绝写入', () => {
  const file = configFile('version')
  writeSkillsState({ folders: [referenced] }, file)
  const before = readFileSync(file, 'utf8')
  assert.equal(writeSkillsState({ folders: [] }, file, 'stale').ok, false)
  assert.equal(readFileSync(file, 'utf8'), before)
  // 版本一致时允许写入（同一份内容快照可以继续改）。
  assert.equal(writeSkillsState({ folders: [] }, file, before).ok, true)
})

test('重复写入同样内容不落盘（幂等）', async () => {
  const file = configFile('idempotent')
  const first = writeSkillsState({ folders: [referenced] }, file)
  assert.equal(first.ok, true, first.message)
  const before = readFileSync(file, 'utf8')
  const stamp = statSync(file).mtimeMs
  await new Promise((done) => setTimeout(done, 20))
  const second = writeSkillsState({ folders: [referenced] }, file)
  assert.equal(second.ok, true, second.message)
  assert.deepEqual(second.state, first.state)
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.equal(statSync(file).mtimeMs, stamp, '内容无变化时不得重写文件')
})

test('Object.prototype 上的目录名是合法身份，__proto__ 同样不触发原型改写', () => {
  const file = configFile('proto-names')
  // 引用目录本身是路径：真实路径可能包含 prototype / constructor 这样的段名，不能被当成保留名拒绝。
  const prototypeDir = resolve(home, 'prototype')
  const constructorDir = resolve(home, 'constructor')
  const written = writeSkillsState({ folders: [prototypeDir, constructorDir] }, file)
  assert.equal(written.ok, true, written.message)
  const read = readSkillsState(file)
  assert.equal(read.ok, true, read.message)
  assert.deepEqual(read.state.folders, [prototypeDir, constructorDir])
  // 数组按索引元素读取：非索引的自有属性或继承属性都不会被当成一个目录。
  const withExtraProperty = { version: 4, folders: [] }
  Object.defineProperty(withExtraProperty.folders, 'inherited', { value: 'D:/evil', enumerable: true })
  assert.deepEqual(validateSkillsState(withExtraProperty).folders, [], '非索引属性不进入引用目录')
  // 恶意 JSON 自带的 __proto__ 键不能借记录载体改写原型。
  const malicious = JSON.parse('{"version":4,"folders":[],"__proto__":{"polluted":true}}')
  assert.equal(Object.hasOwn(malicious, '__proto__'), true)
  assert.equal(validateSkillsState(malicious).folders.length, 0)
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false, '不得污染 Object.prototype')
  // 技能名字模式仍用于目录名与写入前置校验（调用策略写入侧复用）。
  assert.equal(SKILL_NAME_PATTERN.test('__proto__'), false)
  assert.equal(SKILL_NAME_PATTERN.test('prototype'), true)
  assert.equal(SKILL_NAME_PATTERN.test('Bad_Name'), false)
  // 校验函数本身也拒绝非映射。
  assert.throws(() => validateSkillsState('nope'), /技能状态必须是映射/)
  assert.throws(() => validateSkillsState([]), /技能状态必须是映射/)
  assert.deepEqual(validateSkillsState({ folders: [referenced] }).folders, [referenced])
})
