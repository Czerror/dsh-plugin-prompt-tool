/** 引用目录的发现、解析、根恢复与监听全部复用已发布的官方 provider。 */
import type { Context } from '@deepseek-ai/cordis'
import type { SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'

export const SKILL_PROVIDER_NAME = 'prompt-tool'

export function createSkillsProvider(ctx: Context, control: SkillProviderControl, folders: readonly string[]): FileSystemSkillProvider {
  return new FileSystemSkillProvider(ctx, control, {
    providerName: SKILL_PROVIDER_NAME,
    // 只报引用目录，这是「官方引用 provider」的既有语义（有专门回归守着），默认根由
    // 宿主自己那层负责。插件层因此可能看不到 ~/.dsh/skills 的技能——这是被接受的：
    // 注册表只作补充、不作否决，见 skills-runtime 的 snapshot。
    includeDefaultRoots: false,
    customSkillDirs: [...folders],
  })
}
