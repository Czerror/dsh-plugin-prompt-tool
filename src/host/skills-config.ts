/** skills/.system/skills.yml 是受管技能状态的唯一来源。 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { Document, isMap, parseDocument, visit } from 'yaml'
import type { ManagedSkillState } from '../shared/skills.ts'
import { DEFAULT_SKILL_RANK_BASE, DSH_HOME } from './paths.ts'

export const SKILLS_CONFIG_RELATIVE = join('skills', '.system', 'skills.yml')
export const SKILLS_CONFIG_VERSION = 2

export interface SkillsConfig {
  dirs: string[]
  order: string[]
  rankBase: number
  skills: Record<string, ManagedSkillState>
}

export type SkillsConfigRead =
  | { ok: true; config: SkillsConfig; exists: boolean }
  | { ok: false; config: SkillsConfig; message: string }

/** 记录容器不带原型：`constructor` / `prototype` 等 Object.prototype 上的名字是合法技能名，
 *  带原型容器会把 `config.skills['constructor']` 误读成继承属性而不是「不存在」。 */
const emptySkills = (): Record<string, ManagedSkillState> => Object.create(null) as Record<string, ManagedSkillState>

export function defaultSkillsConfig(): SkillsConfig {
  return { dirs: [], order: [], rankBase: DEFAULT_SKILL_RANK_BASE, skills: emptySkills() }
}

/** 深拷贝配置并保留无原型记录容器；`structuredClone` 会退回 `Object.prototype`，不能用于此处。 */
export function cloneSkillsConfig(config: SkillsConfig): SkillsConfig {
  const skills = emptySkills()
  for (const [id, record] of Object.entries(config.skills)) skills[id] = { ...record }
  return { dirs: [...config.dirs], order: [...config.order], rankBase: config.rankBase, skills }
}

export function skillsConfigPath(dshHome: string = DSH_HOME): string {
  return join(dshHome, SKILLS_CONFIG_RELATIVE)
}

/** 每段都必须是普通目录名；拒绝 Windows 盘符、设备名及隐藏管理目录。 */
export function isSafeSkillPath(value: unknown, single = false): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || value.includes('\\')) return false
  const parts = value.split('/')
  return (!single || parts.length === 1) && parts.every((part) =>
    part.length > 0 && !part.startsWith('.') && !/[<>:"|?*]/u.test(part)
    && ![...part].some((character) => character.charCodeAt(0) < 32)
    && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))
}

function stringList(value: unknown, key: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw new Error(`${key} 必须是非空字符串数组`)
  }
  return value as string[]
}

/** 写入与读取共用验证，避免非法 YAML 状态获得文件系统写入权限。 */
export function validateSkillsConfig(value: unknown): SkillsConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('技能配置必须是 YAML 映射')
  const data = value as Record<string, unknown>
  if (data.version !== undefined && data.version !== SKILLS_CONFIG_VERSION) throw new Error('不支持的技能配置版本')
  const rankBase = data.rankBase === undefined ? DEFAULT_SKILL_RANK_BASE : data.rankBase
  if (typeof rankBase !== 'number' || !Number.isSafeInteger(rankBase) || rankBase < 0) throw new Error('rankBase 必须是非负安全整数')
  const records = data.skills === undefined ? {} : data.skills
  if (records === null || typeof records !== 'object' || Array.isArray(records)) throw new Error('skills 必须是 YAML 映射')
  const skills: Record<string, ManagedSkillState> = emptySkills()
  const paths = new Set<string>()
  const links = new Set<string>()
  for (const [id, value] of Object.entries(records)) {
    // `__proto__` 在对象字面量与 JSON 往返中会改写原型，仍然拒绝；
    // `constructor` / `prototype` 是普通技能名，容器无原型即可安全承载。
    if (!isSafeSkillPath(id) || id === '__proto__') throw new Error(`技能身份不合法：${id}`)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`技能 ${id} 必须是 YAML 映射`)
    const item = value as Record<string, unknown>
    if (!isSafeSkillPath(item.path) || !isSafeSkillPath(item.link, true)) throw new Error(`技能 ${id} 的实体或链接路径不合法`)
    if (['enabled', 'modelInvocable', 'userInvocable'].some((key) => typeof item[key] !== 'boolean')) {
      throw new Error(`技能 ${id} 的启停与调用权限必须是布尔值`)
    }
    if (item.source !== undefined && (typeof item.source !== 'string' || item.source.length > 4096)) throw new Error(`技能 ${id} 的来源不合法`)
    const pathKey = process.platform === 'win32' ? item.path.toLowerCase() : item.path
    const linkKey = process.platform === 'win32' ? item.link.toLowerCase() : item.link
    if (paths.has(pathKey) || links.has(linkKey)) throw new Error(`技能 ${id} 的实体或链接路径重复`)
    paths.add(pathKey)
    links.add(linkKey)
    skills[id] = {
      path: item.path, link: item.link,
      enabled: item.enabled as boolean,
      modelInvocable: item.modelInvocable as boolean,
      userInvocable: item.userInvocable as boolean,
      ...(item.source !== undefined ? { source: item.source as string } : {}),
    }
  }
  return { dirs: stringList(data.dirs, 'dirs'), order: stringList(data.order, 'order'), rankBase, skills }
}

