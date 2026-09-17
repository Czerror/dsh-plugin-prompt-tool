#!/usr/bin/env node
/** 一次性把 skills 根下的普通技能目录迁入 .system，并按受管状态建立启用链接；默认仅预览。
 *  迁移只保护用户原文件（备份 + 哈希回滚），不构成技能版本库。 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'

const SYSTEM = '.system'
const BACKUPS = '.skills-migration'
/** 旧技能管理配置（2026-09 布局）；根 config.yml 只作为更早布局的回退。 */
const LEGACY_CONFIG = join('.system', 'prompt-tool', 'config.yml')
const isSafe = (name) => typeof name === 'string' && name.length > 0 && !name.startsWith('.') && !/[\\/<>:"|?*]/u.test(name) && !/[. ]$/.test(name)
const hashFile = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const args = process.argv.slice(2)
const valueOf = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }
const root = resolve(valueOf('--root') ?? '')
const preview = !args.includes('--apply') && !args.includes('--rollback')
const rollbackFile = valueOf('--rollback')

/** 顶层普通技能包：非链接、非点目录且自带 SKILL.md。 */
function topSkills(skillsRoot) {
  if (!existsSync(skillsRoot)) return []
  return readdirSync(skillsRoot, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || entry.name.startsWith('.') || !isSafe(entry.name)) return []
    const path = join(skillsRoot, entry.name)
    if (lstatSync(path).isSymbolicLink()) return []
    return existsSync(join(path, 'SKILL.md')) ? [{ name: entry.name, path }] : []
  })
}

/** 包内嵌套技能（相对包目录的路径）：每个嵌套技能都需要自己的根链接，否则官方发现不到。 */
function nestedSkills(pkgDir, rel = '', out = []) {
  for (const entry of readdirSync(pkgDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || !isSafe(entry.name)) continue
    const path = join(pkgDir, entry.name)
    if (lstatSync(path).isSymbolicLink()) continue
    const next = rel.length === 0 ? entry.name : `${rel}/${entry.name}`
    if (existsSync(join(path, 'SKILL.md'))) out.push(next)
    nestedSkills(path, next, out)
  }
  return out
}

/** 旧配置（顺序 / rank 基数）；缺失或损坏时按空处理，不阻断迁移。 */
function oldConfig(skillsRoot) {
  const file = [join(skillsRoot, LEGACY_CONFIG), join(skillsRoot, 'config.yml')].find((candidate) => existsSync(candidate))
  if (file === undefined) return { order: [], rankBase: undefined }
  const doc = parseDocument(readFileSync(file, 'utf8'))
  if (doc.errors.length) throw new Error(`旧技能配置解析失败：${doc.errors[0].message}`)
  const data = doc.toJS() ?? {}
  return { order: Array.isArray(data.order) ? data.order.filter((item) => typeof item === 'string') : [], rankBase: Number.isSafeInteger(data.rankBase) ? data.rankBase : undefined }
}

export function planMigration(skillsRoot) {
  const rootPath = resolve(skillsRoot)
  const tops = topSkills(rootPath)
  const config = oldConfig(rootPath)
  const skills = []
  for (const top of tops) {
    skills.push({ id: top.name, path: top.name, link: top.name, top: top.name, hash: hashFile(join(top.path, 'SKILL.md')) })
    for (const nested of nestedSkills(top.path)) {
      // 链接名与导入路径同规则（嵌套用 -- 连接），避免与顶层技能同名冲突。
      skills.push({ id: `${top.name}/${nested}`, path: `${top.name}/${nested}`, link: `${top.name}--${nested.replaceAll('/', '--')}`, top: top.name, hash: hashFile(join(top.path, nested, 'SKILL.md')) })
    }
  }
  const ids = new Set(skills.map((skill) => skill.id))
  return {
    root: rootPath,
    system: join(rootPath, SYSTEM),
    tops: tops.map((top) => top.name),
    skills: skills.map(({ top, ...rest }) => rest),
    order: config.order.filter((id) => ids.has(id)),
    rankBase: config.rankBase,
  }
}

