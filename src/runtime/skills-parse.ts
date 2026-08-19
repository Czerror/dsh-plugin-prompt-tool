/** skills 域的 frontmatter 解析（从 preset-core 兼容层归位；消费方：skills-provider / skill-fix）。 */
import { parse as parseYaml } from 'yaml'

export interface SkillFrontmatter {
  name?: string
  description?: string
  whenToUse?: string
  metadata?: Record<string, unknown>
  /** 官方调用策略：true 时模型不可发现/不可加载（默认 false = 可调用）。 */
  disableModelInvocation?: boolean
  /** 官方调用策略：false 时用户命令不可加载（默认 true）。 */
  userInvocable?: boolean
}

const asBoolean = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)

// 解析 skills/*/SKILL.md 的 YAML frontmatter（name/description/whenToUse/metadata
// 与官方 disable-model-invocation / user-invocable 调用策略）。
// 使用正规 YAML 解析器，与 dsh 技能包的 filesystem provider 保持同一套字段来源。
// 容忍 UTF-8 BOM：Windows 记事本保存的文件会在 --- 前写入 EF BB BF，
// 不剥离会导致整个 frontmatter 匹配失败。
export function parseFrontmatter(text: string): { data: SkillFrontmatter; body: string } {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  if (!match) return { data: {}, body: source }
  const data: SkillFrontmatter = {}
  const doc = parseYaml(match[1]!, { logLevel: 'silent' }) as Record<string, unknown> | null
  if (doc !== null && typeof doc === 'object') {
    if (typeof doc.name === 'string') data.name = doc.name
    if (typeof doc.description === 'string') data.description = doc.description
    if (typeof doc.whenToUse === 'string') data.whenToUse = doc.whenToUse
    if (doc.metadata !== null && typeof doc.metadata === 'object') {
      data.metadata = doc.metadata as Record<string, unknown>
    }
    // 接受官方连字符字段与旧版驼峰字段；布尔语义与官方 filesystem provider 一致。
    const disable = asBoolean(doc['disable-model-invocation']) ?? asBoolean(doc.disableModelInvocation)
    if (disable !== undefined) data.disableModelInvocation = disable
    const userInvocable = asBoolean(doc['user-invocable']) ?? asBoolean(doc.userInvocable)
    if (userInvocable !== undefined) data.userInvocable = userInvocable
  }
  return { data, body: source.slice(match[0].length) }
}
