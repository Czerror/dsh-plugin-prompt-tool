/** 受管技能库：YAML → 官方 frontmatter 与根目录链接，一次事务完成。 */
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isMap, parseDocument } from 'yaml'
import type { SkillEntry } from '../config.ts'
import type { ManagedSkillState } from '../shared/skills.ts'
import { readSkills, SKILL_NAME_RE } from '../runtime/skills-provider.ts'
import { defaultSkillsConfig, readSkillsConfig, validateSkillsConfig, writeSkillsConfig, type SkillsConfig, type SkillsConfigRead } from './skills-config.ts'

const driftWarnings = new Set<string>()
const pathKey = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

function stat(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** 不追随实体或管理目录上的 junction/symlink；授权只覆盖真实库内路径。 */
function assertDirectory(path: string): void {
  const info = stat(path)
  if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) throw new Error(`技能目录不是普通实体目录：${path}`)
}

function assertEntity(root: string, record: ManagedSkillState): string {
  let path = join(root, '.system')
  assertDirectory(path)
  for (const part of record.path.split('/')) {
    path = join(path, part)
    assertDirectory(path)
  }
  const marker = join(path, 'SKILL.md')
  const info = stat(marker)
  if (info === undefined || info.isSymbolicLink() || !info.isFile() || info.nlink > 1) throw new Error(`技能标记不是独立普通文件：${marker}`)
  return marker
}

function linkTarget(path: string): string | undefined {
  const info = stat(path)
  if (info === undefined) return undefined
  if (!info.isSymbolicLink()) throw new Error(`技能链接冲突，目标已被普通文件或目录占用：${path}`)
  return resolve(dirname(path), readlinkSync(path))
}

function matchesLink(path: string, target: string): boolean {
  try {
    const actual = linkTarget(path)
    return actual !== undefined && pathKey(actual) === pathKey(target)
  } catch { return false }
}

