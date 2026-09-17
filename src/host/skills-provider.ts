/** 插件的技能候选提供者：只为**用户引用的技能文件夹**提供候选。
 *
 *  为什么不再有影子候选：注册层的同名裁决是「最近层无视优先级直接胜出」（官方 `dsh-skill` 的
 *  `collectFresh` 按 `[全局层, ...scope 链]` 依次覆盖），而本插件的提供方注册在 profile/全局层、
 *  官方 `dsh-skill-filesystem` 由预设常驻组合挂在预设层，rank 0 的影子候选必然被预设层候选覆盖
 *  （真机已验证：写入屏蔽记录后模型侧仍可见）。停用因此改为改写技能文件的官方调用策略键，
 *  见 `skills-policy.ts`；本提供者只剩引用目录这一件事。
 *
 *  引用目录不在官方六类技能根里，官方提供方看不到它们，所以必须由插件提供，并自己负责失效
 *  （见 `skills-refresh.ts` 的「状态快照 + 引用来源指纹」）。 */
import { join } from 'node:path'
import type { SkillCandidate, SkillDefinition, SkillLookupOptions, SkillProvider } from '@deepseek-ai/dsh-skill'
import { SKILL_SOURCES } from '../shared/skills.ts'
import type { ScannedSkill } from './skills-scan.ts'

export const SKILL_PROVIDER_NAME = 'prompt-tool'

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
  /** 用户添加的技能文件夹里扫描到的技能。 */
  referenced: () => readonly ScannedSkill[]
}

export function createSkillsProvider(deps: SkillsProviderDeps): SkillProvider {
  return {
    name: SKILL_PROVIDER_NAME,
    list: async (options: SkillLookupOptions): Promise<readonly SkillCandidate[]> => {
      if (options.signal?.aborted) return []
      const candidates: SkillCandidate[] = []
      for (const skill of deps.referenced()) {
        if (!skill.valid) continue
        candidates.push(referencedCandidate(skill))
      }
      return candidates
    },
    get: async (candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> => {
      if (options.signal?.aborted) return undefined
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
        path: candidate.path,
        ...(candidate.metadata !== undefined ? { metadata: candidate.metadata } : {}),
        content: skill.body,
      }
    },
  }
}
