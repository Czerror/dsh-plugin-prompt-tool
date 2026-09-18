/** 引用目录的发现、解析、根恢复与监听全部复用已发布的官方 provider。 */
import type { Context } from '@deepseek-ai/cordis'
import type { SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'

export const SKILL_PROVIDER_NAME = 'prompt-tool'

export function createSkillsProvider(ctx: Context, control: SkillProviderControl, folders: readonly string[]): FileSystemSkillProvider {
  return new FileSystemSkillProvider(ctx, control, {
    providerName: SKILL_PROVIDER_NAME,
    includeDefaultRoots: false,
    customSkillDirs: [...folders],
  })
}
