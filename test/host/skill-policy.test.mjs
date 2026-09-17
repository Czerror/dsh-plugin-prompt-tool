/** 技能调用策略的文件层写入回归：唯一真相是技能文件自己的 frontmatter。
 *
 *  这一层取代了「注册层影子候选」——注册层的同名裁决是「最近层无视优先级直接胜出」，
 *  影子候选必然被预设层覆盖。所以本文件断言的重点从「候选谁胜出」搬到了**文件字节**：
 *  只改目标键、其余逐字保留、无变化不落盘、被拒绝时文件逐字节不变、失败不留暂存文件。
 *
 *  官方两个键的值语义（唯一正确解释，断言全部按它校准）：
 *  - `disable-model-invocation: true` ⇒ 模型端**不可**调用（`modelInvocable=false`），`false` ⇒ 可调用；
 *  - `user-invocable: false` ⇒ 用户端**不可**调用（`userInvocable=false`），`true` ⇒ 可调用。
 *  落盘真值表：model→(true,true)、user→(false,false)、all→(true,false)、none→(false,true)，
 *  读回分别是 {false,true} / {true,false} / {false,false} / {true,true}。
 *
 *  `docs/skills-management.md` 与 `src/host/skills-policy.ts` 是行为契约来源；
 *  端到端「写完重新 list() 得到什么」在 `skill-policy-e2e.test.mjs`。 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const sandbox = mkdtempSync(join(tmpdir(), 'pt-skill-policy-'))
after(() => { rmSync(sandbox, { recursive: true, force: true }) })

const { policyTarget, readSkillInvocation, setSkillInvocation } = await import('../../src/host/skills-policy.ts')
const { invocationForScope, scopeOfInvocation } = await import('../../src/shared/skills.ts')

const BOM = '\ufeff'
const MODEL_KEY = 'disable-model-invocation'
const USER_KEY = 'user-invocable'

let counter = 0
/** 每个用例一个独立技能目录：断言不共享状态，也不依赖执行顺序。 */
function makeMarker(marker = 'SKILL.md') {
  counter += 1
  const dir = join(sandbox, `skill-${counter}`)
  mkdirSync(dir, { recursive: true })
  return join(dir, marker)
}

const write = (file, raw) => { writeFileSync(file, raw, 'utf8'); return file }

/** 只读暂存文件检查：写入路径是同目录 `.<basename>.tmp-<uuid>`。 */
const leftovers = (file) => readdirSync(join(file, '..'))
  .filter((name) => new RegExp(`^\\.${basename(file).replaceAll('.', '\\.')}\\.tmp-`).test(name))

/** 顶层 `key: value` 清单 → **归一后的调用策略**（不是原始键值，避免把语义读反）。 */
function flagsOf(raw) {
  const lines = raw.replace(/^\ufeff/, '').split(/\r?\n/)
  assert.equal(lines[0], '---', 'frontmatter 必须以 --- 开头')
  const end = lines.indexOf('---', 1)
  assert.notEqual(end, -1, 'frontmatter 必须有收尾 ---')
  let model
  let user
  for (const line of lines.slice(1, end)) {
    const match = /^(disable-model-invocation|user-invocable|disableModelInvocation|userInvocable):\s*(\S+)\s*$/.exec(line)
    if (match === null) continue
    const value = match[2] === 'true' ? true : match[2] === 'false' ? false : match[2]
    if (match[1] === MODEL_KEY || match[1] === 'disableModelInvocation') model = value
    if (match[1] === USER_KEY || match[1] === 'userInvocable') user = value
  }
  return {
    // 键的原始值本身就是「不可调用 / 允许调用」，这里统一归一成「可调用」两端的语义。
    modelInvocable: model !== true,
    userInvocable: user !== false,
    rawModel: model,
    rawUser: user,
  }
}

