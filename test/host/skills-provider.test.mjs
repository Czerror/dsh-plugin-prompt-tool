import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Wave 2 合并（2026-09-17 测试归一精简）：合并自 skills-provider.test.mjs（11 条）、
// profile-skills.test.mjs（3 条）、skills-watcher.test.mjs（1 条）。
// 安装副本目标固定在 DSH_HOME 技能根（官方 user-dsh 来源）：隔离 DSH_HOME 必须在
// 动态 import lib 之前生效（lib 在加载期解析技能根），否则会写到真实用户目录。
const home = mkdtempSync(join(tmpdir(), `prompt-tool-skills-home-${process.pid}-`))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const { parseFrontmatter, createCachedSkillsReader, readSkills, mergeSkillDirs, validSkills, SKILL_NAME_RE, resolveSkillsDir } =
  await import('../../lib/index.mjs')
after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

const makeDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-tool-skills-'))
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const writeSkill = (root, folder, content) => {
  const dir = join(root, folder)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf8')
  return dir
}

test('parseFrontmatter：剥掉 UTF-8 BOM 后仍能解析，body 不含 BOM', () => {
  const { data, body } = parseFrontmatter('\uFEFF---\nname: demo-skill\ndescription: Demo\n---\nBODY')
  assert.equal(data.name, 'demo-skill')
  assert.equal(data.description, 'Demo')
  assert.equal(body, 'BODY')
})

test('readSkills：BOM + 合法 kebab name 是有效条目，调用标志默认全开', () => {
  const { dir, cleanup } = makeDir()
  try {
    writeSkill(dir, 'demo-skill', '\uFEFF---\nname: demo-skill\ndescription: Demo skill\n---\nBODY')
    const [entry] = readSkills(dir)
    assert.equal(entry.folder, 'demo-skill')
    assert.equal(entry.name, 'demo-skill')
    assert.equal(entry.valid, true)
    assert.equal(entry.dir, dir)
    assert.equal(entry.modelInvocable, true)
    assert.equal(entry.userInvocable, true)
    assert.equal(entry.body, 'BODY')
    assert.equal(validSkills([entry]).length, 1)
  } finally {
    cleanup()
  }
})

test('mergeSkillDirs：多目录全量合并，同名技能全部保留并带各自来源 dir', () => {
  const a = makeDir()
  const b = makeDir()
  try {
    writeSkill(a.dir, 'shared-skill', '---\nname: shared-skill\ndescription: A\n---\nA')
    writeSkill(a.dir, 'only-a', '---\nname: only-a\ndescription: A\n---\nA')
    writeSkill(b.dir, 'shared-skill', '---\nname: shared-skill\ndescription: B\n---\nB')
    writeSkill(b.dir, 'only-b', '---\nname: only-b\ndescription: B\n---\nB')
    const merged = mergeSkillDirs([a.dir, b.dir], readSkills)
    assert.equal(merged.length, 4)
    const shared = merged.filter((entry) => entry.folder === 'shared-skill')
    assert.equal(shared.length, 2)
    assert.deepEqual(shared.map((entry) => entry.dir).sort(), [a.dir, b.dir].sort())
    assert.equal(merged.find((entry) => entry.folder === 'only-a').dir, a.dir)
    assert.equal(merged.find((entry) => entry.folder === 'only-b').dir, b.dir)
  } finally {
    a.cleanup()
    b.cleanup()
  }
})

