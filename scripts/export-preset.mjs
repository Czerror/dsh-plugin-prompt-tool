#!/usr/bin/env node
/** 当前官方根、资源规则与 Web 共用；ZIP、定义与文件夹三种出口。 */
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DEFAULT_PRESET_DIR, exportPresetPackage, expandPresetSource } from '../lib/preset-transfer.mjs'

const id = process.argv[2]
if (id === undefined || id.length === 0) {
  console.error('用法: node scripts/export-preset.mjs <预设id> [目标.zip | 目标.yml | 新目录]')
  process.exit(2)
}

const dest = resolve(process.argv[3] ?? `${id}.zip`)
try {
  if (existsSync(dest)) throw new Error(`目标已存在，未覆盖：${dest}`)
  const definition = /\.ya?ml$/i.test(dest)
  const result = await exportPresetPackage(DEFAULT_PRESET_DIR, { id, mode: definition ? 'definition' : 'zip' })
  mkdirSync(dirname(dest), { recursive: true })
  if (definition || /\.zip$/i.test(dest)) {
    writeFileSync(dest, Buffer.from(result.content, result.encoding === 'base64' ? 'base64' : 'utf8'), { flag: 'wx' })
  } else {
    const files = await expandPresetSource([{ path: `${id}.zip`, encoding: 'base64', content: result.content }])
    const stage = mkdtempSync(join(dirname(dest), '.pt-export-'))
    try {
      for (const file of files) {
        const path = join(stage, file.path)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8'), { flag: 'wx' })
      }
      renameSync(stage, dest)
    } finally { rmSync(stage, { recursive: true, force: true }) }
  }
  console.log(`已导出 ${id} → ${dest}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
