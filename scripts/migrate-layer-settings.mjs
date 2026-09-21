#!/usr/bin/env node
/** 一次性离线迁移 preset.yml；默认预览，--write 写入，--rollback --write 恢复。 */
import { createHash } from 'node:crypto'
import { accessSync, closeSync, constants, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const { migratePresetLayerSettings } = await import('../src/host/preset-layer-settings.ts')
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const BACKUP = '.layer-settings-backup.json'

function targetFile(target) {
  const path = resolve(target)
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(`不能迁移链接：${path}`)
  const file = stat.isDirectory() ? join(path, 'preset.yml') : path
  const fileStat = lstatSync(file)
  if (basename(file) !== 'preset.yml' || !fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error('迁移目标必须是普通 preset.yml 文件或其目录')
  const canonical = realpathSync(file)
  if (canonical.toLowerCase() !== file.toLowerCase()) throw new Error(`不能通过目录链接迁移预设：${file}`)
  return canonical
}

function replace(file, bytes, expected) {
  accessSync(file, constants.W_OK)
  const temporary = `${file}.layer-settings-${process.pid}.tmp`
  const fd = openSync(temporary, 'wx', lstatSync(file).mode)
  try {
    try { writeFileSync(fd, bytes) } finally { closeSync(fd) }
    if (sha(readFileSync(file)) !== expected) throw new Error(`预设在迁移期间被修改，已停止：${file}`)
    renameSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function migrateFile(target, { write = false, rollback = false } = {}) {
  const file = targetFile(target)
  const original = readFileSync(file)
  const beforeHash = sha(original)
  const backup = join(dirname(file), BACKUP)
  if (rollback) {
    if (!lstatSync(backup).isFile() || lstatSync(backup).isSymbolicLink()) throw new Error('迁移备份必须是普通文件')
    const record = JSON.parse(readFileSync(backup, 'utf8'))
    if (record.version !== 1 || record.file !== file || typeof record.original !== 'string') throw new Error('迁移备份不属于该预设或格式无效')
    const bytes = Buffer.from(record.original, 'base64')
    if (sha(bytes) !== record.beforeHash) throw new Error('迁移备份内容摘要不符')
    if (beforeHash !== record.afterHash && beforeHash !== record.beforeHash) throw new Error('预设在迁移后已被修改，拒绝覆盖；请先保留用户改动')
    if (write) {
      if (beforeHash !== record.beforeHash) replace(file, bytes, beforeHash)
      rmSync(backup)
    }
    return { file, mode: write ? 'restored' : 'rollback-preview', changed: beforeHash !== record.beforeHash }
  }
  const migrated = migratePresetLayerSettings(original.toString('utf8'))
  if (migrated.moved.length === 0) return { file, mode: 'unchanged', moved: [] }
  if (write) {
    const record = { version: 1, file, beforeHash, afterHash: sha(migrated.text), original: original.toString('base64') }
    // 隐藏备份不进入预设导出资产；wx 拒绝覆盖上次备份。
    writeFileSync(backup, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    try {
      replace(file, migrated.text, beforeHash)
    } catch (error) {
      rmSync(backup, { force: true })
      throw error
    }
  }
  return { file, mode: write ? 'migrated' : 'preview', moved: migrated.moved, ...(write ? { backup } : {}) }
}

function main(args) {
  const options = { write: false, rollback: false }
  const targets = []
  for (const arg of args) {
    if (arg === '--write') options.write = true
    else if (arg === '--dry-run') options.write = false
    else if (arg === '--rollback') options.rollback = true
    else if (arg.startsWith('--')) throw new Error(`未知选项：${arg}`)
    else targets.push(arg)
  }
  if (targets.length === 0) throw new Error('用法：node scripts/migrate-layer-settings.mjs <预设目录或 preset.yml> [...] [--write] [--rollback]')
  for (const target of targets) console.log(JSON.stringify(migrateFile(target, options)))
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)) } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
