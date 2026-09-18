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
import { Document, isMap, isNode, isScalar, parseDocument, visit } from 'yaml'
import { SKILL_MARKER, invocationForScope, type SkillCatalogEntry, type SkillInvocation, type SkillPolicyChange, type SkillPolicyScope } from '../shared/skills.ts'
import { parseSkillBoolean } from '../runtime/skills-parse.ts'
import { assertUnlinkedPath } from './skills-actions.ts'
import { SKILL_NAME_PATTERN } from './skills-config.ts'

const BOM = '\ufeff'
/** 与 runtime/skills-parse.ts 同一套 frontmatter 边界（容忍 CRLF 与缺失尾换行）。 */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/

/** 读取兼容旧驼峰写法，写入统一为官方连字符键。 */
const MODEL_KEYS = ['disable-model-invocation', 'disableModelInvocation'] as const
const USER_KEYS = ['user-invocable', 'userInvocable'] as const

export type SkillPolicyRead =
  | { ok: true; invocation: SkillInvocation; frontmatter?: string; body?: string }
  | { ok: false; message: string }

export type SkillPolicyWrite =
  | { ok: true; changed: boolean; invocation: SkillInvocation }
  | { ok: false; message: string }

interface ParsedMarker {
  raw: string
  /** frontmatter 正文（不含 --- 行）。 */
  frontmatter: string
  /** `---` 之后的原始内容（换行 + 正文），逐字保留。 */
  rest: string
  /** 文件开头的 BOM（存在时写回）。 */
  bom: string
  doc: Document
}

/** runtime 已核对根与身份；此处继续检查文件名、所有祖先和普通可写文件。 */
function assertWritableMarker(file: string, writable = false): string {
  if (typeof file !== 'string' || file.length === 0 || !isAbsolute(file)) throw new Error('技能文件必须是绝对路径')
  const name = basename(file)
  if (name !== SKILL_MARKER && !(name.endsWith('.md') && SKILL_NAME_PATTERN.test(name.slice(0, -3)))) throw new Error(`技能文件必须是 ${SKILL_MARKER} 或合法的 <name>.md：${file}`)
  assertUnlinkedPath(file)
  const info = lstatSync(file)
  if (info.isSymbolicLink()) throw new Error(`拒绝改写符号链接技能：${file}`)
  if (!info.isFile()) throw new Error(`技能文件不是普通文件：${file}`)
  if (writable && (info.mode & 0o222) === 0) throw new Error(`技能文件只读：${file}`)
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
  return { raw, frontmatter: match[1]!, rest: source.slice(match[0].length - match[2]!.length), bom, doc: document }
}

function currentInvocation(doc: Document): SkillInvocation {
  // 键语义不同：`disable-model-invocation: true` 表示模型不可调用，`user-invocable: false` 表示用户不可调用。
  const read = (keys: readonly string[]): boolean | undefined => {
    const key = keys.find((key) => doc.has(key))
    return key === undefined ? undefined : parseSkillBoolean(doc.get(key), key)
  }
  const disabled = read(MODEL_KEYS) ?? (doc.has('modelInvocable') ? !parseSkillBoolean(doc.get('modelInvocable'), 'modelInvocable') : undefined)
  const user = read(USER_KEYS)
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

/** 保留 YAML 节点与注释，把旧策略键归一为官方键；共存的旧键必须删除。 */
function writeKey(doc: Document, keys: readonly string[], value: boolean): boolean {
  const canonical = keys[0]!
  const legacy = keys.slice(1).filter((key) => doc.has(key))
  if (legacy.length === 0 && doc.get(canonical) === value) return false
  if (!isMap(doc.contents)) throw new Error('frontmatter 必须是 YAML 映射')
  const pairs = doc.contents.items
  const pairFor = (key: string) => pairs.find((pair) => isScalar(pair.key) && pair.key.value === key)
  if (!doc.has(canonical) && legacy.length > 0) {
    const pair = pairFor(legacy.shift()!)!
    if (isScalar(pair.key)) pair.key.value = canonical
  }
  doc.set(canonical, value)
  const target = pairFor(canonical)!
  for (const key of legacy) {
    const pair = pairFor(key)!
    // 重复策略键上的说明仍是用户内容，删除键前把说明移到官方键前面。
    const comments = [pair.key, pair.value].flatMap((node) => isNode(node) ? [node.commentBefore, node.comment] : []).filter(Boolean)
    if (isScalar(target.key) && comments.length > 0) {
      target.key.commentBefore = [target.key.commentBefore, ...comments].filter(Boolean).join('\n')
    }
    doc.delete(key)
  }
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
export function setSkillInvocation(file: string, change: SkillPolicyChange | SkillPolicyScope): SkillPolicyWrite {
  let temporary: string | undefined
  try {
    const parsed = parseMarker(file)
    assertWritableMarker(file, true)
    const operation = typeof change === 'string' ? { scope: change } : change
    if (operation === null || typeof operation !== 'object'
      || ('scope' in operation ? !['none', 'model', 'user', 'all'].includes(operation.scope)
        : !['model', 'user'].includes(operation.side) || typeof operation.enabled !== 'boolean')) throw new Error('技能调用策略操作无效')
    const target = 'scope' in operation ? invocationForScope(operation.scope) : {
      ...currentInvocation(parsed.doc),
      [operation.side === 'model' ? 'modelInvocable' : 'userInvocable']: operation.enabled,
    }
    // 两个键的语义不同：`disable-model-invocation` 表达的是「禁用模型调用」，`user-invocable` 表达的是
    // 「允许用户调用」。前者必须取反写入——写成原值会让两端语义整体反转（探针实测过这个错误）。
    const modelChanged = ('scope' in operation || operation.side === 'model') && writeKey(parsed.doc, [...MODEL_KEYS, 'modelInvocable'], !target.modelInvocable)
    const userChanged = ('scope' in operation || operation.side === 'user') && writeKey(parsed.doc, USER_KEYS, target.userInvocable)
    if (!modelChanged && !userChanged) return { ok: true, changed: false, invocation: target }
    const content = `${parsed.bom}---\n${parsed.doc.toString()}---${parsed.rest}`
    temporary = join(dirname(file), `.${basename(file)}.tmp-${randomUUID()}`)
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: lstatSync(file).mode & 0o777 })
    assertWritableMarker(file, true)
    if (readFileSync(file, 'utf8') !== parsed.raw) throw new Error('技能内容版本冲突，请刷新后重试')
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
