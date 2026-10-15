/**
 * skills 域的 frontmatter 解析——**唯一一份**。
 *
 * 消费方五处（清单扫描、导入、删除、内容读写、策略写入）此前各自带一套边界正则、"必须是 YAML
 * 映射"检查与 legacy 键名单，而且已经分叉：只有本文件不容忍 BOM（带 BOM 的技能因此「清单判无效、
 * 编辑器却能读写、保存也不消除 BOM」），本文件也没有 YAML 别名检查。现在合法性判定只在这里。
 *
 * 口径：**读时剥 BOM、写回保留**（`bom` 随产物返回，调用方按 `bom + open + frontmatter + close + body`
 * 逐字还原）；含 YAML 别名的文件四侧一致拒绝（别名会让「保留注释改写」出错）。
 */
import { parseDocument, isMap, visit, type Document } from 'yaml'

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

/** 一份解析的产物：给**语义化字段**，不让调用方各自 slice 边界。 */
export interface SkillFrontmatterSource {
  /** YAML Document（保留注释与格式，供写回时改写）。 */
  doc: Document
  /** 规范化后的声明（解析只做类型收窄，不猜业务语义）。 */
  declared: SkillFrontmatter
  /** 原始文本，逐字（含 BOM）。 */
  raw: string
  /** 文件开头的 BOM（无则空串）；写回时原样保留。 */
  bom: string
  /** frontmatter 段正文（不含 `---` 行与 BOM）。 */
  frontmatter: string
  /** 正文（收尾 `---` 行之后的内容）。 */
  body: string
  /**
   * 边界原文。还原规则：`bom + open + frontmatter + close + tail` ≡ `raw`（逐字）。
   * `close` 是收尾的 `\r?\n---`（不含其后的换行），`tail` 是 `---` **之后**的一切。
   */
  boundaries: {
    open: string
    close: string
    /** 收尾 `---` 之后要逐字保留的全部原文（含其后的换行；文件以 `---` 收尾时即正文本身）。 */
    tail: string
  }
}

export type SkillFrontmatterParse = { ok: true; source: SkillFrontmatterSource } | { ok: false; issue: string }

const BOM = '\ufeff'
/** 边界：开头与收尾都是独立的 `---` 行（容忍 CRLF 与缺失尾换行）；BOM 在匹配前剥掉。 */
const FRONTMATTER = /^(---\r?\n)([\s\S]*?)(\r?\n---)(\r?\n|$)/
/** 已退役的驼峰键与它们的官方写法。 */
const LEGACY_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['disableModelInvocation', 'disable-model-invocation'],
  ['modelInvocable', 'disable-model-invocation'],
  ['userInvocable', 'user-invocable'],
]

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
export function parseFrontmatter(text: string): SkillFrontmatterParse {
  const source = typeof text === 'string' ? text : ''
  const bom = source.startsWith(BOM) ? BOM : ''
  const body = bom.length > 0 ? source.slice(1) : source
  const match = FRONTMATTER.exec(body)
  if (match === null) return { ok: false, issue: 'frontmatter 缺失或边界无效' }
  const open = match[1]!
  const frontmatter = match[2]!
  const close = match[3]!
  const bodyText = body.slice(match[0].length)
  const tail = match[4]! + bodyText
  let doc: Document
  let declared: SkillFrontmatter = {}
  try {
    doc = parseDocument(frontmatter)
    if (doc.errors.length > 0) throw doc.errors[0]
    if (!isMap(doc.contents)) throw new Error('frontmatter 必须是 YAML 映射')
    visit(doc, { Alias() { throw new Error('frontmatter 不支持 YAML 别名') } })
    for (const [legacy, canonical] of LEGACY_KEYS) {
      if (doc.has(legacy)) throw new Error(`frontmatter field "${legacy}" is unsupported; use "${canonical}"`)
    }
    declared = declaredOf(doc)
  } catch (error) {
    return { ok: false, issue: `frontmatter 解析失败：${error instanceof Error ? error.message : String(error)}` }
  }
  return {
    ok: true,
    source: { doc, declared, raw: source, bom, frontmatter, body: bodyText, boundaries: { open, close, tail } },
  }
}

/** 把原始键收窄成声明形态；未声明或类型不符的键一律不出现（不猜、不补默认）。 */
function declaredOf(doc: Document): SkillFrontmatter {
  const declared: SkillFrontmatter = {}
  if (doc.has('disable-model-invocation')) declared.disableModelInvocation = parseSkillBoolean(doc.get('disable-model-invocation'), 'disable-model-invocation')
  if (doc.has('user-invocable')) declared.userInvocable = parseSkillBoolean(doc.get('user-invocable'), 'user-invocable')
  const raw = doc.toJS() as Record<string, unknown> | null
  if (raw === null || typeof raw !== 'object') return declared
  if (typeof raw.name === 'string') declared.name = raw.name
  if (typeof raw.description === 'string') declared.description = raw.description
  if (typeof raw.whenToUse === 'string') declared.whenToUse = raw.whenToUse
  if (raw.metadata !== null && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)) {
    declared.metadata = raw.metadata as Record<string, unknown>
  }
  return declared
}
