/** 注册层屏蔽的行为回归：影子候选必须真的把官方候选压掉。
 *
 *  这里用**真实** `SkillRegistry`，不是替身：整套机制成立与否完全取决于注册表的合并规则
 *  （同一层内按 rank → 注册顺序 → 层内顺序排序后，同名只保留第一个）。自造一份合并逻辑
 *  就等于自证，测不出 rank 取值是否选对。
 *
 *  同时锁住另外三件容易退化的事：按端只关被屏蔽的那一端、影子候选永不返回正文、
 *  以及「rank 0 是前提」——rank 250 的对照必须压不过官方候选。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry, isModelInvocable, isUserInvocable } from '@deepseek-ai/dsh-skill'
import { BLOCKED_SKILL_DESCRIPTION, blockedCandidate, createSkillsProvider, referencedCandidate } from '../../src/host/skills-provider.ts'
import { SKILL_BLOCK_RANK, SKILL_SOURCES, blockRecordFor } from '../../src/shared/skills.ts'

const AT = '2026-09-17T00:00:00.000Z'

/** 官方文件提供者的候选替身：默认用户根优先级，正文可加载。 */
const officialCandidate = (name, rank = SKILL_SOURCES['user-dsh'].rank) => ({
  name,
  description: `${name} 的官方候选`,
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'user-dsh',
  provider: 'dsh-skill-filesystem',
  rank,
  locator: `official:${name}`,
  path: `D:/skills/${name}/SKILL.md`,
})

/** 引用目录扫描结果的替身（形状与 skills-scan 的 ScannedSkill 一致）。 */
const referencedSkill = (name, overrides = {}) => ({
  id: `custom:D:/referenced:${name}`,
  name,
  folder: name,
  dir: 'D:/referenced',
  file: `D:/referenced/${name}/SKILL.md`,
  valid: true,
  description: `${name} 的引用候选`,
  modelInvocable: true,
  userInvocable: true,
  body: `# ${name} 正文`,
  ...overrides,
})

/** 真实注册表 + 官方替身 + 被测 provider。 */
function makeRegistry(officialCandidates, deps, providerName = 'dsh-skill-filesystem') {
  const registry = new SkillRegistry(new Context())
  registry.registerProvider(() => ({
    name: providerName,
    list: async () => officialCandidates,
    get: async (candidate) => ({ ...candidate, content: `正文：${candidate.name}` }),
  }))
  registry.registerProvider(() => createSkillsProvider(deps))
  return registry
}

const winnerOf = async (registry, name) => (await registry.list()).find((skill) => skill.name === name)

test('影子候选压过官方全部六档优先级，并且永不返回正文', async () => {
  for (const rank of [100, 200, 300, 400, 500, 600]) {
    const registry = makeRegistry([officialCandidate('demo-skill', rank)], {
      blocked: () => [blockRecordFor('demo-skill', 'all', AT)],
      referenced: () => [],
    })
    const winner = await winnerOf(registry, 'demo-skill')
    assert.equal(winner.provider, 'prompt-tool', `rank ${rank} 的官方候选被 rank ${SKILL_BLOCK_RANK} 的影子压掉`)
    assert.equal(winner.description, BLOCKED_SKILL_DESCRIPTION, '胜出的是影子候选，不是官方候选')
    assert.equal(isModelInvocable(winner), false, '两端屏蔽后模型目录看不到它')
    assert.equal(isUserInvocable(winner), false, '两端屏蔽后用户调用不到它')
    assert.equal(await registry.get('demo-skill'), undefined, '影子候选只压名字，绝不加载正文')
  }
})

