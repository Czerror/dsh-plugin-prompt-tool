#!/usr/bin/env node
// migrate-skills.mjs — 离线一次性技能迁移（替代运行时自动兼容）。
//
// 处理对象（全部在 $DSH_HOME 下）：
//   1. 旧 per-profile 技能副本 `profiles/*/skills` → 技能根 `skills/`：只补缺失，
//      不覆盖已存在项；副本里的 `.prompt-tool-manifest.json`（旧账本）不搬。
//   2. `settings.yaml` 里 `prompt-tool` 段的旧技能键 → 技能管理配置 + 磁盘停用：
//        skillsDir / skillsDirs        → 附加技能根（废弃的 per-profile 路径直接丢弃）
//        skillOrder / skillRankBase    → 顺序 / rank 基数
//        skillSwitches[folder]=false   → 停用（SKILL.md → SKILL.md.disabled）
//      迁移后这些键从 settings.yaml 删除（技能管理不再写 settings，settings 只留部署轴）。
//   3. `--clean-legacy`：旧副本目录改名为 `skills.retired-<时间戳>`（可恢复，不删除）。
//
// 安全：`--dry-run` / `-n` 只报告不写盘；写盘前 settings.yaml 备份 `.bak-<时间戳>`；
// 幂等（可重复运行）；解析失败 fail loud，不动用户资产。
//
// 用法：node scripts/migrate-skills.mjs [--dry-run] [--clean-legacy] [--dsh-home <path>]
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { parseDocument, Document } from 'yaml'
import { resolveDshHomeArg } from './link-profile.mjs'

const ARGS = process.argv.slice(2)
const DRY_RUN = ARGS.includes('--dry-run') || ARGS.includes('-n')
const CLEAN_LEGACY = ARGS.includes('--clean-legacy')
const DSH_HOME = resolveDshHomeArg(ARGS)

const SKILLS_ROOT = join(DSH_HOME, 'skills')
const SKILLS_CONFIG_FILE = join(SKILLS_ROOT, '.system', 'prompt-tool', 'config.yml')
const SETTINGS_FILE = join(DSH_HOME, 'settings.yaml')
const PROFILES_DIR = join(DSH_HOME, 'profiles')
const NS = 'prompt-tool'

/** settings 里的旧技能管理键：迁移后全部删除。 */
const LEGACY_SKILL_KEYS = ['skillsDir', 'skillsDirs', 'skillSwitches', 'skillOrder', 'skillRankBase']
const DEFAULT_SKILL_RANK_BASE = 250
const SKILL_MARKER = 'SKILL.md'
const DISABLED_SUFFIX = '.disabled'

const STAMP = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 19)

/** 旧 per-profile 技能副本目录（`$DSH_HOME/profiles/<profile>/skills`）。 */
function legacySkillDirs() {
  if (!existsSync(PROFILES_DIR)) return []
  return readdirSync(PROFILES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(PROFILES_DIR, entry.name, 'skills'))
    .filter((dir) => existsSync(dir))
}

