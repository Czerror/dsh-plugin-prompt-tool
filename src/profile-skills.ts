/** 技能实体由用户导入或手动更新；包内 skills 不再自动复制、升级或还原。 */
import { join } from 'node:path'
import { DSH_HOME } from './host/paths.ts'

/** 所有受管技能统一从 DSH_HOME/skills 暴露；包内资源只供显式导入。 */
export function resolveSkillsDir(_sourceDir: string, _warn: (message: string) => void): string {
  return join(DSH_HOME, 'skills')
}

