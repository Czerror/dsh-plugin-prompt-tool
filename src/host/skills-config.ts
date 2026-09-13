/**
 * 技能管理配置：技能管理状态从 settings.yaml 抽离后的唯一落点。
 *
 * 位置固定为默认技能根的 `.system` 区
 * （`<DSH_HOME>/skills/.system/prompt-tool/config.yml`）：官方
 * `dsh-skill-filesystem` 对用户根的 `.system` 段 `skipSystem`，本插件扫描也
 * 跳过点目录，因此它既在技能根里、又永远不会被当成技能（与
 * Fishquito7/dsh-skill-mcp-panel 把显示配置放 `.system/skill-viewer/` 同构）。
 *
 * 只承载"配置"（附加技能根 / 顺序 / rank 基数）：技能启停是磁盘事实
 * （SKILL.md ↔ SKILL.md.disabled），不在这里存开关，所以文件天然保持精简，
 * 手工编辑也即时生效。写入使用 yaml Document API 保留注释与未知字段，
 * 内容未变化时不落盘（避免 watcher 空转）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Document, parseDocument } from 'yaml'
import { DEFAULT_SKILL_RANK_BASE, DSH_HOME } from './paths.ts'

/** 相对 DSH_HOME 的配置文件位置。 */
export const SKILLS_CONFIG_RELATIVE = join('skills', '.system', 'prompt-tool', 'config.yml')

/** 配置文件当前格式版本。 */
export const SKILLS_CONFIG_VERSION = 1

export interface SkillsConfig {
  /** 附加技能根（空 = 只用默认根 `<DSH_HOME>/skills`）。 */
  dirs: string[]
  /** 技能展示顺序（目录相对路径；未列出的按名称排序）。 */
  order: string[]
  /** 技能候选排序基数。 */
  rankBase: number
}

export type SkillsConfigRead =
  | { ok: true; config: SkillsConfig; exists: boolean }
  | { ok: false; config: SkillsConfig; message: string }

/** 默认技能管理配置（文件缺失时使用）。 */
export function defaultSkillsConfig(): SkillsConfig {
  return { dirs: [], order: [], rankBase: DEFAULT_SKILL_RANK_BASE }
}

export function skillsConfigPath(dshHome: string = DSH_HOME): string {
  return join(dshHome, SKILLS_CONFIG_RELATIVE)
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
}

/**
 * 读取技能管理配置；文件缺失或字段非法时回退默认值。
 * YAML 损坏时 `ok: false`（调用方据此拒绝写入，避免覆盖用户手写的坏文件）。
 */
export function readSkillsConfig(file: string = skillsConfigPath()): SkillsConfigRead {
  if (!existsSync(file)) return { ok: true, config: defaultSkillsConfig(), exists: false }
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, config: defaultSkillsConfig(), message: `读取技能配置失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const doc = parseDocument(raw)
  if (doc.errors.length > 0) {
    return { ok: false, config: defaultSkillsConfig(), message: `技能配置不是合法 YAML：${doc.errors[0]?.message ?? '解析失败'}` }
  }
  const data = doc.toJS() as Record<string, unknown> | null
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, config: defaultSkillsConfig(), message: '技能配置必须是 YAML 映射' }
  }
  const rankBase = data.rankBase
  return {
    ok: true,
    exists: true,
    config: {
      dirs: asStringList(data.dirs),
      order: asStringList(data.order),
      rankBase: typeof rankBase === 'number' && Number.isSafeInteger(rankBase) && rankBase >= 0
        ? rankBase
        : DEFAULT_SKILL_RANK_BASE,
    },
  }
}

/** tmp + rename 原子写：失败保留原文件。 */
function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

/**
 * 局部更新技能管理配置（只写传入的键）。空数组/null 视为删除该键，
 * 让文件只保留有意义的行。文件不存在时按初始模板创建。
 */
export function writeSkillsConfig(
  patch: { dirs?: string[]; order?: string[]; rankBase?: number },
  file: string = skillsConfigPath(),
): SkillsConfigRead {
  let doc: Document
  if (existsSync(file)) {
    try {
      doc = parseDocument(readFileSync(file, 'utf8'))
    } catch (error) {
      return { ok: false, config: defaultSkillsConfig(), message: `读取技能配置失败：${error instanceof Error ? error.message : String(error)}` }
    }
    if (doc.errors.length > 0) {
      return { ok: false, config: defaultSkillsConfig(), message: `技能配置不是合法 YAML，已拒绝覆盖：${doc.errors[0]?.message ?? '解析失败'}` }
    }
  } else {
    doc = new Document({})
    doc.commentBefore = ' prompt-tool 技能管理配置（技能管理已从 settings.yaml 抽离）\n'
      + ' dirs: 附加技能根；order: 技能顺序；rankBase: 技能 rank 基数\n'
      + ' 技能启停不在这里：停用 = 技能目录里的 SKILL.md 改名为 SKILL.md.disabled'
    doc.set('version', SKILLS_CONFIG_VERSION)
  }

  const before = doc.toString()
  for (const key of ['dirs', 'order'] as const) {
    const value = patch[key]
    if (value === undefined) continue
    if (value.length === 0) doc.delete(key)
    else doc.set(key, value)
  }
  if (patch.rankBase !== undefined) {
    if (patch.rankBase === DEFAULT_SKILL_RANK_BASE) doc.delete('rankBase')
    else doc.set('rankBase', patch.rankBase)
  }
  if (doc.toString() === before) return readSkillsConfig(file)

  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileAtomic(file, doc.toString())
  } catch (error) {
    return { ok: false, config: defaultSkillsConfig(), message: `写入技能配置失败：${error instanceof Error ? error.message : String(error)}` }
  }
  return readSkillsConfig(file)
}
