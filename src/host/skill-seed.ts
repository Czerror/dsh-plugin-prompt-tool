/**
 * 内置技能种子化：把随包分发的 `skills/` 补建到用户技能根。
 *
 * 只补缺失项，已有目录的正文、资源与调用策略保持原样；没有删除墓碑，用户删掉的
 * 内置技能会在下次启动被补回。失败（包内无 `skills/`、目标不可写等）静默跳过，不阻断启动。
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { userSkillsDir } from './paths.ts'

/** 包根 `skills/` 目录：随包分发的**内置技能库**（目录形态与用户技能根同构）。兼容源码与打包运行。 */
export function packageSkillsDir(): string {
  const candidates = [
    new URL('../skills/', import.meta.url),
    new URL('../../skills/', import.meta.url),
  ]
  for (const candidate of candidates) {
    const dir = fileURLToPath(candidate)
    if (existsSync(dir)) return dir
  }
  throw new Error('prompt-tool: cannot locate package skills/ directory')
}

export function ensureSkillSeed(root = userSkillsDir()): { created: string[] } {
  const created: string[] = []
  try {
    mkdirSync(root, { recursive: true })
    for (const entry of readdirSync(packageSkillsDir(), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const target = join(root, entry.name)
      if (existsSync(target)) continue
      cpSync(join(packageSkillsDir(), entry.name), target, { recursive: true })
      created.push(entry.name)
    }
  } catch {
    // 种子化失败保持静默：技能是可选资产，缺它不影响插件主路径。
  }
  return { created }
}
