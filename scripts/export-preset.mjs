#!/usr/bin/env node
/**
 * export-preset.mjs —— 导出预设（用户 ~/.dsh/presets/<id> 或包内 preset/<id>）到目标目录。
 *
 * 用法：
 *   node scripts/export-preset.mjs <预设id> [目标目录]
 *   DSH_HOME="D:\AI\DeepSeek harness\.dsh" node scripts/export-preset.mjs liangshen ./out
 *
 * 目标目录缺省为 ./preset-export-<id>；完整目录拷贝（preset.yml / agent.cordis.yml /
 * engine / .mjs 本地模块等），与导入功能（importPresetPackage）互为逆操作。
 * 查找顺序：插件用户预设 ~/.dsh/presets/<id> → 宿主预设 ~/.dsh/.agent-presets/<id>
 * → 包内 preset/<id>。
 */
import { cpSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const rootDir = fileURLToPath(new URL('..', import.meta.url))

/** 与官方 resolveDshHome 语义对齐：DSH_HOME（支持 ~ 展开）> 用户主目录下 .dsh。 */
function dshHome() {
  const ambient = process.env.DSH_HOME
  if (typeof ambient !== 'string' || ambient.trim().length === 0) return join(homedir(), '.dsh')
  const value = ambient.trim()
  const expanded = value === '~'
    ? homedir()
    : value.startsWith('~/') || value.startsWith('~\\')
      ? join(homedir(), value.slice(2))
      : value
  return resolve(expanded)
}

const id = process.argv[2]
if (id === undefined || id.length === 0) {
  console.error('用法: node scripts/export-preset.mjs <预设id> [目标目录]')
  process.exit(2)
}

const candidates = [
  join(dshHome(), 'presets', id),
  join(dshHome(), '.agent-presets', id),
  join(rootDir, 'preset', id),
]
const src = candidates.find((dir) => existsSync(join(dir, 'preset.yml')))
if (src === undefined) {
  console.error(`预设「${id}」不存在（已查：${candidates.join(' / ')}）`)
  process.exit(1)
}

const dest = resolve(process.argv[3] ?? join(process.cwd(), `preset-export-${id}`))
cpSync(src, dest, { recursive: true, force: true })
console.log(`已导出 ${src}\n  → ${dest}`)