/** 废弃布局判定：`$DSH_HOME/profiles/**` 下的技能目录不再作为技能根。 */
function isDeprecatedProfileDir(dir) {
  const normalize = (value) => {
    const resolved = resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  const profiles = normalize(PROFILES_DIR)
  const resolved = normalize(dir)
  return resolved === profiles || resolved.startsWith(profiles + sep)
}

/** tmp + rename 原子写；写前可选备份原文件。 */
function writeFileAtomic(file, content, { backup = false } = {}) {
  mkdirSync(join(file, '..'), { recursive: true })
  if (backup && existsSync(file)) writeFileSync(`${file}.bak-${STAMP}`, readFileSync(file, 'utf8'), 'utf8')
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

/** 1) 搬运旧副本技能到技能根（只补缺失；跳过旧账本等点文件）。 */
function migrateLegacyCopies(legacyDirs) {
  let copied = 0
  let kept = 0
  for (const legacyDir of legacyDirs) {
    for (const entry of readdirSync(legacyDir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const target = join(SKILLS_ROOT, entry.name)
      if (existsSync(target)) {
        kept += 1
        continue
      }
      if (!DRY_RUN) {
        mkdirSync(SKILLS_ROOT, { recursive: true })
        cpSync(join(legacyDir, entry.name), target, { recursive: true })
      }
      copied += 1
    }
  }
  return { copied, kept }
}

/** 读取（或新建）技能管理配置文档：已存在的值不动，只补缺失项。 */
function readSkillsConfigDoc() {
  if (existsSync(SKILLS_CONFIG_FILE)) {
    const doc = parseDocument(readFileSync(SKILLS_CONFIG_FILE, 'utf8'))
    if (doc.errors.length > 0) throw new Error(`技能配置不是合法 YAML，已拒绝覆盖：${doc.errors[0].message}`)
    return doc
  }
  const doc = new Document({})
  doc.commentBefore = ' prompt-tool 技能管理配置（由 scripts/migrate-skills.mjs 从 settings.yaml 迁移）\n'
    + ' dirs: 附加技能根；order: 技能顺序；rankBase: 技能 rank 基数\n'
    + ' 技能启停不在这里：停用 = 技能目录里 SKILL.md 改名为 SKILL.md.disabled'
  doc.set('version', 1)
  return doc
}

/** 2) settings.yaml 旧技能键 → 配置 + 停用清单；返回待执行计划。 */
function planSettingsMigration() {
  if (!existsSync(SETTINGS_FILE)) return undefined
  const doc = parseDocument(readFileSync(SETTINGS_FILE, 'utf8'))
  if (doc.errors.length > 0) throw new Error(`settings.yaml 不是合法 YAML，已拒绝改写：${doc.errors[0].message}`)
  const parsed = doc.toJS() ?? {}
  const user = parsed[NS]
  if (user === undefined || user === null || typeof user !== 'object') return undefined

  const dirs = [
    ...(Array.isArray(user.skillsDirs) ? user.skillsDirs : []),
    ...(typeof user.skillsDir === 'string' ? [user.skillsDir] : []),
  ]
    .filter((dir) => typeof dir === 'string' && dir.trim().length > 0)
    .filter((dir) => !isDeprecatedProfileDir(dir))
  const order = Array.isArray(user.skillOrder)
    ? user.skillOrder.filter((folder) => typeof folder === 'string' && folder.length > 0)
    : []
  const rankBase = typeof user.skillRankBase === 'number' && Number.isSafeInteger(user.skillRankBase) && user.skillRankBase >= 0
    ? user.skillRankBase
    : undefined
  const disable = Object.entries(
    user.skillSwitches !== null && typeof user.skillSwitches === 'object' ? user.skillSwitches : {},
  ).filter(([, enabled]) => enabled === false).map(([folder]) => folder)
  const presentKeys = LEGACY_SKILL_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(user, key))
  return { doc, dirs, order, rankBase, disable, presentKeys }
}

/** 把迁移结果写进技能管理配置（已有值优先，避免覆盖手工编辑）。 */
function applyConfigMigration(plan) {
  if (plan === undefined) return { written: [], skipped: [] }
  const doc = readSkillsConfigDoc()
  const written = []
  const skipped = []
  const current = doc.toJS() ?? {}
  const fill = (key, value) => {
    if (value === undefined) return
    const empty = current[key] === undefined || (Array.isArray(current[key]) && current[key].length === 0)
    if (!empty) {
      skipped.push(key)
      return
    }
    doc.set(key, value)
    written.push(key)
  }
  fill('dirs', plan.dirs.length > 0 ? plan.dirs : undefined)
  fill('order', plan.order.length > 0 ? plan.order : undefined)
  if (plan.rankBase !== undefined && plan.rankBase !== DEFAULT_SKILL_RANK_BASE) fill('rankBase', plan.rankBase)
  if (!DRY_RUN && written.length > 0) {
    mkdirSync(join(SKILLS_CONFIG_FILE, '..'), { recursive: true })
    writeFileAtomic(SKILLS_CONFIG_FILE, doc.toString())
  }
  return { written, skipped }
}

/** 3) 停用：旧 settings 里 false 的技能 → 磁盘标记改名。 */
function applyDisable(disable) {
  const done = []
  const missing = []
  for (const folder of disable) {
    const active = join(SKILLS_ROOT, ...folder.split('/'), SKILL_MARKER)
    const parked = active + DISABLED_SUFFIX
    if (existsSync(active)) {
      if (!DRY_RUN) renameSync(active, parked)
      done.push(folder)
      continue
    }
    if (existsSync(parked)) {
      done.push(folder)
      continue
    }
    missing.push(folder)
  }
  return { done, missing }
}

/** 4) settings.yaml 删除旧技能键（保留注释、未知字段与其他段）。 */
function applySettingsCleanup(plan) {
  if (plan === undefined || plan.presentKeys.length === 0) return { removed: [] }
  for (const key of plan.presentKeys) plan.doc.deleteIn([NS, key])
  const remaining = (plan.doc.toJS() ?? {})[NS]
  if (remaining !== undefined && remaining !== null && typeof remaining === 'object' && Object.keys(remaining).length === 0) {
    plan.doc.deleteIn([NS])
  }
  if (!DRY_RUN) writeFileAtomic(SETTINGS_FILE, plan.doc.toString(), { backup: true })
  return { removed: plan.presentKeys }
}

/** 5) --clean-legacy：旧副本目录改名归档（可恢复，不删除）。 */
function cleanLegacy(legacyDirs) {
  const retired = []
  for (const dir of legacyDirs) {
    if (!existsSync(dir)) continue
    if (!DRY_RUN) renameSync(dir, `${dir}.retired-${STAMP}`)
    retired.push(dir)
  }
  return retired
}

const legacyDirs = legacySkillDirs()
const plan = planSettingsMigration()
const prefix = DRY_RUN ? '[dry-run] ' : ''

let failed = false
try {
  const copy = migrateLegacyCopies(legacyDirs)
  const config = applyConfigMigration(plan)
  const disabled = applyDisable(plan?.disable ?? [])
  const settings = applySettingsCleanup(plan)
  const retired = CLEAN_LEGACY ? cleanLegacy(legacyDirs) : []

  console.log(`${prefix}dsh-home: ${DSH_HOME}`)
  console.log(`${prefix}旧副本: ${legacyDirs.length} 个（${legacyDirs.map((dir) => dir.replace(DSH_HOME, '$DSH_HOME')).join(', ') || '无'}）`)
  console.log(`${prefix}搬运: 复制 ${copy.copied} 个技能，跳过已存在 ${copy.kept} 个 → ${SKILLS_ROOT}`)
  console.log(`${prefix}技能配置: 写入 ${config.written.join(', ') || '无'}；保留已有 ${config.skipped.join(', ') || '无'} → ${SKILLS_CONFIG_FILE}`)
  console.log(`${prefix}停用: ${disabled.done.join(', ') || '无'}${disabled.missing.length > 0 ? `；未找到（跳过）：${disabled.missing.join(', ')}` : ''}`)
  console.log(`${prefix}settings.yaml: 删除旧键 ${settings.removed.join(', ') || '无'}${plan !== undefined && settings.removed.length === 0 ? '（本次无）' : ''}`)
  if (CLEAN_LEGACY) console.log(`${prefix}归档旧副本: ${retired.join(', ') || '无'}`)
} catch (error) {
  failed = true
  console.error(`migrate-skills: ${error instanceof Error ? error.message : String(error)}`)
}

process.exit(failed ? 1 : 0)