/** 逐字保留的公共断言：注释、未知字段与正文一个字都不能动。 */
function assertPreserved(file, { body, extras }) {
  const text = readFileSync(file, 'utf8')
  assert.match(text, /^# 顶层注释：保留我$/m)
  assert.match(text, /# 行尾注释：也保留我/)
  assert.match(text, /^unknown-field: 未知字段值$/m)
  assert.match(text, /# 嵌套内注释：保留我/)
  assert.ok(text.endsWith(body), '正文必须逐字保留（含结尾换行）')
  for (const extra of extras) assert.ok(text.includes(extra), `其余键必须保留：${extra}`)
  return text
}

const LF_FIXTURE = [
  '---',
  '# 顶层注释：保留我',
  'name: demo-skill',
  'description: 演示技能',
  'whenToUse: 需要演示时',
  'unknown-field: 未知字段值',
  'metadata:',
  '  owner: someone',
  '  # 嵌套内注释：保留我',
  '  tags:',
  '    - alpha',
  'nested:',
  '  deep:',
  '    key: value',
  'quoted: "双引号值"',
  'single: \'单引号值\'',
  'block: |',
  '  块标量第一行',
  '  块标量第二行',
  'flow: { a: 1, b: 2 }',
  'sequence:',
  '  - one',
  '  - two',
  'disableModelInvocation: true',
  'userInvocable: false',
  'trailing: value      # 行尾注释：也保留我',
  '---',
  '',
  '# demo-skill 正文',
  '',
  '正文第一段。',
  '',
  '  --- 缩进的三个横线不是 frontmatter 边界',
  '正文最后一段。',
  '',
].join('\n')
/** 第二个 `---` 及其后换行之后的原始正文（逐字保留断言的期望值）。 */
const LF_BODY = LF_FIXTURE.slice(LF_FIXTURE.indexOf('\n---\n', 20) + 5)
/** 同一 fixture 里的 frontmatter 段（第二个 `---` 之前，首行 `---` 之后）。 */
const LF_FRONTMATTER = LF_FIXTURE.slice(4, LF_FIXTURE.indexOf('\n---\n', 20))

test('只写目标键：注释、未知字段、其余键与正文逐字保留（LF + camelCase 就地改写）', () => {
  const file = write(makeMarker(), LF_FIXTURE)
  const before = readFileSync(file, 'utf8')
  assert.equal(before, LF_FIXTURE, 'fixture 必须能被解析出 frontmatter（首行是 ---）')

  // fixture 已有驼峰键 `disableModelInvocation: true`（= 模型端已停用）与 `userInvocable: false`。
  // scope=model 的目标是「模型端停用、用户端可用」：只有用户端需要变，模型键必须保持零改动。
  const written = setSkillInvocation(file, 'model')
  assert.equal(written.ok, true, written.message)
  assert.equal(written.changed, true, '用户端需要从不可调用改为可调用')
  assert.deepEqual(
    [written.invocation.modelInvocable, written.invocation.userInvocable],
    [false, true],
    'scope=model 的目标状态：模型端不可调用、用户端可调用',
  )
  const text = assertPreserved(file, {
    body: LF_BODY,
    extras: ['disableModelInvocation: true', 'name: demo-skill', 'whenToUse: 需要演示时', 'quoted: "双引号值"', "single: '单引号值'", 'flow: { a: 1, b: 2 }', 'block: |'],
  })
  const flags = flagsOf(text)
  assert.deepEqual([flags.modelInvocable, flags.userInvocable], [false, true], 'camelCase 键就地改写后按真值表解读')
  assert.deepEqual([flags.rawModel, flags.rawUser], [true, true], '落盘的原始值')
  assert.equal(text.includes('user-invocable'), false, '不新增连字符键去和已声明的驼峰键打对台')
  assert.equal(text.includes('disable-model-invocation'), false, '已声明的驼峰模型键不得被改写或另起一份')
  // 逐行比较：值行只允许 `userInvocable` 变；`trailing` 行的行尾空格被 yaml Document 规范化，
  // 属于「注释/结构保留、行内多余空白折叠」的已知行为，其余行必须逐字节不变。
  const beforeLines = before.split('\n')
  const afterLines = text.split('\n')
  assert.equal(afterLines.length, beforeLines.length)
  const changed = beforeLines.filter((line, index) => line !== afterLines[index])
  assert.deepEqual(changed.sort(), ['trailing: value      # 行尾注释：也保留我', 'userInvocable: false'].sort(),
    `只允许这两行变化：${changed.join(' | ')}`)
  const valueChanges = beforeLines.filter((line, index) => line.replace(/\s+/gu, ' ') !== afterLines[index].replace(/\s+/gu, ' '))
  assert.deepEqual(valueChanges, ['userInvocable: false'], '归一空白后只有 userInvocable 的值变了')
  assert.equal(afterLines[beforeLines.indexOf('userInvocable: false')], 'userInvocable: true', 'camelCase 键就地改写')
  assert.match(afterLines[beforeLines.indexOf('trailing: value      # 行尾注释：也保留我')], /^trailing: value # 行尾注释：也保留我$/, '只有键后的多余空白被折叠')
  assert.equal(afterLines.includes('disableModelInvocation: true'), true, '模型端驼峰键逐字保留')
  // frontmatter 段之外的每个字节都不变：正文与第二个 --- 之前的所有行原样保留。
  assert.equal(text.slice(text.indexOf('\n---\n', 20) + 5), LF_BODY)
  assert.equal(text.slice(4, text.indexOf('\n---\n', 20)), LF_FRONTMATTER.replace('userInvocable: false', 'userInvocable: true').replace('trailing: value      #', 'trailing: value #'))

  // 目标状态已达成时零写入：同一 scope 再写一次不得落盘。
  const stamp = statSync(file).mtimeMs
  const again = setSkillInvocation(file, 'model')
  assert.equal(again.ok, true, again.message)
  assert.equal(again.changed, false, '驼峰键已表达「模型端不可调用」，不该产生写入')
  assert.equal(readFileSync(file, 'utf8'), text, '无变化时文件必须逐字节不变')
  assert.equal(statSync(file).mtimeMs, stamp, '零写入不得更新 mtimeMs')
  assert.deepEqual(leftovers(file), [], '成功写入不留暂存文件')
})

test('两端独立：scope 只关对应的一端，none 两端恢复且写显式 true', () => {
  // scope → [读回的 modelInvocable, userInvocable] → [落盘的原始键值]
  const table = {
    model: { invocation: [false, true], raw: [true, true] },
    user: { invocation: [true, false], raw: [false, false] },
    all: { invocation: [false, false], raw: [true, false] },
    none: { invocation: [true, true], raw: [false, true] },
  }
  for (const [scope, expected] of Object.entries(table)) {
    // 起点按 scope 选，保证每个 scope 的目标状态都与起点不同 —— `changed` 才有区分度。
    // 同时覆盖三种键形态：两个连字符键（all/none）、只有连字符模型键（user）、只有驼峰键（model）。
    const start = {
      model: 'disableModelInvocation: false\n',
      user: `${MODEL_KEY}: false\n`,
      all: `${MODEL_KEY}: false\n${USER_KEY}: true\n`,
      none: `${MODEL_KEY}: true\n${USER_KEY}: false\n`,
    }[scope]
    const file = write(makeMarker(), `---\nname: demo\ndescription: D\n${start}---\n正文\n`)
    const result = setSkillInvocation(file, scope)
    assert.equal(result.ok, true, `${scope}: ${result.message}`)
    assert.equal(result.changed, true, `${scope} 应改变目标键`)
    assert.deepEqual(
      [result.invocation.modelInvocable, result.invocation.userInvocable],
      expected.invocation,
      `${scope} 的写入意图（读回语义）`,
    )
    const flags = flagsOf(readFileSync(file, 'utf8'))
    assert.deepEqual([flags.modelInvocable, flags.userInvocable], expected.invocation, `${scope} 的落盘值按真值表解读`)
    assert.deepEqual([flags.rawModel, flags.rawUser], expected.raw, `${scope} 的落盘原始键值`)
    // 契约回环：落盘状态解释回同一个范围。
    assert.equal(scopeOfInvocation(result.invocation), scope)
    assert.deepEqual(result.invocation, invocationForScope(scope))
    // 语义与原始值必须互相印证，避免"两处一起写反"还能同时通过。
    assert.equal(flags.rawModel !== true, expected.invocation[0], 'disable-model-invocation 为 true 即模型端不可调用')
    assert.equal(flags.rawUser !== false, expected.invocation[1], 'user-invocable 为 false 即用户端不可调用')
  }

  // 显式值检查：none 必须把两个键都写成字面值，而不是删键靠缺省。
  const restored = write(makeMarker(), `---\nname: demo\ndescription: D\n${MODEL_KEY}: true\n${USER_KEY}: false\n---\n正文\n`)
  assert.equal(setSkillInvocation(restored, 'none').ok, true)
  const text = readFileSync(restored, 'utf8')
  assert.match(text, new RegExp(`^${MODEL_KEY}: false$`, 'm'), '恢复必须写显式 false，不靠删键缺省')
  assert.match(text, new RegExp(`^${USER_KEY}: true$`, 'm'), '恢复必须写显式 true，不靠删键缺省')
  assert.deepEqual([flagsOf(text).modelInvocable, flagsOf(text).userInvocable], [true, true])
  assert.equal(readSkillInvocation(restored).invocation.modelInvocable, true)
  assert.equal(readSkillInvocation(restored).invocation.userInvocable, true)
})

test('内容无变化时不落盘（mtimeMs 与内容双断言）', async () => {
  const file = write(makeMarker(), '---\nname: demo\ndescription: D\n---\n正文\n')
  const first = setSkillInvocation(file, 'all')
  assert.equal(first.ok, true, first.message)
  assert.equal(first.changed, true)
  const text = readFileSync(file, 'utf8')
  const stamp = statSync(file).mtimeMs
  await sleep(20)

  const second = setSkillInvocation(file, 'all')
  assert.equal(second.ok, true, second.message)
  assert.equal(second.changed, false, '同样的目标状态不得再次落盘')
  assert.equal(readFileSync(file, 'utf8'), text)
  assert.equal(statSync(file).mtimeMs, stamp, '内容无变化时 mtimeMs 不得变化（零写入）')

  // 已存在显式键且已表达目标状态时同样判定为零变化。
  const explicit = write(makeMarker(), `---\nname: demo\ndescription: D\n${MODEL_KEY}: false\n${USER_KEY}: true\n---\n正文\n`)
  const explicitStamp = statSync(explicit).mtimeMs
  await sleep(20)
  const noop = setSkillInvocation(explicit, 'none')
  assert.equal(noop.ok, true, noop.message)
  assert.equal(noop.changed, false)
  assert.equal(statSync(explicit).mtimeMs, explicitStamp)
})

test('CRLF 行尾与 UTF-8 BOM 文件：可写、正文逐字节保留、BOM 不丢', () => {
  const body = '# 正文\r\n\r\nCRLF 正文第一行。\r\nCRLF 正文第二行。\r\n'
  const file = write(makeMarker(), BOM + `---\r\nname: demo\r\ndescription: D\r\nunknown: 保留\r\n---\r\n${body}`)
  const result = setSkillInvocation(file, 'model')
  assert.equal(result.ok, true, result.message)
  assert.equal(result.changed, true)
  assert.deepEqual([result.invocation.modelInvocable, result.invocation.userInvocable], [false, true])
  const text = readFileSync(file, 'utf8')
  assert.equal(text.startsWith(BOM), true, '文件开头的 BOM 必须写回')
  assert.ok(text.endsWith(body), 'CRLF 正文必须逐字节保留')
  const flags = flagsOf(text)
  assert.deepEqual([flags.rawModel, flags.rawUser], [true, true], 'model：模型端写 true、用户端补 true')
  assert.deepEqual([flags.modelInvocable, flags.userInvocable], [false, true])
  // 目标键必须落在 frontmatter 段内（不是被塞进正文）。
  const frontmatter = text.replace(/^\ufeff/, '').split(/\r?\n---/)[0]
  assert.match(frontmatter, new RegExp(`^${MODEL_KEY}: true$`, 'm'))
  assert.match(frontmatter, new RegExp(`^${USER_KEY}: true$`, 'm'))
  assert.match(frontmatter, /^unknown: 保留$/m)
  assert.equal(frontmatter.includes('CRLF 正文第一行'), false, '正文不得被折进 frontmatter')
  assert.deepEqual(leftovers(file), [])

  // 无 BOM 的 CRLF 文件同样可写，且不得凭空写入 BOM。
  const plain = write(makeMarker(), `---\r\nname: demo\r\ndescription: D\r\n---\r\n${body}`)
  assert.equal(setSkillInvocation(plain, 'user').ok, true)
  const plainText = readFileSync(plain, 'utf8')
  assert.equal(plainText.startsWith(BOM), false, '原本没有 BOM 就不得写入 BOM')
  assert.ok(plainText.endsWith(body))
  assert.deepEqual([flagsOf(plainText).rawModel, flagsOf(plainText).rawUser], [false, false], 'user：两端都不可调用')

  // CRLF 文件在语义无变化时同样零写入。
  const stamp = statSync(plain).mtimeMs
  const again = setSkillInvocation(plain, 'user')
  assert.equal(again.changed, false)
  assert.equal(statSync(plain).mtimeMs, stamp)
})

test('拒绝条件各自返回 { ok: false }，且文件逐字节不变', () => {
  const cases = [
    ['缺 frontmatter', 'name: demo\ndescription: D\n'],
    ['frontmatter 未收尾', '---\nname: demo\ndescription: D\n'],
    ['frontmatter 不是映射（序列）', '---\n- name\n- demo\n---\n正文\n'],
    ['frontmatter 不是映射（标量）', '---\njust a string\n---\n正文\n'],
    ['frontmatter 不是映射（空文档）', '---\n\n---\n正文\n'],
    ['非法 YAML', '---\nname: [unclosed\n---\n正文\n'],
    ['未定义 YAML 别名', '---\nname: demo\nother: *missing\n---\n正文\n'],
    ['已定义别名同样拒绝', '---\nname: &n demo\nother: *n\n---\n正文\n'],
    ['合并键（本身是别名）同样拒绝', '---\nname: demo\nbase: &b { a: 1 }\nmerged:\n  <<: *b\n---\n正文\n'],
  ]
  for (const [label, raw] of cases) {
    const file = write(makeMarker(), raw)
    const before = readFileSync(file, 'utf8')
    assert.equal(before, raw, `${label}：fixture 本身就是逐字落的`)
    const read = readSkillInvocation(file)
    assert.equal(read.ok, false, `${label}：读取也必须如实失败`)
    assert.equal(typeof read.message, 'string')
    const written = setSkillInvocation(file, 'all')
    assert.equal(written.ok, false, `${label}：写入必须被拒绝`)
    assert.equal(typeof written.message, 'string', `${label}：拒绝要带原因`)
    assert.equal(written.changed, undefined, `${label}：拒绝载荷不得携带 changed`)
    assert.equal(readFileSync(file, 'utf8'), before, `${label}：被拒绝时文件逐字节不变`)
    assert.deepEqual(leftovers(file), [], `${label}：被拒绝不留暂存文件`)
  }
})

test('路径不是绝对路径时拒绝，且不去碰相对路径解析出来的文件', () => {
  const relative = join('relative', 'dir', 'SKILL.md')
  for (const target of [relative, 'SKILL.md', '', '.']) {
    const written = setSkillInvocation(target, 'all')
    assert.equal(written.ok, false, `必须拒绝非绝对路径：${JSON.stringify(target)}`)
    assert.match(written.message, /绝对路径/u)
  }
  // `C:SKILL.md` 是「C 盘当前目录」的盘符相对写法，不是绝对路径。
  const driveRelative = setSkillInvocation('C:SKILL.md', 'all')
  assert.equal(driveRelative.ok, false, '盘符相对路径也必须拒绝')
  assert.match(driveRelative.message, /绝对路径|SKILL\.md/u)
  // 相对路径解析出来的位置（测试 cwd）不得被创建或被改写。
  assert.equal(existsSync(join(process.cwd(), 'SKILL.md')), false)
  assert.equal(existsSync(join(process.cwd(), 'relative')), false)
  assert.equal(readSkillInvocation(relative).ok, false)
})

test('basename 不是 SKILL.md 时拒绝，目标文件逐字节不变', () => {
  for (const marker of ['skill.md', 'SKILL.MD', 'SKILL.md.bak', 'OTHER.md', 'SKILL']) {
    const file = write(makeMarker(marker), '---\nname: demo\ndescription: D\n---\n正文\n')
    const before = readFileSync(file, 'utf8')
    const read = readSkillInvocation(file)
    assert.equal(read.ok, false, `必须拒绝 ${marker}`)
    assert.match(read.message, /SKILL\.md/u)
    const written = setSkillInvocation(file, 'all')
    assert.equal(written.ok, false, `必须拒绝 ${marker}`)
    assert.match(written.message, /SKILL\.md/u)
    assert.equal(readFileSync(file, 'utf8'), before, `${marker}：原文件不得被改写`)
    assert.deepEqual(leftovers(file), [], `${marker}：被拒绝不留暂存文件`)
  }
})

test('文件不存在、是目录或父目录不存在时拒绝，不创建任何东西', () => {
  const missing = join(sandbox, 'not-there', 'SKILL.md')
  const missingRead = readSkillInvocation(missing)
  assert.equal(missingRead.ok, false)
  const missingWrite = setSkillInvocation(missing, 'all')
  assert.equal(missingWrite.ok, false)
  assert.equal(existsSync(join(sandbox, 'not-there')), false, '拒绝路径不得顺手创建父目录')

  // 名为 SKILL.md 的目录：不是普通文件。
  const dirMarker = makeMarker()
  mkdirSync(dirMarker)
  const dirRead = readSkillInvocation(dirMarker)
  assert.equal(dirRead.ok, false)
  assert.match(dirRead.message, /不是普通文件/u)
  const dirWrite = setSkillInvocation(dirMarker, 'all')
  assert.equal(dirWrite.ok, false)
  assert.deepEqual(readdirSync(dirMarker), [], '目录必须保持为空，不被写入文件')
})

test('目标是符号链接时拒绝改写（不把写入带到根外）', (t) => {
  const realDir = join(sandbox, 'symlink-real')
  mkdirSync(realDir, { recursive: true })
  const real = write(join(realDir, 'SKILL.md'), '---\nname: demo\ndescription: D\n---\n正文\n')
  const before = readFileSync(real, 'utf8')
  const link = makeMarker()
  try {
    symlinkSync(real, link, 'file')
  } catch (error) {
    // Windows 未开开发者模式 / 缺 SeCreateSymbolicLinkPrivilege 时无法创建符号链接。
    t.diagnostic(`跳过符号链接用例：当前环境无法创建符号链接（${error.code ?? error.message}）`)
    return
  }
  const read = readSkillInvocation(link)
  assert.equal(read.ok, false, '符号链接技能不得可读')
  assert.match(read.message, /符号链接/u)
  const written = setSkillInvocation(link, 'all')
  assert.equal(written.ok, false, '符号链接技能不得可写')
  assert.match(written.message, /符号链接/u)
  assert.equal(readFileSync(real, 'utf8'), before, '链接目标文件必须逐字节不变')
  assert.deepEqual(leftovers(link), [], '被拒绝不留暂存文件')
})

test('底层写入失败时返回 { ok: false }、原文件不变且不留暂存文件', () => {
  const file = write(makeMarker(), '---\nname: demo\ndescription: D\n---\n正文\n')
  const before = readFileSync(file, 'utf8')
  // mode 000：非特权账号下写盘被拒（Windows 只读属性等价语义），正好走到 catch + finally 清理分支。
  writeFileSync(file, before, { encoding: 'utf8', mode: 0o000 })
  let written
  try {
    written = setSkillInvocation(file, 'all')
  } finally {
    // Windows 只读文件必须先恢复可写才能改写；即便恢复失败也要继续走下面的清理断言。
    try { chmodSync(file, 0o666) } catch { /* 恢复失败不掩盖主断言 */ }
    try { writeFileSync(file, before, 'utf8') } catch { /* 同上 */ }
  }
  if (written.ok === false) {
    assert.equal(typeof written.message, 'string', '失败要带原因')
    assert.equal(readFileSync(file, 'utf8'), before, '写入失败时原文件必须逐字节不变')
  } else {
    // 特权账号（Windows 管理员 / root）下 mode 拦不住写入，只能走成功分支：
    // 不做无法满足的断言，显式记录即可——失败分支的清理不变量由下方兜住。
    process.stderr.write('[skill-policy] 提示：当前账号可写只读文件，未触发底层写入失败分支\n')
    assert.equal(written.changed, true)
  }
  // 无论写入成功还是失败，暂存文件都必须被清理：任何路径都不得残留 .SKILL.md.tmp-*。
  assert.deepEqual(leftovers(file), [], '任何路径都不得残留 .SKILL.md.tmp-* 暂存文件')

  // 连续多次写入后目录里只剩 SKILL.md（成功路径的清理断言）。
  const clean = write(makeMarker(), '---\nname: demo\ndescription: D\n---\n正文\n')
  setSkillInvocation(clean, 'all')
  setSkillInvocation(clean, 'none')
  setSkillInvocation(clean, 'model')
  assert.deepEqual(leftovers(clean), [], '连续多次写入后不留暂存文件')
  assert.deepEqual(readdirSync(join(clean, '..')), ['SKILL.md'], '技能目录里不得出现任何额外文件')
})

test('身份校验（真实实现）：陈旧路径、无效技能与空清单一律拒绝，命中才放行', () => {
  const catalog = [
    { name: 'demo-skill', path: 'D:/skills/demo-skill/SKILL.md', valid: true },
    { name: 'demo-skill', path: 'D:/other/demo-skill/SKILL.md', valid: false, issue: 'frontmatter 缺少 name' },
  ]
  // 命中：同名 + 同路径 + 有效。
  assert.deepEqual(policyTarget(catalog, 'demo-skill', 'D:/skills/demo-skill/SKILL.md'), { ok: true })
  // 陈旧 / 伪造路径：同名但路径不符（界面加载后技能被替换或改名）。
  const stale = policyTarget(catalog, 'demo-skill', 'D:/other/renamed/SKILL.md')
  assert.equal(stale.ok, false, '路径不符必须拒绝')
  assert.match(stale.message, /已变化/u)
  // 技能名在清单里根本不存在。
  assert.equal(policyTarget(catalog, 'missing-skill', 'D:/skills/demo-skill/SKILL.md').ok, false)
  // 命中但条目无效：拒绝并如实说明原因。
  const invalid = policyTarget(catalog, 'demo-skill', 'D:/other/demo-skill/SKILL.md')
  assert.equal(invalid.ok, false)
  assert.match(invalid.message, /技能无效/u)
  assert.match(invalid.message, /frontmatter 缺少 name/u)
  // 空清单（当前工作区没有该技能）：一律拒绝。
  assert.equal(policyTarget([], 'demo-skill', 'D:/skills/demo-skill/SKILL.md').ok, false)
  // 没有 path 的条目不会因为 undefined 比较而误命中。
  assert.equal(policyTarget([{ name: 'demo-skill', valid: true }], 'demo-skill', 'D:/skills/demo-skill/SKILL.md').ok, false)
})
