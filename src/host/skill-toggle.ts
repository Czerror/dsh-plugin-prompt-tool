/** 技能启停只对受管记录创建或取消根目录链接。 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { SKILL_MARKER } from '../shared/skills.ts'
import { isSafeSkillPath, readSkillsConfig } from './skills-config.ts'
import { updateSkillsLibrary } from './skills-library.ts'

export { SKILL_MARKER } from '../shared/skills.ts'

export type SkillToggleFailureCode = 'invalid-target' | 'not-found' | 'conflict' | 'io'

export type SkillToggleResult =
  | { ok: true; folder: string; enabled: boolean; changed: boolean; file: string }
  | { ok: false; code: SkillToggleFailureCode; message: string }

/** 按技能根与稳定身份定位；拒绝操作没有 YAML 所有权记录的技能。 */
export function setSkillEnabled(skillsDir: string, folder: string, enabled: boolean): SkillToggleResult {
  if (typeof skillsDir !== 'string' || skillsDir.trim().length === 0 || !isSafeSkillPath(folder) || typeof enabled !== 'boolean') {
    return { ok: false, code: 'invalid-target', message: '技能目录或技能名不合法' }
  }
  const read = readSkillsConfig(join(skillsDir, '.system', 'skills.yml'))
  if (!read.ok) return { ok: false, code: 'io', message: read.message }
  const record = read.config.skills[folder]
  if (record === undefined) return { ok: false, code: 'not-found', message: `未找到受管技能：${folder}` }
  const changed = record.enabled !== enabled || existsSync(join(skillsDir, record.link)) !== enabled
  const result = updateSkillsLibrary(skillsDir, (config) => {
    const current = config.skills[folder]
    if (current === undefined) throw new Error(`受管技能已移除：${folder}`)
    current.enabled = enabled
    return config
  })
  if (!result.ok) return { ok: false, code: /冲突|未受管/.test(result.message) ? 'conflict' : 'io', message: result.message }
  return { ok: true, folder, enabled, changed, file: join(skillsDir, '.system', record.path, SKILL_MARKER) }
}
