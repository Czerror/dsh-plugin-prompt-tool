/** 插件的技能候选提供者：注册层屏蔽的影子候选 + 用户引用目录的自定义候选。
 *
 *  为什么单独成模块：这是整套「注册层屏蔽」的落点。影子候选以 rank 0 参与注册表的同层合并
 *  （`collectLayer` 按 rank → 注册顺序 → 层内顺序排序后，同名只保留第一个），官方候选因此被
 *  丢弃，而技能文件一个字节都不改。把候选构造与注册表解耦后，可以用真实 `SkillRegistry`
 *  对这个行为做回归，而不是只测一份替身。 */
import { join } from 'node:path'
import type { SkillCandidate, SkillDefinition, SkillLookupOptions, SkillProvider } from '@deepseek-ai/dsh-skill'
import { SKILL_BLOCK_RANK, SKILL_SOURCES, blockScopeOf, type BlockedSkill, type SkillBlockScope } from '../shared/skills.ts'
import type { ScannedSkill } from './skills-scan.ts'

/** 影子候选的描述：清单与目录里都能看出这是插件的注册层屏蔽，不是技能自身的声明。 */
export const BLOCKED_SKILL_DESCRIPTION = '已由 prompt-tool 在注册层屏蔽（未修改任何技能文件）'
export const SKILL_PROVIDER_NAME = 'prompt-tool'

/** 屏蔽记录 → 影子候选：只关被屏蔽的那一端（两端都关等于完全停用）。
 *  scope 可由调用方传入以免重复计算；'none' 在状态校验下不可达（两端都为 false 的记录会被拒绝），
 *  这里保留判断是为了让这个导出函数对任何输入都自洽。 */
export function blockedCandidate(item: BlockedSkill, scope: SkillBlockScope = blockScopeOf(item)): SkillCandidate | undefined {
  if (scope === 'none') return undefined
  return {
    name: item.name,
    description: BLOCKED_SKILL_DESCRIPTION,
    invocation: {
      modelInvocable: !(scope === 'all' || scope === 'model'),
      userInvocable: !(scope === 'all' || scope === 'user'),
    },
    source: 'prompt-tool-blocked',
    provider: SKILL_PROVIDER_NAME,
    rank: SKILL_BLOCK_RANK,
    locator: `blocked:${item.name}`,
  }
}

/** 引用目录里的技能 → 自定义来源候选（rank 300，与官方自定义档一致）。 */
export function referencedCandidate(skill: ScannedSkill): SkillCandidate {
  return {
    name: skill.name,
    description: skill.description || skill.folder,
    ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
    invocation: { modelInvocable: skill.modelInvocable, userInvocable: skill.userInvocable },
    source: 'custom',
    provider: SKILL_PROVIDER_NAME,
    resourceBase: { kind: 'directory', path: join(skill.dir, skill.folder) },
    rank: SKILL_SOURCES.custom.rank,
    locator: `folder:${skill.file}`,
    path: skill.file,
    ...(skill.metadata !== undefined ? { metadata: skill.metadata } : {}),
  }
}

export interface SkillsProviderDeps {
  /** 当前屏蔽记录（含按端范围）。 */
  blocked: () => readonly BlockedSkill[]
  /** 用户添加的技能文件夹里扫描到的技能。 */
  referenced: () => readonly ScannedSkill[]
}

export function createSkillsProvider(deps: SkillsProviderDeps): SkillProvider {
  return {
    name: SKILL_PROVIDER_NAME,
    list: async (options: SkillLookupOptions): Promise<readonly SkillCandidate[]> => {
      if (options.signal?.aborted) return []
      // 一次取值：屏蔽记录在本次 list 内保持一致，scope 也只算一次。
      const records = deps.blocked()
      const blockedNames = new Set<string>()
      const candidates: SkillCandidate[] = []
      for (const item of records) {
        blockedNames.add(item.name)
        const candidate = blockedCandidate(item)
        if (candidate !== undefined) candidates.push(candidate)
      }
      for (const skill of deps.referenced()) {
        // 被屏蔽的名字不再提供引用候选：屏蔽优先级高于引用。
        if (!skill.valid || blockedNames.has(skill.name)) continue
        candidates.push(referencedCandidate(skill))
      }
      return candidates
    },
    get: async (candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> => {
      if (options.signal?.aborted) return undefined
      // 影子候选永不加载内容：即使有人绕过调用策略直接 get，也拿不到正文。
      // 显式拒绝没有 path 的候选，不依赖「file 一定存在」这种隐式不变量去反查正文。
      if (candidate.path === undefined) return undefined
      const skill = deps.referenced().find((entry) => entry.file === candidate.path)
      if (skill === undefined || !skill.valid) return undefined
      return {
        name: candidate.name,
        description: candidate.description,
        ...(candidate.whenToUse !== undefined ? { whenToUse: candidate.whenToUse } : {}),
        invocation: candidate.invocation,
        source: candidate.source,
        provider: candidate.provider,
        ...(candidate.resourceBase !== undefined ? { resourceBase: candidate.resourceBase } : {}),
        path: candidate.path ?? skill.file,
        ...(candidate.metadata !== undefined ? { metadata: candidate.metadata } : {}),
        content: skill.body,
      }
    },
  }
}