test('readSkills：嵌套子技能同时注册（folder 相对路径），空文件夹不产生条目', () => {
  const { dir, cleanup } = makeDir()
  try {
    writeSkill(dir, 'main-skill', '---\nname: main-skill\ndescription: Main\n---\nMAIN')
    writeSkill(dir, 'main-skill/sub-skill', '---\nname: sub-skill\ndescription: Sub\n---\nSUB')
    writeSkill(dir, 'main-skill/sub-skill/deep-skill', '---\nname: deep-skill\ndescription: Deep\n---\nDEEP')
    // 多层空文件夹：不产生条目。
    mkdirSync(join(dir, 'empty-folder', 'inner', 'deeper'), { recursive: true })
    // 技能目录下的非技能子目录（无 SKILL.md）：不产生条目。
    mkdirSync(join(dir, 'main-skill', 'assets'), { recursive: true })
    const entries = readSkills(dir)
    const main = entries.find((entry) => entry.folder === 'main-skill')
    const sub = entries.find((entry) => entry.folder === 'main-skill/sub-skill')
    const deep = entries.find((entry) => entry.folder === 'main-skill/sub-skill/deep-skill')
    assert.ok(main, '主技能应注册')
    assert.ok(sub, '一级子技能应注册')
    assert.ok(deep, '多级嵌套子技能应注册')
    assert.equal(main.valid, true)
    assert.equal(sub.valid, true)
    assert.equal(deep.valid, true)
    assert.equal(sub.dir, dir)
    assert.equal(entries.find((entry) => entry.folder.includes('empty-folder')), undefined)
    assert.equal(entries.find((entry) => entry.folder.includes('assets')), undefined)
  } finally {
    cleanup()
  }
})

test('readSkills：无差别递归——任意层级含 SKILL.md 的目录都注册（点开头目录仍跳过）', () => {
  const { dir, cleanup } = makeDir()
  try {
    writeSkill(dir, 'main-skill', '---\nname: main-skill\ndescription: Main\n---\nMAIN')
    // 无 SKILL.md 的资源目录内含 SKILL.md：递归注册（嵌套技能包语义）。
    writeSkill(dir, 'resources/inner-skill', '---\nname: inner-skill\ndescription: Inner\n---\nINNER')
    // 点开头目录（.agents 等）：永远跳过。
    writeSkill(dir, '.agents/skills/inner-skill', '---\nname: inner-skill\ndescription: Inner\n---\nINNER')
    // 技能目录内的一级子目录含 SKILL.md：是嵌套子技能，注册。
    writeSkill(dir, 'main-skill/sub-skill', '---\nname: sub-skill\ndescription: Sub\n---\nSUB')
    const entries = readSkills(dir)
    const folders = entries.map((entry) => entry.folder).sort()
    assert.deepEqual(folders, ['main-skill', 'main-skill/sub-skill', 'resources/inner-skill'])
  } finally {
    cleanup()
  }
})

test('readSkills：非法名条目保留（valid=false + issue），provider 过滤层会跳过它', () => {
  const { dir, cleanup } = makeDir()
  try {
    writeSkill(dir, 'Bad Folder', '\uFEFF---\nname: 高级开发工程师\ndescription: Demo\n---\nBODY')
    const entries = readSkills(dir)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].folder, 'Bad Folder')
    assert.equal(entries[0].valid, false)
    assert.match(entries[0].issue, /kebab-case/)
    assert.equal(entries[0].modelInvocable, false)
    assert.equal(validSkills(entries).length, 0)
    assert.equal(SKILL_NAME_RE.test('Bad Folder'), false)
  } finally {
    cleanup()
  }
})

test('readSkills：disable-model-invocation / user-invocable 映射到调用标志', () => {
  const { dir, cleanup } = makeDir()
  try {
    writeSkill(dir, 'locked-skill', '---\nname: locked-skill\ndescription: Locked\ndisable-model-invocation: true\nuser-invocable: false\n---\nBODY')
    const [entry] = readSkills(dir)
    assert.equal(entry.valid, true)
    assert.equal(entry.modelInvocable, false)
    assert.equal(entry.userInvocable, false)
  } finally {
    cleanup()
  }
})

test('readSkills：无 frontmatter 标记 invalid（官方忽略语义的管理面保留）；缺失/隐藏目录跳过', () => {
  const { dir, cleanup } = makeDir()
  try {
    writeSkill(dir, 'fallback-skill', 'BODY without frontmatter')
    const missing = join(dir, 'broken-skill')
    mkdirSync(missing, { recursive: true })
    mkdirSync(join(dir, '.hidden'), { recursive: true })
    const entries = readSkills(dir)
    const fallback = entries.find((entry) => entry.folder === 'fallback-skill')
    assert.equal(fallback.name, 'fallback-skill')
    assert.equal(fallback.valid, false)
    assert.match(fallback.issue, /frontmatter/)
    // 技能规范：只有含 SKILL.md 的一级子目录才是技能；缺失/隐藏目录不出现在列表。
    assert.equal(entries.find((entry) => entry.folder === 'broken-skill'), undefined)
    assert.equal(entries.find((entry) => entry.folder === '.hidden'), undefined)
    // 无 frontmatter 的技能标记 invalid，不进入注册面。
    assert.equal(validSkills(entries).length, 0)
  } finally {
    cleanup()
  }
})