/** 只在同目录暂存后 rename；写前核对版本，失败时清理本次暂存文件。 */
function replaceFile(file: string, content: string, expected: string): void {
  const temporary = `${file}.tmp-${randomUUID()}`
  try {
    if (readFileSync(file, 'utf8') !== expected) throw new Error(`技能内容版本冲突：${file}`)
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' })
    if (readFileSync(file, 'utf8') !== expected) throw new Error(`技能内容版本冲突：${file}`)
    renameSync(temporary, file)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

/** 官方默认可调用；无差异时完全保留原文本，包括换行和未显式填写的默认值。 */
function policyText(raw: string, record: ManagedSkillState): string {
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : ''
  const source = bom.length > 0 ? raw.slice(1) : raw
  const match = /^---(\r?\n)([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)
  if (match === null) throw new Error('技能缺少完整 YAML frontmatter')
  const doc = parseDocument(match[2]!)
  if (doc.errors.length > 0) throw new Error(`技能 frontmatter 不是合法 YAML：${doc.errors[0]?.message ?? '解析失败'}`)
  if (!isMap(doc.contents)) throw new Error('技能 frontmatter 必须是 YAML 映射')
  const data = doc.toJS() as Record<string, unknown>
  if (typeof data.name !== 'string' || !SKILL_NAME_RE.test(data.name)) throw new Error('技能 frontmatter 的 name 必须是 kebab-case')
  if (typeof data.description !== 'string' || data.description.length === 0) throw new Error('技能 frontmatter 缺少 description')
  const disable = Object.hasOwn(data, 'disable-model-invocation') ? data['disable-model-invocation'] : data.disableModelInvocation
  const user = Object.hasOwn(data, 'user-invocable') ? data['user-invocable'] : data.userInvocable
  if (disable !== undefined && typeof disable !== 'boolean') throw new Error('disable-model-invocation 必须是布尔值')
  if (user !== undefined && typeof user !== 'boolean') throw new Error('user-invocable 必须是布尔值')
  if ((disable !== true) === record.modelInvocable && (user !== false) === record.userInvocable) return raw
  doc.set('disable-model-invocation', !record.modelInvocable)
  doc.set('user-invocable', record.userInvocable)
  const newline = match[1]!
  const yaml = doc.toString().replace(/\r?\n/g, newline)
  return `${bom}---${newline}${yaml}---${newline}${source.slice(match[0].length)}`
}

/** 跨进程互斥；无法证明已释放的锁不自动抢占。 */
export function withSkillsLibraryLock<T>(root: string, action: () => T): T {
  const absolute = resolve(root)
  assertDirectory(absolute)
  const system = join(absolute, '.system')
  if (stat(system) === undefined) mkdirSync(system)
  assertDirectory(system)
  const lock = join(system, '.skills.lock')
  const owner = `${process.pid}:${randomUUID()}`
  let descriptor: number
  try { descriptor = openSync(lock, 'wx') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('技能库正在被另一事务占用；确认没有活动事务后可清理 .system/.skills.lock')
    throw error
  }
  try {
    writeFileSync(descriptor, owner)
    closeSync(descriptor)
  } catch (error) {
    closeSync(descriptor)
    unlinkSync(lock)
    throw error
  }
  try { return action() } finally {
    if (stat(lock)?.isFile() && readFileSync(lock, 'utf8') === owner) unlinkSync(lock)
  }
}

function applySkillsLibrary(
  root: string,
  update: (current: SkillsConfig) => SkillsConfig,
  warn?: (message: string) => void,
  reconcile = false,
  options: { rollback?: () => void } = {},
): SkillsConfigRead {
  let current = defaultSkillsConfig()
  try {
    return withSkillsLibraryLock(root, () => {
      try {
      const file = join(root, '.system', 'skills.yml')
      const fileInfo = stat(file)
      if (fileInfo !== undefined && (fileInfo.isSymbolicLink() || !fileInfo.isFile() || fileInfo.nlink > 1)) throw new Error('技能配置必须是独立普通文件')
      const read = readSkillsConfig(file)
      if (!read.ok) return read
      current = read.config
      const before = fileInfo === undefined ? null : readFileSync(file, 'utf8')
      // 受管库只拥有实体、链接、顺序与 rank：外部目录不再作为第二发现根，dirs 一律清空。
      const next = validateSkillsConfig({ ...update(structuredClone(current)), dirs: [] })
      const previousLinks = new Map(Object.values(current.skills).map((record) =>
        [pathKey(join(root, record.link)), join(root, '.system', record.path)]))
      const nextLinks = new Map(Object.values(next.skills).map((record) =>
        [pathKey(join(root, record.link)), join(root, '.system', record.path)]))
      const desiredLinks = new Map(Object.values(next.skills).filter((record) => record.enabled).map((record) =>
        [pathKey(join(root, record.link)), join(root, '.system', record.path)]))
      const observedLinks = new Map<string, string>()
      const writes: Array<{ id: string; file: string; before: string; after: string; drift: boolean }> = []
      const invalid: Array<{ id: string; issue: string }> = []

      // 先检查整批实体、链接和 frontmatter，任何一项冲突都不产生部分修改。
      for (const path of new Set([...previousLinks.keys(), ...nextLinks.keys()])) {
        const target = linkTarget(path)
        if (target === undefined) continue
        const owned = previousLinks.get(path)
        if (owned === undefined || pathKey(target) !== pathKey(owned)) throw new Error(`技能链接冲突，拒绝修改未受管或目标不匹配的链接：${path}`)
        observedLinks.set(path, target)
      }
      for (const [id, record] of Object.entries(next.skills)) {
        try {
          const marker = assertEntity(root, record)
          const raw = readFileSync(marker, 'utf8')
          const content = policyText(raw, record)
          if (content !== raw) {
            const prior = current.skills[id]
            writes.push({ id, file: marker, before: raw, after: content, drift: prior !== undefined
              && prior.modelInvocable === record.modelInvocable && prior.userInvocable === record.userInvocable })
          }
        } catch (error) {
          const issue = `技能 ${id} 无效：${errorText(error)}`
          if (!reconcile) throw new Error(issue)
          invalid.push({ id, issue })
          desiredLinks.delete(pathKey(join(root, record.link)))
        }
      }
      if ((existsSync(file) ? readFileSync(file, 'utf8') : null) !== before) throw new Error('技能配置内容版本冲突，请刷新后重试')
      const undo: Array<() => void> = []
      try {
        for (const item of writes) {
          replaceFile(item.file, item.after, item.before)
          undo.push(() => replaceFile(item.file, item.before, item.after))
        }
        for (const [path, target] of observedLinks) {
          const desired = desiredLinks.get(path)
          if (desired !== undefined && pathKey(desired) === pathKey(target)) continue
          if (!matchesLink(path, target)) throw new Error(`技能链接版本冲突：${path}`)
          unlinkSync(path)
          undo.push(() => {
            if (stat(path) !== undefined) throw new Error(`回滚链接已被占用：${path}`)
            symlinkSync(target, path, 'junction')
          })
        }
        for (const [path, target] of desiredLinks) {
          if (matchesLink(path, target)) continue
          if (stat(path) !== undefined) throw new Error(`技能链接版本冲突：${path}`)
          symlinkSync(target, path, 'junction')
          undo.push(() => {
            if (!matchesLink(path, target)) throw new Error(`回滚链接目标发生变化：${path}`)
            unlinkSync(path)
          })
        }
        const result = writeSkillsConfig(next, file, before)
        if (!result.ok) throw new Error(result.message)
        for (const item of invalid) {
          const warningKey = `${pathKey(root)}:${item.id}:${item.issue}`
          if (warn !== undefined && !driftWarnings.has(warningKey)) {
            driftWarnings.add(warningKey)
            try { warn(`${item.issue}；已隔离其受管链接，修复实体后将恢复 YAML 状态`) } catch { /* 日志失败不撤销已提交事务。 */ }
          }
        }
        for (const item of writes) {
          const warningKey = `${pathKey(root)}:${item.id}`
          if (item.drift && warn !== undefined && !driftWarnings.has(warningKey)) {
            driftWarnings.add(warningKey)
            try { warn(`技能 ${item.id} 的 frontmatter 调用权限与 skills.yml 不一致，已按 YAML 恢复`) } catch { /* 日志失败不撤销已提交事务。 */ }
          }
        }
        return result
      } catch (error) {
        const failures: string[] = []
        for (const revert of undo.reverse()) {
          try { revert() } catch (rollbackError) { failures.push(errorText(rollbackError)) }
        }
        throw new Error(`${errorText(error)}${failures.length === 0 ? '' : `；回滚未完成：${failures.join('；')}`}`)
      }
      } catch (error) {
        try { options.rollback?.() } catch (rollbackError) {
          throw new Error(`${errorText(error)}；实体恢复失败：${errorText(rollbackError)}`)
        }
        throw error
      }
    })
  } catch (error) {
    return { ok: false, config: current, message: `更新技能库失败：${errorText(error)}` }
  }
}

export function updateSkillsLibrary(
  root: string,
  update: (current: SkillsConfig) => SkillsConfig,
  warn?: (message: string) => void,
  options?: { rollback?: () => void },
): SkillsConfigRead {
  return applySkillsLibrary(root, update, warn, false, options)
}

export function reconcileSkillsLibrary(root: string, warn?: (message: string) => void): SkillsConfigRead {
  return applySkillsLibrary(root, (config) => config, warn, true)
}

/** 受管身份以 YAML 键为准；实体和有效链接缺失均不能注册给模型。 */
export function readManagedSkills(root: string): SkillEntry[] {
  const read = readSkillsConfig(join(root, '.system', 'skills.yml'))
  if (!read.ok || !read.exists) return []
  const scanned = new Map(readSkills(join(root, '.system')).map((entry) => [pathKey(entry.file), entry]))
  const idsByPath = new Map(Object.entries(read.config.skills).map(([id, record]) => [pathKey(join(root, '.system', record.path)), id]))
  return Object.entries(read.config.skills).map(([id, record]) => {
    const entityPath = join(root, '.system', record.path)
    const file = join(entityPath, 'SKILL.md')
    const entry = scanned.get(pathKey(file))
    let issue: string | undefined
    try {
      assertEntity(root, record)
      policyText(readFileSync(file, 'utf8'), record)
    } catch (error) {
      issue = errorText(error)
    }
    const segments = record.path.split('/')
    let parentId: string | undefined
    while (segments.length > 1 && parentId === undefined) {
      segments.pop()
      parentId = idsByPath.get(pathKey(join(root, '.system', ...segments)))
    }
    const linkPath = join(root, record.link)
    const linked = matchesLink(linkPath, entityPath)
    return {
      ...(entry ?? { name: id.split('/').at(-1) ?? id, description: '', body: '', valid: false,
        issue: '受管技能实体缺失、不可读或路径不安全' }),
      ...(issue === undefined ? {} : { valid: false, issue }),
      id, folder: id, dir: root, file, entityPath, linkPath, source: record.source, managed: true, parentId,
      linked,
      ...(!record.enabled || !linked || entry === undefined || issue !== undefined ? { disabled: true } : { disabled: undefined }),
      modelInvocable: entry?.valid === true && issue === undefined && record.modelInvocable,
      userInvocable: entry?.valid === true && issue === undefined && record.userInvocable,
    }
  })
}
