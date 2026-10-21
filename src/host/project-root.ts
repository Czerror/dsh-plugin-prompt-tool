/**
 * 宿主项目根判据：宿主只认 `.git`（引擎侧另认 .hg/.svn，两套 marker 不合并）。
 * 指令卡探测与技能扫描共用这一份判据，避免两个宿主消费者各自抄一份后漂移。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ancestorDirs, instructionPlan } from '../../engine/instruction-files.mjs'

const PROJECT_ROOT_MARKERS = ['.git']

/** 一次给出宿主项目根与目录链；marker 只取祖先链上的目录，无标记时根回落 cwd。 */
export function hostInstructionPlan(cwd: string): { root: string; dirs: string[] } {
  const dirs = ancestorDirs(cwd)
  const markerDirs = new Set(dirs.filter((dir) => PROJECT_ROOT_MARKERS.some((marker) => existsSync(join(dir, marker)))))
  return instructionPlan(cwd, markerDirs)
}
