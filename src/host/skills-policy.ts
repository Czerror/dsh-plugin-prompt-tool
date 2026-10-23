/** 技能调用策略写入：唯一真相是技能文件自己的 frontmatter。
 *
 *  为什么是文件层：注册层的同名裁决是「最近层无视优先级直接胜出」，本插件的提供方在全局层、
 *  官方文件提供方在预设层，注册层写入必然被覆盖（真机已验证）。改写官方两个调用策略键后，
 *  任何预设装配、任何提供方都会读到同一个事实。
 *
 *  写入纪律：只用 yaml Document API 改目标键，保留注释、未知字段、其余键与正文；
 *  内容无变化不落盘；写盘先同目录暂存再原子 rename；失败时原文件保持逐字节不变。
 *  替换与替换前再核归 `host/versioned-text.ts`；暂存/清理/权限仍归 `host/text-file.ts`。 */
import { createHash } from 'node:crypto'
import { Document } from 'yaml'
import { MAX_SKILL_CONTENT_BYTES, invocationForScope, type SkillCatalogEntry, type SkillInvocation, type SkillPolicyChange, type SkillPolicyScope } from '../shared/skills.ts'
import { parseSkillBoolean } from './skills-parse.ts'
import { readSkillMarker } from './skills-marker.ts'
import { replaceVersionedText } from './versioned-text.ts'

export type SkillPolicyRead =
  | { ok: true; invocation: SkillInvocation; frontmatter?: string; body?: string }
  | { ok: false; message: string }

export type SkillPolicyWrite =
  | { ok: true; changed: boolean; invocation: SkillInvocation }
  | { ok: false; message: string }

const revisionOf = (value: string): string => createHash('sha256').update(value).digest('hex')

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

/** runtime 已核对根与身份；文件级校验与解析走 `readSkillMarker` 同一份。 */
function parseMarker(file: string, writable = false): ParsedMarker {
  const { raw, parse } = readSkillMarker(file, { writable })
  if (!parse.ok) throw new Error(`${parse.issue}：${file}`)
  const parsed = parse.source
  return {
    raw, frontmatter: parsed.frontmatter, bom: parsed.bom, doc: parsed.doc,
    // `---` 之后的全部原文（逐字保留）：写回时直接接在收尾 `---` 后。
    rest: parsed.boundaries.tail,
  }
}

function currentInvocation(doc: Document): SkillInvocation {
  // 键语义不同：`disable-model-invocation: true` 表示模型不可调用，`user-invocable: false` 表示用户不可调用。
  const read = (key: string): boolean | undefined => doc.has(key) ? parseSkillBoolean(doc.get(key), key) : undefined
  const disabled = read('disable-model-invocation')
  const user = read('user-invocable')
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

/** 只改官方策略键，保留 YAML 节点与注释。 */
function writeKey(doc: Document, key: string, value: boolean): boolean {
  if (doc.get(key) === value) return false
  doc.set(key, value)
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
  try {
    const parsed = parseMarker(file, true)
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
    const modelChanged = ('scope' in operation || operation.side === 'model') && writeKey(parsed.doc, 'disable-model-invocation', !target.modelInvocable)
    const userChanged = ('scope' in operation || operation.side === 'user') && writeKey(parsed.doc, 'user-invocable', target.userInvocable)
    if (!modelChanged && !userChanged) return { ok: true, changed: false, invocation: target }
    const content = `${parsed.bom}---\n${parsed.doc.toString()}---${parsed.rest}`
    // 读侧只保证原文件不超限；改写可能追加键，写产物必须再查一次，否则会写出自己读不了的文件。
    if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_CONTENT_BYTES) throw new Error('技能文件不能超过 1 MiB')
    replaceVersionedText({
      file,
      expectedRevision: revisionOf(parsed.raw),
      read: () => {
        const current = readSkillMarker(file, { writable: true })
        return { revision: revisionOf(current.raw), value: current.raw, text: current.raw }
      },
      prepare: () => content,
      recheck: current => {
        if (current !== parsed.raw) throw new Error('技能内容版本冲突，请刷新后重试')
      },
      conflict: () => new Error('技能内容版本冲突，请刷新后重试'),
    })
    return { ok: true, changed: true, invocation: target }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