test('readSkills：frontmatter 缺 name 或缺 description 标记 invalid（官方必填契约）', () => {
  const { dir, cleanup } = makeDir()
  try {
    writeSkill(dir, 'no-desc', '---\nname: no-desc\n---\nBODY')
    writeSkill(dir, 'no-name', '---\ndescription: Only desc\n---\nBODY')
    const entries = readSkills(dir)
    assert.equal(entries.find((entry) => entry.folder === 'no-desc').valid, false)
    assert.match(entries.find((entry) => entry.folder === 'no-desc').issue, /description/)
    assert.equal(entries.find((entry) => entry.folder === 'no-name').valid, false)
    assert.match(entries.find((entry) => entry.folder === 'no-name').issue, /name/)
  } finally {
    cleanup()
  }
})

test('readSkills：junction/符号链接技能目录被跟随并标记 linked', () => {
  const { dir, cleanup } = makeDir()
  try {
    // 真实技能目录（含 SKILL.md）+ junction 链接挂入扫描根（模拟 Windows 链接挂载）。
    const real = writeSkill(dir, 'real-skill', '---\nname: linked-skill\ndescription: Linked\n---\nBODY')
    const linkedRoot = join(dir, 'linked-root')
    mkdirSync(linkedRoot, { recursive: true })
    try {
      symlinkSync(real, join(linkedRoot, 'linked-skill'), 'junction')
    } catch {
      // 无权限创建链接时跳过该测试（如 CI 限制）。
      return
    }
    const entries = readSkills(linkedRoot)
    const linked = entries.find((entry) => entry.folder === 'linked-skill')
    assert.ok(linked, 'junction 链接的技能应被扫描到')
    assert.equal(linked.valid, true)
    assert.equal(linked.linked, true)
  } finally {
    cleanup()
  }
})

test('createCachedSkillsReader：内容未变化时复用同一次扫描结果，变化后自动失效', () => {
  const { dir, cleanup } = makeDir()
  try {
    writeSkill(dir, 'cached-skill', '---\nname: cached-skill\ndescription: v1\n---\nBODY-ONE')
    const cached = createCachedSkillsReader()
    const first = cached.read(dir)
    const second = cached.read(dir)
    assert.equal(first, second)
    assert.equal(first[0].body, 'BODY-ONE')

    writeSkill(dir, 'cached-skill', '---\nname: cached-skill\ndescription: v2\n---\nBODY-TWO-LONGER')
    const third = cached.read(dir)
    assert.notEqual(third, first)
    assert.equal(third[0].body, 'BODY-TWO-LONGER')

    const fourth = cached.read(dir)
    assert.equal(fourth, third)
    cached.invalidate(dir)
    const fifth = cached.read(dir)
    assert.notEqual(fifth, third)
  } finally {
    cleanup()
  }
})