test('对照：同名裁决按 rank 升序，影子取 0 才能压过全部六档', async () => {
  const winnerAgainst = async (officialRank) => {
    const registry = new SkillRegistry(new Context())
    registry.registerProvider(() => ({
      name: 'dsh-skill-filesystem',
      list: async () => [officialCandidate('demo-skill', officialRank)],
      get: async (candidate) => ({ ...candidate, content: `正文：${candidate.name}` }),
    }))
    registry.registerProvider(() => ({
      name: 'prompt-tool',
      list: async () => [{ ...blockedCandidate(blockRecordFor('demo-skill', 'all', AT)), rank: 250 }],
      get: async () => undefined,
    }))
    return winnerOf(registry, 'demo-skill')
  }

  // rank 更小者胜出：250 压得过用户档 400，却压不过项目档 100。
  assert.equal((await winnerAgainst(SKILL_SOURCES['user-dsh'].rank)).provider, 'prompt-tool')
  assert.equal((await winnerAgainst(SKILL_SOURCES['project-dsh'].rank)).provider, 'dsh-skill-filesystem')
  assert.ok(SKILL_BLOCK_RANK < SKILL_SOURCES['project-dsh'].rank, '影子取 0 才能压过最低的项目档')
})

test('按端屏蔽只关闭被屏蔽的那一端', async () => {
  const cases = [
    ['model', false, true],
    ['user', true, false],
    ['all', false, false],
  ]
  for (const [scope, model, user] of cases) {
    const registry = makeRegistry([officialCandidate('demo-skill')], {
      blocked: () => [blockRecordFor('demo-skill', scope, AT)],
      referenced: () => [],
    })
    const winner = await winnerOf(registry, 'demo-skill')
    assert.equal(winner.provider, 'prompt-tool', `scope=${scope} 时影子胜出`)
    assert.equal(isModelInvocable(winner), model, `scope=${scope} 的模型端可调用性`)
    assert.equal(isUserInvocable(winner), user, `scope=${scope} 的用户端可调用性`)
  }
})

test('屏蔽表为空时提供者不产生候选，官方候选照常胜出', async () => {
  const registry = makeRegistry([officialCandidate('demo-skill')], { blocked: () => [], referenced: () => [] })
  const winner = await winnerOf(registry, 'demo-skill')
  assert.equal(winner.provider, 'dsh-skill-filesystem')
  assert.equal((await registry.get('demo-skill')).content, '正文：demo-skill')
})

test('屏蔽一个名字不牵连其他技能', async () => {
  const registry = makeRegistry([officialCandidate('demo-skill'), officialCandidate('other-skill')], {
    blocked: () => [blockRecordFor('demo-skill', 'all', AT)],
    referenced: () => [],
  })
  const list = await registry.list()
  assert.equal(list.find((skill) => skill.name === 'demo-skill').provider, 'prompt-tool')
  assert.equal(list.find((skill) => skill.name === 'other-skill').provider, 'dsh-skill-filesystem')
  assert.equal((await registry.get('other-skill')).content, '正文：other-skill')
})

test('引用目录候选按自定义优先级提供并可加载正文', async () => {
  const registry = makeRegistry([], { blocked: () => [], referenced: () => [referencedSkill('ref-skill')] })
  const winner = await winnerOf(registry, 'ref-skill')
  assert.equal(winner.provider, 'prompt-tool')
  assert.equal(winner.source, 'custom')
  // 清单摘要不带 rank（rank 只参与候选合并），所以优先级直接对候选构造函数断言。
  assert.equal(referencedCandidate(referencedSkill('ref-skill')).rank, SKILL_SOURCES.custom.rank)
  const loaded = await registry.get('ref-skill')
  assert.equal(loaded.content, '# ref-skill 正文')
  assert.equal(loaded.resourceBase.path, join('D:/referenced', 'ref-skill'))
})

test('被屏蔽的名字不再提供引用候选，屏蔽优先级高于引用', async () => {
  const registry = makeRegistry([], {
    blocked: () => [blockRecordFor('ref-skill', 'user', AT)],
    referenced: () => [referencedSkill('ref-skill')],
  })
  const winner = await winnerOf(registry, 'ref-skill')
  assert.equal(winner.description, BLOCKED_SKILL_DESCRIPTION, '引用候选被同名的影子挡掉')
  assert.equal(isUserInvocable(winner), false)
  assert.equal(await registry.get('ref-skill'), undefined)
})

test('无效的引用技能不产生候选', async () => {
  const registry = makeRegistry([], {
    blocked: () => [],
    referenced: () => [referencedSkill('broken-skill', { valid: false })],
  })
  assert.deepEqual(await registry.list(), [])
})
