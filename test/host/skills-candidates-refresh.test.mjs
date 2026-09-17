/** 引用目录变化 → 模型侧候选刷新的端到端回归。
 *
 *  为什么需要它：`skills-refresh.test.mjs` 把候选指纹做成测试常量，只能证明 reloader 的契约
 *  （指纹变 ⇒ 失效候选）。真正「往引用目录里放一个新技能，模型侧就能看到」牵涉四者协作：
 *  引用目录扫描（带指纹缓存）、reloader 的分流、插件 provider 产出的候选、官方注册表的合并与缓存。
 *  这里把它们接成真实装配跑一遍——把 `invalidateCandidates` 换成 no-op 时，本文件必须失败。 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { createSkillsProvider } from '../../src/host/skills-provider.ts'
import { createSkillsReloader } from '../../src/host/skills-refresh.ts'
import { rootsFingerprint, scanRoot } from '../../src/host/skills-scan.ts'
import { readSkillsState, writeSkillsState } from '../../src/host/skills-config.ts'

const tempDirs = []
after(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }) })

function makeRig(useInvalidate) {
  const root = mkdtempSync(join(tmpdir(), 'pt-candidates-'))
  tempDirs.push(root)
  const referenceDir = join(root, 'referenced')
  const stateFile = join(root, '.system', 'prompt-tool', 'skills.yml')
  mkdirSync(referenceDir, { recursive: true })
  writeSkillsState({ folders: [referenceDir] }, stateFile)

  const registry = new SkillRegistry(new Context())
  const referencedRoots = () => [{ kind: 'custom', path: referenceDir }]
  const fingerprint = () => rootsFingerprint(referencedRoots())
  let referencedCache
  const scanReferenced = () => {
    const key = fingerprint()
    if (referencedCache !== undefined && referencedCache.key === key) return referencedCache.skills
    const skills = referencedRoots().flatMap((root_) => scanRoot(root_))
    referencedCache = { key, skills }
    return skills
  }
  let control
  registry.registerProvider((providerControl) => {
    control = providerControl
    return createSkillsProvider({ blocked: () => [], referenced: scanReferenced })
  })

  let snapshot = JSON.stringify(readSkillsState(stateFile).state)
  const reloader = createSkillsReloader({
    stateFile,
    currentSnapshot: () => snapshot,
    accept: (_state, next) => { snapshot = next },
    rewatch: () => {},
    invalidateList: () => {},
    // 负向对照：不失效候选缓存，等价于「只看状态快照」的旧分流。
    invalidateCandidates: () => { if (useInvalidate) { referencedCache = undefined; control.invalidate() } },
    warn: () => {},
  })
  return { registry, reloader, referenceDir }
}

const writeReferencedSkill = (dir, name, description = `${name} 描述`) => {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n正文\n`, 'utf8')
}

const namesOf = async (registry) => (await registry.list()).map((skill) => skill.name)

test('引用目录里新增技能后，注册表候选立刻出现它', async () => {
  const { registry, reloader, referenceDir } = makeRig(true)
  assert.deepEqual(await namesOf(registry), [], '引用目录为空时没有候选')
  writeReferencedSkill(referenceDir, 'late-skill')
  reloader.reload()
  assert.deepEqual(await namesOf(registry), ['late-skill'], '模型侧必须能看到刚放进引用目录的技能')
  assert.equal((await registry.get('late-skill')).content.includes('正文'), true, '正文按需从磁盘读取')
})

test('对照：不失效候选缓存时新技能看不到（说明这次失效是必需的）', async () => {
  const { registry, reloader, referenceDir } = makeRig(false)
  // 先查一次建立「空候选」缓存：否则首次 list() 本来就会重新扫描，对照就失去意义。
  assert.deepEqual(await namesOf(registry), [])
  writeReferencedSkill(referenceDir, 'late-skill')
  reloader.reload()
  assert.deepEqual(await namesOf(registry), [], '这正是第三轮修复前的症状：界面有、模型没有')
})

test('改写引用技能的描述后，候选里的描述随之更新', async () => {
  const { registry, reloader, referenceDir } = makeRig(true)
  writeReferencedSkill(referenceDir, 'demo-skill', '旧描述')
  reloader.reload()
  assert.equal((await registry.list()).find((skill) => skill.name === 'demo-skill').description, '旧描述')

  writeReferencedSkill(referenceDir, 'demo-skill', '新描述')
  reloader.reload()
  assert.equal((await registry.list()).find((skill) => skill.name === 'demo-skill').description, '新描述')
})

test('删除引用目录里的技能后，候选里不再有它', async () => {
  const { registry, reloader, referenceDir } = makeRig(true)
  writeReferencedSkill(referenceDir, 'demo-skill')
  reloader.reload()
  assert.deepEqual(await namesOf(registry), ['demo-skill'])

  rmSync(join(referenceDir, 'demo-skill'), { recursive: true, force: true })
  reloader.reload()
  assert.deepEqual(await namesOf(registry), [])
})
