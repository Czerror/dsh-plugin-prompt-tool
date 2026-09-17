/** 技能调用策略写入：唯一真相是技能文件自己的 frontmatter。
 *
 *  为什么是文件层：注册层的同名裁决是「最近层无视优先级直接胜出」，本插件的提供方在全局层、
 *  官方文件提供方在预设层，注册层写入必然被覆盖（真机已验证）。改写官方两个调用策略键后，
 *  任何预设装配、任何提供方都会读到同一个事实。
 *
 *  写入纪律：只用 yaml Document API 改目标键，保留注释、未知字段、其余键与正文；
 *  内容无变化不落盘；写盘先同目录暂存再原子 rename；失败时原文件保持逐字节不变。 */
import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { isAbsolute } from 'node:path'
import { Document, isMap, parseDocument, visit } from 'yaml'
import { SKILL_MARKER, invocationForScope, type SkillCatalogEntry, type SkillInvocation, type SkillPolicyScope } from '../shared/skills.ts'

const BOM = '\ufeff'
/** 与 runtime/skills-parse.ts 同一套 frontmatter 边界（容忍 CRLF 与缺失尾换行）。 */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/

/** 官方键与历史驼峰写法：已有哪个就改哪个，都没有才新增官方连字符键。 */
const MODEL_KEYS = ['disable-model-invocation', 'disableModelInvocation'] as const
const USER_KEYS = ['user-invocable', 'userInvocable'] as const

export type SkillPolicyRead =
  | { ok: true; invocation: SkillInvocation; frontmatter?: string; body?: string }
  | { ok: false; message: string }

export type SkillPolicyWrite =
  | { ok: true; changed: boolean; invocation: SkillInvocation }
  | { ok: false; message: string }

interface ParsedMarker {
  /** frontmatter 正文（不含 --- 行）。 */
  frontmatter: string
  /** `---` 之后的原始内容（换行 + 正文），逐字保留。 */
  rest: string
  /** 文件开头的 BOM（存在时写回）。 */
  bom: string
  doc: Document
}

/** 校验写入目标：绝对路径、名为 SKILL.md、存在、普通文件（拒绝符号链接以免写到根外）。 */
function assertWritableMarker(file: string): string {
  if (typeof file !== 'string' || file.length === 0 || !isAbsolute(file)) throw new Error('技能文件必须是绝对路径')
  if (basename(file) !== SKILL_MARKER) throw new Error(`技能文件必须以 ${SKILL_MARKER} 结尾：${file}`)
  const info = lstatSync(file)
  if (info.isSymbolicLink()) throw new Error(`拒绝改写符号链接技能：${file}`)
  if (!info.isFile()) throw new Error(`技能文件不是普通文件：${file}`)
  return file
}

/** 解析技能文件的 frontmatter；任何异常都以失败载荷返回，由调用方决定如何报告。 */
function parseMarker(file: string): ParsedMarker {
  assertWritableMarker(file)
  const raw = readFileSync(file, 'utf8')
  const bom = raw.startsWith(BOM) ? BOM : ''
  const source = bom.length > 0 ? raw.slice(1) : raw
  const match = FRONTMATTER.exec(source)
  if (match === null) throw new Error(`技能文件缺少 frontmatter：${file}`)
  const document = parseDocument(match[1]!)
  if (document.errors.length > 0) throw new Error(`frontmatter 不是合法 YAML：${document.errors[0]?.message ?? '解析失败'}`)
  if (!isMap(document.contents)) throw new Error('frontmatter 必须是 YAML 映射')
  visit(document, { Alias() { throw new Error('frontmatter 不支持 YAML 别名') } })
  return { frontmatter: match[1]!, rest: source.slice(match[0].length - match[2]!.length), bom, doc: document }
}

/** 归一已声明的值：只认布尔；官方接受的 yes/no/on/off/1/0 等写法由官方 provider 解释，
 *  本插件在写入时统一写成规范布尔值。 */
const asBoolean = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)

function currentInvocation(doc: Document): SkillInvocation {
  // 键语义不同：`disable-model-invocation: true` 表示模型不可调用，`user-invocable: false` 表示用户不可调用。
  const disabled = MODEL_KEYS.map((key) => asBoolean(doc.get(key))).find((value) => value !== undefined)
  const user = USER_KEYS.map((key) => asBoolean(doc.get(key))).find((value) => value !== undefined)
  return { modelInvocable: disabled !== true, userInvocable: user !== false }
}

/** 读取技能文件当前的调用策略（缺省即可调用）。 */
export function readSkillInvocation(file: string): SkillPolicyRead {
  try {
    const parsed = parseMarker(file)
    return { ok: true, invocation: currentInvocation(parsed.doc), frontmatter: parsed.frontmatter, body: parsed.rest }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 写入一个键：已有键（含驼峰写法）就地改写，都没有才新增官方连字符键。
 *  返回是否真的变化，供「内容无变化不落盘」判定。 */
function writeKey(doc: Document, keys: readonly string[], value: boolean): boolean {
  for (const key of keys) {
    const existing = asBoolean(doc.get(key))
    if (existing === value) return false
    if (doc.has(key)) {
      doc.set(key, value)
      return true
    }
  }
  doc.set(keys[0]!, value)
  return true
}

/** 身份校验：提交的 `path` 必须命中当次清单里**同名且同路径**的有效条目。
 *  界面加载后被替换 / 改名的同名技能、伪造路径都在这里被拒绝——端点因此不必信任客户端，
 *  也不必把这条规则留在闭包里（放在这里是为了能用真实实现做回归，而不是只测一份替身）。 */
export function policyTarget(
  catalog: readonly Pick<SkillCatalogEntry, 'name' | 'path' | 'valid' | 'issue'>[],
  name: string,
  path: string,
): { ok: true } | { ok: false; message: string } {
  const fresh = catalog.find((entry) => entry.name === name && entry.path === path)
  if (fresh === undefined) return { ok: false, message: `技能已变化，请刷新后重试：${name}` }
  if (!fresh.valid) return { ok: false, message: `技能无效，无法写入调用策略：${fresh.issue ?? name}` }
  return { ok: true }
}

/** 把技能文件的调用策略写到目标范围；返回是否发生写入。 */
export function setSkillInvocation(file: string, scope: SkillPolicyScope): SkillPolicyWrite {
  let temporary: string | undefined
  try {
    const parsed = parseMarker(file)
    const target = invocationForScope(scope)
    // 两个键的语义不同：`disable-model-invocation` 表达的是「禁用模型调用」，`user-invocable` 表达的是
    // 「允许用户调用」。前者必须取反写入——写成原值会让两端语义整体反转（探针实测过这个错误）。
    const modelChanged = writeKey(parsed.doc, MODEL_KEYS, !target.modelInvocable)
    const userChanged = writeKey(parsed.doc, USER_KEYS, target.userInvocable)
    if (!modelChanged && !userChanged) return { ok: true, changed: false, invocation: target }
    const content = `${parsed.bom}---\n${parsed.doc.toString()}---${parsed.rest}`
    temporary = join(dirname(file), `.${basename(file)}.tmp-${randomUUID()}`)
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' })
    renameSync(temporary, file)
    temporary = undefined
    return { ok: true, changed: true, invocation: target }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    if (temporary !== undefined && existsSync(temporary)) {
      try { unlinkSync(temporary) } catch { /* 残留暂存文件不影响原文件，交给人工清理 */ }
    }
  }
}