function configDocument(raw: string): Document {
  const doc = parseDocument(raw)
  if (doc.errors.length > 0) throw new Error(`技能配置不是合法 YAML：${doc.errors[0]?.message ?? '解析失败'}`)
  if (!isMap(doc.contents)) throw new Error('技能配置必须是 YAML 映射')
  visit(doc, { Alias() { throw new Error('技能配置不支持 YAML 别名') } })
  validateSkillsConfig(doc.toJS())
  return doc
}

export function readSkillsConfig(file: string = skillsConfigPath()): SkillsConfigRead {
  try {
    if (!existsSync(file)) return { ok: true, config: defaultSkillsConfig(), exists: false }
    return { ok: true, config: validateSkillsConfig(configDocument(readFileSync(file, 'utf8')).toJS()), exists: true }
  } catch (error) {
    return { ok: false, config: defaultSkillsConfig(), message: `读取技能配置失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 全量替换受管记录；逐节点更新保留注释、未知顶层字段与未知记录字段。 */
export function writeSkillsConfig(
  patch: Partial<SkillsConfig>,
  file: string = skillsConfigPath(),
  expectedContent?: string | null,
): SkillsConfigRead {
  let temporary: string | undefined
  try {
    const raw = existsSync(file) ? readFileSync(file, 'utf8') : null
    if (expectedContent !== undefined && raw !== expectedContent) throw new Error('技能配置内容版本冲突，请刷新后重试')
    const doc = raw === null ? new Document({ version: SKILLS_CONFIG_VERSION }) : configDocument(raw)
    const current = raw === null ? defaultSkillsConfig() : validateSkillsConfig(doc.toJS())
    const next = validateSkillsConfig({ ...current, ...patch })
    for (const key of ['dirs', 'order'] as const) {
      if (patch[key] === undefined) continue
      if (next[key].length === 0) doc.delete(key)
      else doc.set(key, next[key])
    }
    if (patch.rankBase !== undefined) {
      if (next.rankBase === DEFAULT_SKILL_RANK_BASE) doc.delete('rankBase')
      else doc.set('rankBase', next.rankBase)
    }
    if (patch.skills !== undefined) {
      if (!doc.has('skills')) doc.set('skills', doc.createNode({}))
      for (const id of Object.keys(current.skills)) if (!Object.hasOwn(next.skills, id)) doc.deleteIn(['skills', id])
      for (const [id, record] of Object.entries(next.skills)) {
        if (!doc.hasIn(['skills', id])) doc.setIn(['skills', id], doc.createNode({}))
        for (const key of ['path', 'link', 'enabled', 'modelInvocable', 'userInvocable', 'source'] as const) {
          if (record[key] === undefined) doc.deleteIn(['skills', id, key])
          else if (doc.getIn(['skills', id, key]) !== record[key]) doc.setIn(['skills', id, key], record[key])
        }
      }
    }
    const content = doc.toString()
    if (content !== raw) {
      mkdirSync(dirname(file), { recursive: true })
      temporary = `${file}.tmp-${randomUUID()}`
      writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' })
      if ((existsSync(file) ? readFileSync(file, 'utf8') : null) !== raw) throw new Error('技能配置内容版本冲突，请刷新后重试')
      renameSync(temporary, file)
      temporary = undefined
    }
    return { ok: true, config: next, exists: true }
  } catch (error) {
    return { ok: false, config: defaultSkillsConfig(), message: `写入技能配置失败：${error instanceof Error ? error.message : String(error)}` }
  } finally {
    if (temporary !== undefined && existsSync(temporary)) unlinkSync(temporary)
  }
}
