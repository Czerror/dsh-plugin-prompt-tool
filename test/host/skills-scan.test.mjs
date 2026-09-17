/** 技能扫描回归：六类官方技能根、"一层发现"规则、同名裁决与清单投影。
 *
 *  这些规则必须与官方 `dsh-skill-filesystem` 一致，否则清单会展示模型其实看不到的技能，
 *  或者漏掉真实存在的技能。用例全部在独立临时目录里构造真实文件，不依赖共享状态。 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  catalogFromScan,
  markWinners,
  resolveProjectRoot,
  rootsFingerprint,
  scanRoot,
  scanRoots,
  skillRoots,
} from '../../src/host/skills-scan.ts'
import { SKILL_SOURCES } from '../../src/shared/skills.ts'

const tempDirs = []
function makeRoot(prefix = 'pt-scan-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
after(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }) })

function writeSkill(root, folder, frontmatter, body = '正文') {
  mkdirSync(join(root, folder), { recursive: true })
  writeFileSync(join(root, folder, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}\n`, 'utf8')
}

/** 扫描结果替身：只用清单与裁决真正读取的字段。 */
const scanned = (overrides = {}) => ({
  id: 'user-dsh:/u:demo',
  source: 'user-dsh',
  rank: SKILL_SOURCES['user-dsh'].rank,
  dir: '/u',
  folder: 'demo',
  file: '/u/demo/SKILL.md',
  name: 'demo',
  description: '',
  body: '',
  valid: true,
  modelInvocable: true,
  userInvocable: true,
  ...overrides,
})

test('一层发现：只认 <根>/<目录>/SKILL.md，不递归也不认扁平文件', () => {
  const root = makeRoot()
  writeSkill(root, 'alpha', 'name: alpha\ndescription: A 的描述')
  mkdirSync(join(root, 'nested', 'child'), { recursive: true })
  writeFileSync(join(root, 'nested', 'child', 'SKILL.md'), '---\nname: child\ndescription: C\n---\n正文\n', 'utf8')
  writeFileSync(join(root, 'flat.md'), '---\nname: flat\ndescription: F\n---\n正文\n', 'utf8')
  mkdirSync(join(root, 'no-marker'))

  const skills = scanRoot({ kind: 'user-dsh', path: root })
  assert.deepEqual(skills.map((skill) => skill.folder), ['alpha'], '嵌套、扁平与缺标记文件的目录都不算技能')
  assert.equal(skills[0].source, 'user-dsh')
  assert.equal(skills[0].rank, SKILL_SOURCES['user-dsh'].rank)
  assert.equal(skills[0].name, 'alpha')
  assert.equal(skills[0].description, 'A 的描述')
  assert.equal(skills[0].valid, true)
  assert.equal(skills[0].file, join(root, 'alpha', 'SKILL.md'))
})

test('技能根不存在或不是目录时返回空，不抛错', () => {
  const root = makeRoot()
  assert.deepEqual(scanRoot({ kind: 'custom', path: join(root, 'missing') }), [])
  writeFileSync(join(root, 'a-file'), 'x', 'utf8')
  assert.deepEqual(scanRoot({ kind: 'custom', path: join(root, 'a-file') }), [])
})

test('有效性：缺 name / 缺 description / 名字非 kebab-case 都标记无效并给出原因', () => {
  const root = makeRoot()
  writeSkill(root, 'no-name', 'description: 只有描述')
  writeSkill(root, 'no-description', 'name: no-description')
  writeSkill(root, 'Bad_Name', 'name: Bad_Name\ndescription: 大写名字')

  const issues = Object.fromEntries(scanRoot({ kind: 'user-dsh', path: root }).map((skill) => [skill.folder, skill.issue]))
  assert.equal(issues['no-name'], 'frontmatter 缺少 name')
  assert.equal(issues['no-description'], 'frontmatter 缺少 description')
  assert.equal(issues['Bad_Name'], '技能名不是 kebab-case：Bad_Name')
})

test('调用声明只影响对应的一端，缺省时两端都可调用', () => {
  const root = makeRoot()
  writeSkill(root, 'model-off', 'name: model-off\ndescription: D\ndisable-model-invocation: true')
  writeSkill(root, 'user-off', 'name: user-off\ndescription: D\nuser-invocable: false')
  writeSkill(root, 'both-default', 'name: both-default\ndescription: D')

  const byName = Object.fromEntries(scanRoot({ kind: 'user-dsh', path: root }).map((skill) => [skill.name, skill]))
  assert.deepEqual([byName['model-off'].modelInvocable, byName['model-off'].userInvocable], [false, true])
  assert.deepEqual([byName['user-off'].modelInvocable, byName['user-off'].userInvocable], [true, false])
  assert.deepEqual([byName['both-default'].modelInvocable, byName['both-default'].userInvocable], [true, true])
})