function writeConfig(system, plan) {
  const scalar = (value) => JSON.stringify(value)
  const records = plan.skills.map((skill) => `  ${scalar(skill.id)}:\n    path: ${scalar(skill.path)}\n    link: ${scalar(skill.link)}\n    enabled: true\n    modelInvocable: true\n    userInvocable: true\n    source: migration\n`).join('')
  const content = `version: 2\n${plan.order.length ? `order:\n${plan.order.map((id) => `  - ${scalar(id)}`).join('\n')}\n` : ''}${plan.rankBase === undefined ? '' : `rankBase: ${plan.rankBase}\n`}skills:\n${records}`
  writeFileSync(join(system, 'skills.yml'), content, { encoding: 'utf8', flag: 'wx' })
}

export function applyMigration(skillsRoot) {
  const plan = planMigration(skillsRoot)
  if (plan.tops.length === 0) throw new Error('未找到可迁移的普通技能目录')
  const system = plan.system
  if (existsSync(system) && lstatSync(system).isSymbolicLink()) throw new Error('目标 .system 不能是符号链接')
  mkdirSync(system, { recursive: true })
  if (existsSync(join(system, 'skills.yml'))) throw new Error('目标 skills.yml 已存在，拒绝覆盖')
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '')
  const backup = join(resolve(skillsRoot), BACKUPS, stamp)
  mkdirSync(backup, { recursive: true })
  const moved = []
  const links = []
  try {
    for (const name of plan.tops) {
      const source = join(resolve(skillsRoot), name)
      const target = join(system, name)
      if (existsSync(target)) throw new Error(`目标技能目录已存在：${name}`)
      const saved = join(backup, name)
      cpSync(source, saved, { recursive: true, errorOnExist: true })
      moved.push({ source, saved, target, hash: hashFile(join(source, 'SKILL.md')) })
      renameSync(source, target)
    }
    writeConfig(system, plan)
    // 官方 user-dsh 根跳过 .system；仅通过受管 junction 暴露启用技能（含嵌套子技能）。
    for (const skill of plan.skills) {
      const link = join(resolve(skillsRoot), skill.link)
      if (existsSync(link)) throw new Error(`技能链接目标已被占用：${link}`)
      symlinkSync(join(system, skill.path), link, 'junction')
      links.push({ path: link, target: skill.path })
    }
    const record = { version: 1, root: resolve(skillsRoot), backup, moved, links, createdConfig: join(system, 'skills.yml') }
    const recordFile = join(backup, 'migration.json')
    writeFileSync(recordFile, JSON.stringify(record, null, 2), { flag: 'wx' })
    return { ...plan, backup, record: recordFile, applied: true }
  } catch (error) {
    for (const link of [...links].reverse()) { try { if (existsSync(link.path) && lstatSync(link.path).isSymbolicLink()) unlinkSync(link.path) } catch { /* 保留现场供 --rollback */ } }
    for (const item of [...moved].reverse()) {
      try { if (existsSync(item.target) && !existsSync(item.source)) renameSync(item.target, item.source) } catch { /* 保留现场供 --rollback */ }
    }
    throw error
  }
}

export function rollbackMigration(recordFile) {
  const record = JSON.parse(readFileSync(resolve(recordFile), 'utf8'))
  if (!Array.isArray(record.moved) || typeof record.root !== 'string') throw new Error('迁移记录无效')
  const recorded = Array.isArray(record.links) ? record.links : record.moved.map((item) => ({ path: join(record.root, relative(record.root, item.source).split(sep).join('/')), target: undefined }))
  for (const link of [...recorded].reverse()) {
    try { if (existsSync(link.path) && lstatSync(link.path).isSymbolicLink()) unlinkSync(link.path) } catch { /* 链接已被外部改动时保留现场 */ }
  }
  for (const item of [...record.moved].reverse()) {
    if (!existsSync(item.target)) continue
    if (hashFile(join(item.target, 'SKILL.md')) !== item.hash) throw new Error(`内容哈希变化，拒绝回滚：${item.target}`)
    if (existsSync(item.source)) throw new Error(`原路径已被占用：${item.source}`)
    renameSync(item.target, item.source)
  }
  if (record.createdConfig && existsSync(record.createdConfig)) rmSync(record.createdConfig, { force: true })
  return { rolledBack: true, root: record.root }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    if (!valueOf('--root') && !rollbackFile) throw new Error('必须提供 --root <skills根>')
    if (rollbackFile) console.log(JSON.stringify(rollbackMigration(rollbackFile), null, 2))
    else if (preview) console.log(JSON.stringify({ ...planMigration(root), preview: true }, null, 2))
    else console.log(JSON.stringify(applyMigration(root), null, 2))
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