// —— 包内技能安装副本（原 profile-skills.test.mjs，3 条） ——
// 块作用域隔离：本组自带的 writeSkill 与上面的同名 helper 形态不同（不返回 dir），
// 复用外层隔离 DSH_HOME 与已导入的 resolveSkillsDir，用例体逐字保留。
{
const TARGET_DIR = join(home, 'skills')

/** 每个用例独立的包内 skills 源目录（模拟包根下的 skills/）。 */
function makeSource() {
  const root = mkdtempSync(join(tmpdir(), `prompt-tool-skills-src-${process.pid}-`))
  const sourceDir = join(root, 'skills')
  mkdirSync(sourceDir, { recursive: true })
  return { sourceDir, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function writeSkill(root, folder, content) {
  const dir = join(root, folder)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf8')
}

test('resolveSkillsDir：不再自动复制或写入技能版本账本', () => {
  rmSync(TARGET_DIR, { recursive: true, force: true })
  const { sourceDir, cleanup } = makeSource()
  try {
    writeSkill(sourceDir, 'demo-skill', '---\nname: demo-skill\n---\nV1')

    const targetDir = resolveSkillsDir(sourceDir, () => {})
    assert.equal(targetDir, TARGET_DIR)
    assert.equal(existsSync(join(targetDir, 'demo-skill', 'SKILL.md')), false)
    assert.equal(existsSync(join(targetDir, '.prompt-tool-manifest.json')), false)
    // 旧版行为（写 $DSH_HOME/profiles/<profile>/skills）必须已经停止。
    assert.equal(existsSync(join(home, 'profiles')), false)
  } finally {
    cleanup()
  }
})

test('resolveSkillsDir：包内容更新不会覆盖用户实体', () => {
  rmSync(TARGET_DIR, { recursive: true, force: true })
  const { sourceDir, cleanup } = makeSource()
  try {
    writeSkill(sourceDir, 'demo-skill', '---\nname: demo-skill\n---\nV1')
    const targetDir = resolveSkillsDir(sourceDir, () => {})
    mkdirSync(join(targetDir, 'demo-skill'), { recursive: true })
    writeFileSync(join(targetDir, 'demo-skill', 'SKILL.md'), 'USER-EDIT', 'utf8')
    writeSkill(sourceDir, 'demo-skill', '---\nname: demo-skill\n---\nV2-LONGER')
    resolveSkillsDir(sourceDir, () => {})
    assert.equal(readFileSync(join(targetDir, 'demo-skill', 'SKILL.md'), 'utf8'), 'USER-EDIT')
  } finally {
    cleanup()
  }
})

test('resolveSkillsDir：不创建或恢复旧 .disabled 标记', () => {
  rmSync(TARGET_DIR, { recursive: true, force: true })
  const { sourceDir, cleanup } = makeSource()
  try {
    writeSkill(sourceDir, 'demo-skill', '---\nname: demo-skill\n---\nV1')
    const targetDir = resolveSkillsDir(sourceDir, () => {})

    mkdirSync(join(targetDir, 'demo-skill'), { recursive: true })
    writeFileSync(join(targetDir, 'demo-skill', 'SKILL.md.disabled'), 'OLD', 'utf8')
    writeSkill(sourceDir, 'demo-skill', '---\nname: demo-skill\n---\nV2-LONGER')
    resolveSkillsDir(sourceDir, () => {})
    assert.equal(existsSync(join(targetDir, 'demo-skill', 'SKILL.md')), false)
    assert.equal(readFileSync(join(targetDir, 'demo-skill', 'SKILL.md.disabled'), 'utf8'), 'OLD')
  } finally {
    cleanup()
  }
})
}

// —— watcher（原 skills-watcher.test.mjs，1 条） ——
// 直接验证源码（watcher 未从 lib/index.mjs 导出），不依赖 build。
const watcherUrl = new URL('../../src/runtime/skills-watcher.ts', import.meta.url).href

test('watcher：技能目录被删除后释放句柄，进程能正常退出', () => {
  // Windows 删除被 watch 的目录会持续上报事件（实测每秒十万级）：未关闭句柄时
  // 防抖计时器被反复重置，进程永不退出（曾让 preset-default-sync 用例挂死）。
  // 该症状只在进程退出时机上可见，所以用子进程断言「删目录后能自然退出」。
  const script = `
    import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { createSkillsWatcher } from ${JSON.stringify(watcherUrl)}
    const dir = mkdtempSync(join(tmpdir(), 'pt-watch-child-'))
    mkdirSync(join(dir, 'skill-a'), { recursive: true })
    createSkillsWatcher(() => [dir], () => {}).watch()
    // 等待 OS 侧注册完成，否则删除动作可能早于 watch 生效而观察不到事件。
    await new Promise((resolve) => setTimeout(resolve, 500))
    rmSync(dir, { recursive: true, force: true })
    // 模拟长活宿主：洪泛期间仍有 ref 计时器时，未关闭的 watcher 会永远重置防抖。
    await new Promise((resolve) => setTimeout(resolve, 1500))
  `
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'pipe', timeout: 15000 })
  }, '技能目录被删除后 watcher 必须释放句柄，否则进程无法退出')
})