test('技能根构成与顺序：项目 > 引用目录 > 用户 > 内置', () => {
  const cwd = makeRoot('pt-scan-project-')
  mkdirSync(join(cwd, '.git'), { recursive: true })
  const dshHome = makeRoot('pt-scan-home-')
  const referenced = makeRoot('pt-scan-ref-')
  const bundled = makeRoot('pt-scan-bundled-')
  const agentsHome = join(dshHome, 'agents')
  const previousBundled = process.env.DSH_BUNDLED_SKILL_DIR
  const previousAgents = process.env.DSH_AGENTS_HOME
  process.env.DSH_BUNDLED_SKILL_DIR = bundled
  process.env.DSH_AGENTS_HOME = agentsHome
  try {
    const roots = skillRoots({ cwd, dshHome, folders: [referenced] })
    assert.deepEqual(roots.map((root) => root.kind),
      ['project-dsh', 'project-agents', 'custom', 'user-dsh', 'user-agents', 'bundled'])
    assert.equal(roots[0].path, join(cwd, '.dsh', 'skills'))
    assert.equal(roots[1].path, join(cwd, '.agents', 'skills'))
    assert.equal(roots[2].path, referenced)
    assert.equal(roots[3].path, join(dshHome, 'skills'))
    assert.equal(roots[4].path, join(agentsHome, 'skills'))
    assert.equal(roots[5].path, bundled)

    const withoutCwd = skillRoots({ dshHome, folders: [] })
    assert.deepEqual(withoutCwd.map((root) => root.kind), ['user-dsh', 'user-agents', 'bundled'],
      '没有工作目录时不产生项目根')
  } finally {
    if (previousBundled === undefined) delete process.env.DSH_BUNDLED_SKILL_DIR
    else process.env.DSH_BUNDLED_SKILL_DIR = previousBundled
    if (previousAgents === undefined) delete process.env.DSH_AGENTS_HOME
    else process.env.DSH_AGENTS_HOME = previousAgents
  }
})

test('项目根：向上找第一个含 .git 的目录，找不到时退回工作目录本身', () => {
  const outer = makeRoot('pt-scan-outer-')
  mkdirSync(join(outer, '.git'), { recursive: true })
  const inner = join(outer, 'packages', 'app')
  mkdirSync(inner, { recursive: true })
  assert.equal(resolveProjectRoot(inner), resolve(outer))

  const lone = makeRoot('pt-scan-lone-')
  assert.equal(resolveProjectRoot(lone), resolve(lone))
})

test('同名裁决：按优先级取首个有效技能，无效者不参与', () => {
  const skills = [
    scanned({ id: 'user-dsh:/u:demo', source: 'user-dsh', rank: SKILL_SOURCES['user-dsh'].rank }),
    scanned({ id: 'project-dsh:/p:demo', source: 'project-dsh', rank: SKILL_SOURCES['project-dsh'].rank }),
  ]
  assert.equal(markWinners(skills).get('demo'), 'project-dsh:/p:demo', '项目根优先于用户根')

  const withInvalid = [
    scanned({ id: 'project-dsh:/p:demo', source: 'project-dsh', rank: SKILL_SOURCES['project-dsh'].rank, valid: false, issue: 'x' }),
    scanned({ id: 'user-dsh:/u:demo', source: 'user-dsh', rank: SKILL_SOURCES['user-dsh'].rank }),
  ]
  assert.equal(markWinners(withInvalid).get('demo'), 'user-dsh:/u:demo', '无效技能让位给下一个同名有效技能')
})

test('清单投影：屏蔽范围映射到两端标志，被遮蔽条目带 winnerId', () => {
  const project = scanned({ id: 'project-dsh:/p:demo', source: 'project-dsh', rank: SKILL_SOURCES['project-dsh'].rank })
  const bundled = scanned({ id: 'bundled:/b:demo', source: 'bundled', rank: SKILL_SOURCES.bundled.rank })

  const [onlyModelBlocked] = catalogFromScan([project], new Map([['demo', 'model']]))
  assert.deepEqual(
    [onlyModelBlocked.blocked, onlyModelBlocked.blockedModel, onlyModelBlocked.blockedUser],
    [true, true, false],
    '只关模型端时用户端仍可用',
  )

  const [allBlocked] = catalogFromScan([project], new Map([['demo', 'all']]))
  assert.deepEqual([allBlocked.blocked, allBlocked.blockedModel, allBlocked.blockedUser], [true, true, true])

  const catalog = catalogFromScan([project, bundled], new Map())
  const winner = catalog.find((item) => item.id === project.id)
  const shadowed = catalog.find((item) => item.id === bundled.id)
  assert.equal(winner.winnerId, undefined, '胜出者不标注被遮蔽')
  assert.equal(shadowed.winnerId, project.id, '失败者标注胜出者 id')
  assert.equal(shadowed.blocked, false, '没有被屏蔽就不带屏蔽标志')
})

