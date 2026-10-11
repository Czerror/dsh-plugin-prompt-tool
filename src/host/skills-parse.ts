/** skills 域的 frontmatter 解析；消费方：技能清单扫描与导入。 */
import { parseDocument, isMap } from 'yaml'

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

/** 与官方 filesystem provider 相同的布尔语法；已声明的非法值不能退回默认可调用。 */
export function parseSkillBoolean(value: unknown, key: string): boolean {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    if (['true', 'yes', 'on'].includes(value.toLowerCase())) return true
    if (['false', 'no', 'off'].includes(value.toLowerCase())) return false
  }
  throw new Error(`frontmatter field "${key}" must be a boolean`)
}

// 解析 skills/*/SKILL.md 的 YAML frontmatter（name/description/whenToUse/metadata
// 与官方 disable-model-invocation / user-invocable 调用策略）。
// 使用正规 YAML 解析器，与 dsh 技能包的 filesystem provider 保持同一套字段来源。
// 边界与官方一致：开头和收尾必须是独立的 --- 行，不把 ---正文 当成结束标记。
export function parseFrontmatter(text: string): { data: SkillFrontmatter; body: string; issue?: string } {
  const source = text
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)
  if (!match) return { data: {}, body: source, issue: 'frontmatter 缺失或边界无效' }
  const data: SkillFrontmatter = {}
  let doc: Record<string, unknown>
  try {
    const document = parseDocument(match[1]!)
    if (document.errors.length > 0) throw document.errors[0]
    if (!isMap(document.contents)) throw new Error('frontmatter 必须是 YAML 映射')
    doc = document.toJS() as Record<string, unknown>
    for (const [legacy, canonical] of [['disableModelInvocation', 'disable-model-invocation'], ['modelInvocable', 'disable-model-invocation'], ['userInvocable', 'user-invocable']]) {
      if (Object.hasOwn(doc, legacy!)) throw new Error(`frontmatter field "${legacy}" is unsupported; use "${canonical}"`)
    }
    if (Object.hasOwn(doc, 'disable-model-invocation')) data.disableModelInvocation = parseSkillBoolean(doc['disable-model-invocation'], 'disable-model-invocation')
    if (Object.hasOwn(doc, 'user-invocable')) data.userInvocable = parseSkillBoolean(doc['user-invocable'], 'user-invocable')
  } catch (error) {
    return { data, body: source.slice(match[0].length), issue: `frontmatter 解析失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (doc !== null && typeof doc === 'object') {
    if (typeof doc.name === 'string') data.name = doc.name
    if (typeof doc.description === 'string') data.description = doc.description
    if (typeof doc.whenToUse === 'string') data.whenToUse = doc.whenToUse
    if (doc.metadata !== null && typeof doc.metadata === 'object' && !Array.isArray(doc.metadata)) {
      data.metadata = doc.metadata as Record<string, unknown>
    }
  }
  return { data, body: source.slice(match[0].length) }
}