test('scanRoots 按根顺序拼接各来源结果', () => {
  const projectRoot = makeRoot('pt-scan-a-')
  const userRoot = makeRoot('pt-scan-b-')
  writeSkill(projectRoot, 'alpha', 'name: alpha\ndescription: A')
  writeSkill(userRoot, 'beta', 'name: beta\ndescription: B')
  const skills = scanRoots([
    { kind: 'project-dsh', path: projectRoot },
    { kind: 'user-dsh', path: userRoot },
  ])
  assert.deepEqual(skills.map((skill) => [skill.name, skill.source]), [['alpha', 'project-dsh'], ['beta', 'user-dsh']])
})

test('同名裁决：rank 并列时按 id 次序稳定取首个，输入顺序不影响结果', () => {
  const sameRank = [
    scanned({ id: 'user-dsh:/a:demo', rank: SKILL_SOURCES['user-dsh'].rank, name: 'demo' }),
    scanned({ id: 'user-dsh:/b:demo', rank: SKILL_SOURCES['user-dsh'].rank, name: 'demo' }),
    scanned({ id: 'user-dsh:/c:demo', rank: SKILL_SOURCES['user-dsh'].rank, name: 'demo' }),
  ]
  assert.equal(markWinners(sameRank).get('demo'), 'user-dsh:/a:demo', '并列时 id 字典序在前者胜出')
  // 压到排序次键的关键是「输入顺序与 id 顺序不一致」：正序时 V8 对全等比较器的小数组排序
  // 保序，删掉次键也看不出来；乱序样本才暴露问题（2 个元素的反序就够，这里用 3 个加一个轮转）。
  assert.equal(markWinners([sameRank[1], sameRank[2], sameRank[0]]).get('demo'), 'user-dsh:/a:demo', 'a 仍应胜出')
  assert.equal(markWinners([...sameRank].reverse()).get('demo'), 'user-dsh:/a:demo', '裁决不依赖输入顺序')
})

test('未配置内置技能根时不产生 bundled 来源（未设或空串都一样）', () => {
  const dshHome = makeRoot('pt-scan-nobundled-')
  const previousBundled = process.env.DSH_BUNDLED_SKILL_DIR
  const previousAgents = process.env.DSH_AGENTS_HOME
  process.env.DSH_AGENTS_HOME = join(dshHome, 'agents')
  try {
    delete process.env.DSH_BUNDLED_SKILL_DIR
    assert.deepEqual(skillRoots({ dshHome, folders: [] }).map((root) => root.kind), ['user-dsh', 'user-agents'])
    process.env.DSH_BUNDLED_SKILL_DIR = ''
    assert.deepEqual(skillRoots({ dshHome, folders: [] }).map((root) => root.kind), ['user-dsh', 'user-agents'],
      '空串同样视为未配置内置根')
  } finally {
    if (previousBundled === undefined) delete process.env.DSH_BUNDLED_SKILL_DIR
    else process.env.DSH_BUNDLED_SKILL_DIR = previousBundled
    if (previousAgents === undefined) delete process.env.DSH_AGENTS_HOME
    else process.env.DSH_AGENTS_HOME = previousAgents
  }
})

test('根指纹：技能集合或标记文件变化后失效，无变化时保持相同', () => {
  const root = makeRoot('pt-scan-fingerprint-')
  writeSkill(root, 'alpha', 'name: alpha\ndescription: A')
  const roots = [{ kind: 'custom', path: root }]
  const initial = rootsFingerprint(roots)
  assert.equal(rootsFingerprint(roots), initial, '没有变化时指纹必须稳定（否则缓存白失效）')

  // 新增技能目录 → 指纹变化（这是「手工往用户根里放技能，管理页却看不到」的判据）。
  writeSkill(root, 'beta', 'name: beta\ndescription: B')
  const added = rootsFingerprint(roots)
  assert.notEqual(added, initial, '新增技能目录必须改变指纹')

  // 修改既有技能：显式回拨标记文件时间，避免依赖写入间隔的毫秒精度。
  const marker = join(root, 'alpha', 'SKILL.md')
  const past = new Date(Date.now() - 60_000)
  utimesSync(marker, past, past)
  const afterTouch = rootsFingerprint(roots)
  assert.notEqual(afterTouch, added, '既有技能内容变化必须改变指纹')

  // 等长改写 + 把 mtime 还原：size 与 mtime 都一样，判据仍必须变化（ctime 抓得住）。
  const original = readFileSync(marker, 'utf8')
  writeFileSync(marker, original.replace('description: A', 'description: B'), 'utf8')
  utimesSync(marker, past, past)
  assert.notEqual(rootsFingerprint(roots), afterTouch, '等长改写并还原 mtime 也必须让指纹变化')

  // 删除技能目录 → 指纹变化。
  const current = rootsFingerprint(roots)
  rmSync(join(root, 'beta'), { recursive: true, force: true })
  assert.notEqual(rootsFingerprint(roots), current, '删除技能目录必须改变指纹')

  // 根不存在时指纹是固定值（kind|路径|-），不是「只是两次相等」。
  const missing = [{ kind: 'custom', path: join(root, 'not-there') }]
  assert.equal(rootsFingerprint(missing), `custom|${join(root, 'not-there')}|-`)
})
